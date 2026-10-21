import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ConversationView, Picture, QuestionCard } from '../src/App';
import {
  CloudClient,
  type Conversation,
  type InboxItem,
  type Question,
  type TaskView,
} from '@maka-cloud/client';
import { Computer } from '../src/Computer';
import { InboxCard, InboxPanel } from '../src/Inbox';

afterEach(cleanup);

const conversation: Conversation = { conversationId: 'cnv_1', title: 'Launch', createdAt: 0 };
const question: Question = {
  questionId: 'q1',
  reason: 'taste',
  question: 'Which direction feels right?',
  // Deliberately unsorted: the card puts the recommendation first.
  options: [
    { id: 'bold', label: 'A bold launch' },
    { id: 'quiet', label: 'A quieter launch' },
  ],
  recommended: 'quiet',
};

test('recommendation is first; keyboard can pick another answer and add context', () => {
  const answers: unknown[] = [];
  render(
    <QuestionCard
      question={question}
      disabled={false}
      onAnswer={(optionId, text) => answers.push({ optionId, text })}
    />,
  );
  const options = screen.getAllByRole('option');
  expect(options[0].textContent).toContain('A quieter launch');
  expect(options[0].textContent).toContain('Recommended');
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  fireEvent.change(screen.getByLabelText('Additional context (optional)'), {
    target: { value: 'Keep it short' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(answers).toEqual([{ optionId: 'bold', text: 'Keep it short' }]);
});

test('an approval shows the held call and says what the user is approving', () => {
  render(
    <QuestionCard
      question={{
        ...question,
        reason: 'irreversible',
        note: 'It changes two files.',
        action: { tool: 'open_pull_request', args: { branch: 'fix-1' } },
      }}
      disabled={false}
      onAnswer={() => {}}
    />,
  );
  expect(screen.getByText('Needs your approval')).toBeTruthy();
  expect(screen.getByText('It changes two files.')).toBeTruthy();
  expect(screen.getByText('{"branch":"fix-1"}')).toBeTruthy();
});

const card =
  'Allow open_pull_request(taskId: "tsk_1", title: "Fix \uFF43odex login")? It cannot be undone.\n\nRepository: acme/codex-secrets';

test('an approval card is shown exactly as the approval binds it: no name filter, no normalising (T15)', () => {
  const answers: string[] = [];
  render(
    <QuestionCard
      question={{
        ...question,
        reason: 'irreversible',
        question: card,
        options: [
          { id: 'approve', label: 'Go ahead' },
          { id: 'reject', label: "Don't do it" },
        ],
        recommended: 'approve',
        action: {
          tool: 'open_pull_request',
          args: { taskId: 'tsk_1', title: 'Fix \uFF43odex login' },
        },
      }}
      disabled={false}
      onAnswer={(optionId) => answers.push(optionId)}
    />,
  );
  expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(card);
  expect(screen.getByText('{"taskId":"tsk_1","title":"Fix \uFF43odex login"}')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(answers).toEqual(['approve']);
});

test('an approval card holding a hidden character cannot be approved', () => {
  render(
    <QuestionCard
      question={{
        ...question,
        reason: 'irreversible',
        question: 'Allow post_comment(body: "ok \u202Etxt.terces")? It cannot be undone.',
        options: [
          { id: 'approve', label: 'Go ahead' },
          { id: 'reject', label: "Don't do it" },
        ],
        recommended: 'approve',
      }}
      disabled={false}
      onAnswer={() => {}}
    />,
  );
  const options = screen.getAllByRole('option');
  expect(options).toHaveLength(1);
  expect(options[0]?.textContent).toContain("Don't do it");
  expect(screen.getByText(/cannot be approved here/)).toBeTruthy();
});

test('an approval inbox item is shown exactly as the approval binds it, and only then can be approved (T15)', () => {
  const approvalItem: InboxItem = {
    ...item,
    kind: 'approval',
    ask: card,
    evidence: [
      { kind: 'action', tool: 'open_pull_request', args: '{"repo":"acme/codex-secrets"}' },
    ],
    options: [
      { id: 'reject', label: "Don't do it", recommended: true },
      { id: 'approve', label: 'Go ahead', recommended: false },
    ],
  };
  const { unmount } = render(
    <InboxCard item={approvalItem} disabled={false} onAnswer={() => {}} />,
  );
  expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(card);
  expect(screen.getByText('{"repo":"acme/codex-secrets"}')).toBeTruthy();
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
    "Don't do it",
    'Go ahead',
  ]);
  unmount();
  render(
    <InboxCard
      item={{ ...approvalItem, ask: 'Allow it?\u2066 It cannot be undone.' }}
      disabled={false}
      onAnswer={() => {}}
    />,
  );
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(["Don't do it"]);
});

type Frame = { id: number; kind: string; data: Record<string, unknown> };

/** A fetch that serves a fixed event replay and records the control calls. */
function fakeApi(
  frames: Frame[],
  respond: (path: string) => Response | undefined = () => undefined,
) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/v1/events')) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                frames
                  .map((f) => `id: ${f.id}\nevent: ${f.kind}\ndata: ${JSON.stringify(f.data)}\n\n`)
                  .join(''),
              ),
            );
            init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.includes('/tasks?')) return Response.json({ tasks: [] });
    return respond(path) ?? Response.json({}, { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const cnv = conversation.conversationId;
const created = (id: number, taskId: string, title: string, parent?: string): Frame => ({
  id,
  kind: 'task.event',
  data: {
    conversationId: cnv,
    seq: id,
    at: id,
    event: {
      type: 'task_created',
      taskId,
      sessionId: 's',
      title,
      mode: 'async',
      parentTaskId: parent,
    },
  },
});
const taskEvent = (id: number, event: Record<string, unknown>, extra = {}): Frame => ({
  id,
  kind: 'task.event',
  data: { conversationId: cnv, seq: id, at: id, event, ...extra },
});

test('controls follow the task state: pause and cancel while running, resume while paused, none after', async () => {
  const api = fakeApi([
    created(1, 't_run', 'Running job'),
    taskEvent(2, { type: 'task_started', taskId: 't_run' }),
    created(3, 't_paused', 'Paused job'),
    taskEvent(4, { type: 'task_started', taskId: 't_paused' }),
    taskEvent(5, { type: 'task_pause_requested', taskId: 't_paused', by: 's' }),
    taskEvent(6, { type: 'task_paused', taskId: 't_paused' }),
    created(7, 't_done', 'Done job'),
    taskEvent(8, { type: 'task_started', taskId: 't_done' }),
    taskEvent(9, { type: 'task_cancelled', taskId: 't_done' }),
  ]);
  render(
    <ConversationView client={new CloudClient('fake', api.fetcher)} conversation={conversation} />,
  );
  const running = await screen.findByRole('article', { name: 'Running job' });
  const paused = screen.getByRole('article', { name: 'Paused job' });
  const done = screen.getByRole('article', { name: 'Done job' });
  expect(within(running).getByText('In progress')).toBeTruthy();
  expect(within(running).getByRole('button', { name: 'Pause task' })).toBeTruthy();
  expect(within(running).getByRole('button', { name: 'Cancel task' })).toBeTruthy();
  expect(within(paused).getByText('Paused')).toBeTruthy();
  expect(within(paused).getByRole('button', { name: 'Resume task' })).toBeTruthy();
  expect(within(paused).queryByRole('button', { name: 'Pause task' })).toBeNull();
  expect(within(done).getByText('Cancelled')).toBeTruthy();
  expect(within(done).queryAllByRole('button')).toHaveLength(0);

  fireEvent.click(within(paused).getByRole('button', { name: 'Resume task' }));
  await waitFor(() => expect(api.calls).toContain('POST /v1/tasks/t_paused/resume'));
  // No local success: the task stays paused until the stream says otherwise.
  expect(within(paused).getByText('Paused')).toBeTruthy();
});

test('a refused pause says why and hides the pause button for that task only', async () => {
  const api = fakeApi(
    [
      created(1, 't1', 'First'),
      taskEvent(2, { type: 'task_started', taskId: 't1' }),
      created(3, 't2', 'Second'),
      taskEvent(4, { type: 'task_started', taskId: 't2' }),
    ],
    (path) =>
      path.endsWith('/t1/pause')
        ? Response.json({ error: 'pause_unsupported' }, { status: 409 })
        : undefined,
  );
  render(
    <ConversationView client={new CloudClient('fake', api.fetcher)} conversation={conversation} />,
  );
  const first = await screen.findByRole('article', { name: 'First' });
  fireEvent.click(within(first).getByRole('button', { name: 'Pause task' }));
  expect((await screen.findByRole('alert')).textContent).toBe('This task cannot be paused.');
  await waitFor(() =>
    expect(within(first).queryByRole('button', { name: 'Pause task' })).toBeNull(),
  );
  expect(
    within(screen.getByRole('article', { name: 'Second' })).getByRole('button', {
      name: 'Pause task',
    }),
  ).toBeTruthy();
});

test('cost is only what the server reported: absent stays "Not reported", a partial total says so', async () => {
  const api = fakeApi([
    created(1, 't1', 'Reported job'),
    created(2, 't2', 'Silent job'),
    created(3, 't_child', 'Subtask', 't1'),
    taskEvent(
      4,
      { type: 'task_cost', taskId: 't1', fromTaskId: 't_child', costUsd: 0.4 },
      { totalCostUsd: 0.4 },
    ),
  ]);
  render(
    <ConversationView client={new CloudClient('fake', api.fetcher)} conversation={conversation} />,
  );
  const reported = await screen.findByRole('article', { name: 'Reported job' });
  await waitFor(() => expect(within(reported).getByText(/Cost so far: \$0\.40/)).toBeTruthy());
  expect(
    within(screen.getByRole('article', { name: 'Silent job' })).getByText(/Not reported/),
  ).toBeTruthy();
  // A subtask has no cost of its own: the root's figure covers it.
  expect(
    within(screen.getByRole('article', { name: 'Subtask' })).queryByText(/Cost so far/),
  ).toBeNull();
  expect(screen.getByText('$0.40 (not all reported)')).toBeTruthy();
  expect(screen.queryByText('$0.00')).toBeNull();
});

test('all server text is presentation-filtered', async () => {
  const names = 'Claude, Codex, GPT, Anthropic, OpenAI';
  const api = fakeApi([
    {
      id: 1,
      kind: 'conductor.notice',
      data: { conversationId: cnv, noticeId: 'n1', text: names, at: 1 },
    },
    {
      id: 2,
      kind: 'message.posted',
      data: { conversationId: cnv, messageId: 'm1', role: 'assistant', text: names, at: 2 },
    },
    created(3, 't1', names),
    taskEvent(4, { type: 'task_failed', taskId: 't1', reason: names }),
  ]);
  render(
    <ConversationView
      client={new CloudClient('fake', api.fetcher)}
      conversation={{ ...conversation, title: names }}
    />,
  );
  await screen.findByRole('article', {
    name: 'assistant, assistant, assistant, assistant, assistant',
  });
  expect(document.body.textContent).not.toMatch(/Claude|Codex|GPT|OpenAI|Anthropic/i);
  expect(
    screen.getAllByText('assistant, assistant, assistant, assistant, assistant').length,
  ).toBeGreaterThan(2);
});

const item: InboxItem = {
  itemId: 'itm_1',
  kind: 'finished',
  conversationId: 'cnv_1',
  taskId: 'tsk_1',
  ask: '“Report” finished (independently checked): “Done.”',
  options: [{ id: 'ok', label: 'Got it', recommended: true }],
  allowText: false,
  evidence: [],
  state: 'open',
  closeReason: null,
  preconditionHash: 'hash_1',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
};

test('a finished card beside its own result card does not list the files and links again', () => {
  const withEvidence: InboxItem = {
    ...item,
    evidence: [{ kind: 'artifact', taskId: 'tsk_1', name: 'changes.diff' }],
  };
  const { rerender } = render(
    <InboxCard item={withEvidence} disabled={false} onAnswer={() => {}} />,
  );
  expect(screen.getByText(/changes\.diff/u)).toBeTruthy();
  rerender(<InboxCard item={withEvidence} disabled={false} onAnswer={() => {}} resultShown />);
  expect(screen.queryByText(/changes\.diff/u)).toBeNull();
  // The answer stays: the supervisor still wants one.
  expect(screen.getByRole('button', { name: 'Got it' })).toBeTruthy();
  // Anything that is not a finished result keeps its evidence, such as an action held for approval.
  rerender(
    <InboxCard
      item={{ ...withEvidence, kind: 'approval' }}
      disabled={false}
      onAnswer={() => {}}
      resultShown
    />,
  );
  expect(screen.getByText(/changes\.diff/u)).toBeTruthy();
});

test('the supervisor’s check label is shown as sent, whichever it is, and never added when absent', () => {
  const labels = [
    'finished (independently checked): “Done.”',
    'finished (not independently checked): “Done.”',
    'finished: “Done.”',
  ];
  for (const label of labels) {
    const { unmount } = render(
      <InboxCard
        item={{ ...item, ask: `“Report” ${label}` }}
        disabled={false}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(`“Report” ${label}`);
    // Nothing else on the card says a result was checked.
    expect(screen.queryAllByText(/checked/iu)).toHaveLength(label.includes('checked') ? 1 : 0);
    unmount();
  }
});

test('an inbox card puts the recommended answer first, takes context only when allowed, and sends one answer', () => {
  const answers: unknown[] = [];
  render(
    <InboxCard
      item={{
        ...item,
        kind: 'decision',
        ask: 'The result came back with low confidence.',
        allowText: true,
        options: [
          { id: 'accept', label: 'Accept it as is', recommended: false },
          { id: 'redo', label: 'Ask the agent to redo it', recommended: true },
        ],
      }}
      disabled={false}
      onAnswer={(optionId, text) => answers.push({ optionId, text })}
    />,
  );
  const buttons = screen.getAllByRole('button').map((button) => button.textContent);
  expect(buttons).toEqual(['Ask the agent to redo it', 'Accept it as is']);
  fireEvent.change(screen.getByLabelText('Additional context (optional)'), {
    target: { value: '  Use the Q3 numbers ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to redo it' }));
  expect(answers).toEqual([{ optionId: 'redo', text: 'Use the Q3 numbers' }]);
});

test('an item with no text field offers none, and an answer being delivered offers no buttons', () => {
  const { rerender } = render(<InboxCard item={item} disabled={false} onAnswer={() => {}} />);
  expect(screen.queryByLabelText('Additional context (optional)')).toBeNull();
  rerender(
    <InboxCard
      item={{ ...item, state: 'answering', delivery: 'retrying' }}
      disabled={false}
      onAnswer={() => {}}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('keep trying');
});

test('a closed item keeps its words under Done', () => {
  const asked = {
    ...item,
    itemId: 'itm_q',
    kind: 'decision' as const,
    ask: 'Which direction feels right?',
  };
  render(
    <InboxPanel
      items={[{ ...asked, state: 'closed', closeReason: 'answered' }]}
      openQuestions={new Set()}
      disabled={false}
      onAnswer={() => {}}
    />,
  );
  expect(screen.getByText('Done (1)')).toBeTruthy();
});

test('inbox text is presentation-filtered like every other server string', () => {
  render(
    <InboxCard
      item={{
        ...item,
        ask: 'Claude and OpenAI GPT disagreed.',
        evidence: [
          { kind: 'link', url: 'https://example.com/openai', label: 'Anthropic notes' },
          { kind: 'action', tool: 'open_pull_request', args: '{"model":"gpt-5"}' },
        ],
        options: [{ id: 'ok', label: 'Ask Codex', recommended: false }],
      }}
      disabled={false}
      onAnswer={() => {}}
    />,
  );
  expect(document.body.textContent).not.toMatch(/claude|openai|gpt|anthropic|codex/iu);
});

test('computer output is inert and name-filtered; unsupported pause never enables input', async () => {
  const task: TaskView = {
    taskId: 'task_one',
    state: 'running',
    createdAt: 0,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
  };
  const client = new CloudClient('fake-invite', (async (_url, init) => {
    if (init?.method === 'POST')
      return Response.json({ error: 'pause_unsupported' }, { status: 409 });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `id: 1\nevent: computer\ndata: ${JSON.stringify({ controller: 'agent', terminal: 'Ｉｎｓｔａｂｏｘ Claude <script>bad()</script>\n' })}\n\n`,
            ),
          );
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      }),
    );
  }) as typeof fetch);
  render(<Computer client={client} task={task} />);
  const details = screen.getByText('Open computer').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() =>
    expect(screen.getByLabelText('Live terminal output').textContent).toContain(
      '<script>bad()</script>',
    ),
  );
  expect(document.body.textContent).not.toMatch(/instabox|claude/iu);
  expect(document.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'Watching only; no control was granted',
    ),
  );
  expect((screen.getByLabelText('Terminal input') as HTMLInputElement).disabled).toBe(true);
});

test('a picture is shown from a local object URL that is released when it goes away', () => {
  const made: string[] = [];
  const freed: string[] = [];
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    made.push(`blob:local/${(blob as Blob).size}`);
    return made.at(-1) ?? '';
  };
  URL.revokeObjectURL = (url: string) => {
    freed.push(url);
  };
  const { unmount } = render(
    <Picture name="proof.png" blob={new Blob([new Uint8Array(9)], { type: 'image/png' })} />,
  );
  const image = screen.getByRole('img', { name: 'proof.png' });
  expect(image.getAttribute('src')).toBe('blob:local/9');
  unmount();
  expect(freed).toEqual(['blob:local/9']);
});
