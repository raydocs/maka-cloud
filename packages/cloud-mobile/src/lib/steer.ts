import {
  ApiError,
  type CloudClient,
  type ErrorText,
  errorText,
  randomId,
  type RunTimeline,
  TERMINAL,
  type TaskMessageState,
  type TaskView,
} from '@maka-cloud/client';
import { useSyncExternalStore } from 'react';

/**
 * A message the person sent to a running task (a "steer"), not to the conversation. The server
 * keeps it by `id`: sending the same id and words again changes nothing and answers where it
 * stands, which is how the phone checks on it.
 */
export interface Steer {
  id: string;
  taskId: string;
  text: string;
  /** When it was sent, by this phone's clock: where it sits in the chat. */
  at: number;
  /** Where the server last said it stands; absent until the server has answered once. */
  server?: TaskMessageState;
  /** A request about it is on its way. */
  request?: 'send' | 'check' | 'withdraw';
  /** The last send or take-back failed: the client's sentence for why, or the limit that refused it. */
  failed?: ErrorText;
  /** The task ended while the server still said "pending": what the task's log says happened. */
  settled?: 'read' | 'unread' | 'unknown';
}

/**
 * Where a steer stands, as far as the data says:
 * - `sent`: on its way, the server has not answered yet;
 * - `failed`: the server could not be reached or refused it; it can be sent again as the same message;
 * - `received`: the server has it and the task is running: the agent reads it after the step under way;
 * - `queued`: the server has it but the task is paused or not started: it waits for the next turn;
 * - `applying`: the agent has it, and the task is still working;
 * - `read`: the agent had it, and the task has ended or is not running;
 * - `withdrawn`: taken back before the agent read it;
 * - `unread`: the task ended before the agent read it;
 * - `unknown`: the task ended and its log cannot tell this message from others.
 */
export type SteerPhase =
  | 'sent'
  | 'failed'
  | 'received'
  | 'queued'
  | 'applying'
  | 'read'
  | 'withdrawn'
  | 'unread'
  | 'unknown';

export function steerPhase(steer: Steer, task: TaskView | undefined): SteerPhase {
  if (steer.server === undefined) return steer.request === 'send' ? 'sent' : 'failed';
  const ended = task !== undefined && TERMINAL.has(task.state);
  switch (steer.server) {
    case 'withdrawn':
      return 'withdrawn';
    case 'unseen':
      return 'unread';
    case 'delivered':
      // Working it in only while the task runs; paused or not started, all we know is it was read.
      return !ended && task?.state === 'running' ? 'applying' : 'read';
    case 'pending':
      if (!ended) return task === undefined || task.state === 'running' ? 'received' : 'queued';
      return steer.settled ?? 'unknown';
  }
}

/** The server's limit on one message to a running task (`MAX_STEER_CHARS` in cloud-orchestrator). */
export const STEER_MAX_CHARS = 4_000;

/** Only a message the server holds and the agent has not read can be taken back. */
export const withdrawable = (phase: SteerPhase) => phase === 'received' || phase === 'queued';

/** Still moving: worth a line by the composer and a check now and then. */
export const unsettled = (phase: SteerPhase) =>
  phase === 'sent' || phase === 'received' || phase === 'queued';

/**
 * What a task's log says of a message still pending when the task ended. The server marks every
 * message the agent never read as unseen before it records the end. With none read, this one was
 * not read. With none unseen and none taken back, it was. A take-back whose answer never reached
 * the phone counts as withdrawn, so with any withdrawn the counts cannot place this one.
 */
export function settledFrom(messages: RunTimeline['messages']): 'read' | 'unread' | 'unknown' {
  if (messages.read === 0) return 'unread';
  if (messages.unseen === 0 && messages.withdrawn === 0) return 'read';
  return 'unknown';
}

/** The task to steer: a top-level task still going, the running one first, then the newest. */
export function steerTarget(roots: readonly TaskView[]): TaskView | undefined {
  const going = roots.filter((task) => !TERMINAL.has(task.state) && !task.cancelRequested);
  const rank = (task: TaskView) => (task.state === 'running' ? 1 : 0);
  return [...going].sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt)[0];
}

/** Why the server would not take a message for this task at all: the words go back to the box. */
export function refused(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === 'steer_unsupported' || error.code === 'invalid_state')
  );
}

type Listener = () => void;

/**
 * The steers of one conversation, kept for as long as the app runs, so leaving and coming back
 * shows them again with where they stand.
 */
class SteerBook {
  private list: Steer[] = [];
  private readonly listeners = new Set<Listener>();
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.list;
  set(list: Steer[]) {
    this.list = list;
    for (const listener of this.listeners) listener();
  }
  change(id: string, change: (steer: Steer) => Steer) {
    this.set(this.list.map((steer) => (steer.id === id ? change(steer) : steer)));
  }
  find(id: string) {
    return this.list.find((steer) => steer.id === id);
  }
}

const books = new Map<string, SteerBook>();
const bookOf = (conversationId: string) => {
  let book = books.get(conversationId);
  if (!book) books.set(conversationId, (book = new SteerBook()));
  return book;
};

/**
 * Until when checks stay quiet: the server said the controls were asked too often, and Stop and
 * Take back share that budget, so they get it first.
 */
let quietUntil = 0;

/** For tests: every conversation starts with no steers. */
export function forgetSteers() {
  books.clear();
  quietUntil = 0;
}

const answered = (state: TaskMessageState) => (steer: Steer) => {
  const { failed: _failed, request: _request, ...rest } = steer;
  return { ...rest, server: state };
};
const failedWith = (error: unknown) => (steer: Steer) => {
  const { request: _request, ...rest } = steer;
  return { ...rest, failed: errorText(error) };
};

/**
 * The steers of a conversation and what can be done with them. `send` resolves `false` when the
 * server refused the message for this task outright (it cannot take messages, or it is ending);
 * the steer is then dropped, and the caller gives the words back.
 */
export function useSteers(client: CloudClient, conversationId: string) {
  const book = bookOf(conversationId);
  const steers = useSyncExternalStore(book.subscribe, book.getSnapshot);
  /**
   * Sends a steer. Only a first send that is refused outright drops it (its words go back to the
   * box); a refused resend stays, failed, with "Delete", so its words are never lost.
   */
  const post = (id: string, first: boolean): Promise<boolean> => {
    const steer = book.find(id);
    if (!steer) return Promise.resolve(true);
    book.change(id, (s) => {
      const { failed: _failed, ...rest } = s;
      return { ...rest, request: 'send' };
    });
    return client.sendTaskMessage(steer.taskId, steer.text, steer.id).then(
      ({ message }) => {
        book.change(id, answered(message.state));
        return true;
      },
      (error: unknown) => {
        if (first && refused(error) && book.find(id)?.server === undefined) {
          book.set(book.getSnapshot().filter((s) => s.id !== id));
          return false;
        }
        book.change(id, failedWith(error));
        return true;
      },
    );
  };
  /** Asks the server where it stands, by sending it again unchanged. */
  const check = (id: string) => {
    const steer = book.find(id);
    if (!steer || steer.request || Date.now() < quietUntil) return;
    book.change(id, (s) => ({ ...s, request: 'check' }));
    client.sendTaskMessage(steer.taskId, steer.text, steer.id).then(
      ({ message }) => book.change(id, answered(message.state)),
      // A check that fails changes nothing the person sees: the last answer still stands.
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 429) quietUntil = Date.now() + 60_000;
        book.change(id, (s) => {
          const { request: _request, ...rest } = s;
          return rest;
        });
      },
    );
  };
  return {
    steers,
    send(taskId: string, text: string, now = Date.now()) {
      const id = randomId();
      book.set([...book.getSnapshot(), { id, taskId, text, at: now }]);
      return post(id, true);
    },
    /** The same message again, with the same id: the server applies it once. */
    resend: (id: string) => void post(id, false),
    /** A message that never reached the server is dropped from the phone. */
    discard(id: string) {
      book.set(book.getSnapshot().filter((steer) => steer.id !== id));
    },
    check,
    withdraw(id: string) {
      const steer = book.find(id);
      if (!steer || steer.request) return;
      book.change(id, (s) => {
        const { failed: _failed, ...rest } = s;
        return { ...rest, request: 'withdraw' };
      });
      client.withdrawTaskMessage(steer.taskId, steer.id).then(
        ({ message }) => book.change(id, answered(message.state)),
        (error: unknown) => {
          // Any failure leaves it where it stood, with the reason. A 409 means it is no longer
          // pending (read, or unseen because the task ended): ask the server which.
          book.change(id, failedWith(error));
          if (error instanceof ApiError && error.status === 409) check(id);
        },
      );
    },
    /** The task ended with this message pending: its log says whether it was read. */
    settle(id: string) {
      const steer = book.find(id);
      if (!steer || steer.settled || steer.request) return;
      book.change(id, (s) => ({ ...s, request: 'check' }));
      client.timeline(steer.taskId, { limit: 1 }).then(
        ({ timeline }) =>
          book.change(id, (s) => {
            const { request: _request, ...rest } = s;
            return { ...rest, settled: settledFrom(timeline.messages) };
          }),
        () =>
          book.change(id, (s) => {
            const { request: _request, ...rest } = s;
            return { ...rest, settled: 'unknown' };
          }),
      );
    },
  };
}
