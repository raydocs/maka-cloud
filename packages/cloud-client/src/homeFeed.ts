import type { CloudClient } from './client';
import { Unsupported } from './client';
import type { Conversation, HomeCard, InboxItem, ProjectView, TaskView } from './contract';
import { type ErrorText, errorText } from './errors';
import { DAY_MS } from './home';
import { inboxAnswerer } from './inboxAnswer';
import { mergeInboxItem } from './state';
import { Store } from './store';

export const RECENT_CONVERSATIONS = 5;
/** The most card ids `POST /v1/home/seen` takes at once. */
export const HOME_SEEN_MAX = 100;

/** The newest conversations first: what Home lists and reads results from. */
export function recentConversations(conversations: readonly Conversation[]): Conversation[] {
  return [...conversations].reverse().slice(0, RECENT_CONVERSATIONS);
}

/**
 * Where a device remembers when this invite last looked at Home. Never the token. The key is the
 * invite's fingerprint. A store that cannot be read or written means every visit is a first one.
 */
export interface VisitStore {
  read(fingerprint: string): number | undefined | Promise<number | undefined>;
  write(fingerprint: string, at: number): void | Promise<void>;
}

export interface HomeSnapshot {
  /** Every inbox item seen, by id; the highest version wins. */
  items: Record<string, InboxItem>;
  busy: boolean;
  /** False until the first read of the open decisions has finished, so "nothing waits" is never a guess. */
  inboxLoaded: boolean;
  /** The last read of the open decisions failed. */
  inboxFailed: boolean;
  answerError: ErrorText;
  /** When the person last looked, or a day ago on a first visit; unknown until read. */
  since: number | undefined;
  /** Top-level and sub tasks of the recent conversations, by conversation; unknown until read. */
  done: ReadonlyMap<string, readonly TaskView[]> | undefined;
  /** The projects and their duties; empty when the server has none; unknown until read. */
  projects: ProjectView[] | undefined;
  /**
   * The server's own Home: its cards in its order, with what this owner has seen. Undefined until
   * read, and for good on a server without `/v1/home`, where Home is built from the parts above.
   */
  cards: HomeCard[] | undefined;
}

/**
 * What Home shows: the decisions waiting, what was done since the last visit and what runs next.
 * Each part fills in as its data arrives, and stays out of the way when the server has nothing or no
 * such feature. `refresh` reads decisions, results and schedule again (the person came back).
 */
export class HomeFeed extends Store<HomeSnapshot> {
  private generation = 0;
  private doneSeq = 0;
  private projectsSeq = 0;
  private recentIds = '';
  private fingerprint: string | undefined;
  private pending = false;
  /** This visit was already told; a second leave before the next read tells nothing. */
  private left = false;
  private readonly answerItem: ReturnType<typeof inboxAnswerer>;

  constructor(
    private readonly client: CloudClient,
    private readonly visits: VisitStore,
    private readonly now: () => number = Date.now,
  ) {
    super({
      items: {},
      busy: false,
      inboxLoaded: false,
      inboxFailed: false,
      answerError: '',
      since: undefined,
      done: undefined,
      projects: undefined,
      cards: undefined,
    });
    this.answerItem = inboxAnswerer(client, (item) =>
      this.update((s) => {
        const items = mergeInboxItem(s.items, item);
        return items === s.items ? s : { ...s, items };
      }),
    );
  }

  /** Reads everything once. The last visit is read now and written by `stop`, so a reload is a visit. */
  start(conversations: readonly Conversation[]): void {
    const generation = ++this.generation;
    this.recentIds = idsOf(conversations);
    const current = () => generation === this.generation;
    this.client
      .fingerprint()
      .then(async (print) => {
        const at = await this.visits.read(print);
        if (!current()) return;
        this.fingerprint = print;
        this.patch({ since: at ?? this.now() - DAY_MS });
      })
      .catch(() => current() && this.patch({ since: this.now() - DAY_MS }));
    this.load(generation);
  }

  /** The list of conversations changed: the results are read again when the recent ones did. */
  conversationsChanged(conversations: readonly Conversation[]): void {
    const ids = idsOf(conversations);
    if (ids === this.recentIds) return;
    this.recentIds = ids;
    this.loadDone(this.generation);
  }

  /** Decisions, results and schedule are read again. */
  refresh(): void {
    this.load(this.generation);
  }

  /**
   * Remembers this visit. Called when the person leaves (a page hide, a screen going away). The
   * server is told too, with the cards that were shown, so the next device agrees on what is new.
   * `shown` names the cards the screen showed (in its order); without it, every card counts. A
   * visit is told once: leaving again before Home is read again does nothing.
   */
  leave(shown?: readonly string[]): void {
    if (this.left) return;
    this.left = true;
    if (this.fingerprint !== undefined) void this.visits.write(this.fingerprint, this.now());
    const cards = this.getSnapshot().cards;
    if (cards !== undefined) {
      const ids = shown ?? cards.map((card) => card.cardId);
      void this.client.homeSeen(ids.slice(0, HOME_SEEN_MAX)).catch(() => undefined);
    }
  }

  /** Moves a card to just after `after` (first when null) inside its kind. Home keeps the server's answer. */
  async moveCard(cardId: string, after: string | null): Promise<void> {
    try {
      this.patch({ cards: await this.client.moveHomeCard(cardId, after) });
    } catch (e) {
      this.patch({ answerError: errorText(e) });
    }
  }

  stop(shown?: readonly string[]): void {
    this.leave(shown);
    this.generation += 1;
  }

  private load(generation: number): void {
    this.left = false;
    const current = () => generation === this.generation;
    this.client
      .listInbox('open')
      .then((list) => {
        if (!current()) return;
        this.update((s) => {
          const items = list.reduce((all, item) => mergeInboxItem(all, item), s.items);
          return items === s.items && s.inboxLoaded && !s.inboxFailed
            ? s
            : { ...s, items, inboxLoaded: true, inboxFailed: false };
        });
      })
      // A failed read is not "nothing waits": it is told apart, so a screen never says all is clear.
      .catch(() => current() && this.patch({ inboxFailed: true }));
    // The server's Home, where it has one. A server without it stays on the parts below.
    this.client
      .home()
      .then((cards) => current() && this.patch({ cards }))
      .catch(() => undefined);
    const seq = ++this.projectsSeq;
    const latest = () => current() && seq === this.projectsSeq;
    this.client
      .listProjects()
      .then((list) => latest() && this.patch({ projects: list }))
      .catch((error: unknown) => {
        if (latest() && !(error instanceof Unsupported)) this.patch({ projects: [] });
      });
    this.loadDone(generation);
  }

  private loadDone(generation: number): void {
    const ids = this.recentIds === '' ? [] : this.recentIds.split('\u0000');
    const seq = ++this.doneSeq;
    Promise.all(
      ids.map((id) =>
        this.client
          .listTasks(id)
          .then((tasks) => [id, tasks] as const)
          // A read that failed keeps what was last read, so a blip does not empty Home.
          .catch(() => [id, this.getSnapshot().done?.get(id) ?? ([] as TaskView[])] as const),
      ),
    ).then(
      (pairs) =>
        generation === this.generation &&
        seq === this.doneSeq &&
        this.patch({ done: new Map(pairs) }),
    );
  }

  /** Answers a card once; a second tap while one is in flight does nothing. */
  async answer(item: InboxItem, optionId: string, text?: string): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    this.patch({ busy: true, answerError: '' });
    try {
      await this.answerItem(item, optionId, text);
    } catch (e) {
      this.patch({ answerError: errorText(e) });
    } finally {
      this.pending = false;
      this.patch({ busy: false });
    }
  }
}

function idsOf(conversations: readonly Conversation[]): string {
  return recentConversations(conversations)
    .map((c) => c.conversationId)
    .join('\u0000');
}
