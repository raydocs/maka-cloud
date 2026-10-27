import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  CloudClient,
  dutyTime,
  type Conversation,
  inboxAnswerer,
  type InboxItem,
  type ProjectView,
  type TaskView,
} from '@maka-cloud/client';
import { Home } from '../src/Home';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const task = (over: Partial<TaskView>): TaskView => ({
  taskId: 't1',
  title: 'Fix the login loop',
  state: 'succeeded',
  createdAt: NOW - 3 * HOUR,
  finishedAt: NOW - HOUR,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  manifest: {
    summary: 'The login page no longer loops. Tests pass.',
    done: [],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
  },
  costUsd: 0.42,
  ...over,
});

const duty = (over: Partial<ProjectView['duties'][number]>): ProjectView['duties'][number] => ({
  dutyId: 'd1',
  name: 'Nightly dependency check',
  trigger: { kind: 'schedule', everyMinutes: 60 },
  authority: 'open-pr',
  runBudgetUsd: 2,
  dailyCapUsd: 5,
  state: 'active',
  activatedAt: NOW - 150 * MIN,
  offReason: null,
  consecutiveFailures: 0,
  ...over,
});

const conversations: Conversation[] = [
  { conversationId: 'c1', title: 'Launch', createdAt: 1 },
  { conversationId: 'c2', title: 'Taxes', createdAt: 2 },
];

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  itemId: 'itm_1',
  kind: 'decision',
  conversationId: 'c1',
  taskId: 't1',
  ask: 'Merge PR #12: tests passed, review passed.',
  options: [
    { id: 'merge', label: 'Merge PR #12', recommended: true },
    { id: 'wait', label: 'Not yet', recommended: false },
  ],
  allowText: false,
  evidence: [],
  state: 'open',
  closeReason: null,
  preconditionHash: 'h1',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

interface Server {
  inbox?: InboxItem[] | 404;
  /** True while reading the inbox should fail. */
  inboxFails?: () => boolean;
  projects?: ProjectView[] | 404;
  tasks?: Record<string, TaskView[]>;
  answer?: (body: { answerId: string; optionId: string; preconditionHash: string }) => Response;
}
function serve(config: Server) {
  const calls: string[] = [];
  const answers: { answerId: string; optionId: string; preconditionHash: string }[] = [];
  const posted: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.startsWith('/v1/inbox/items') && init?.method === undefined) {
      if (config.inboxFails?.()) return Response.json({}, { status: 500 });
      if (config.inbox === 404) return Response.json({}, { status: 404 });
      return Response.json({ items: config.inbox ?? [] });
    }
    const answered = /\/v1\/inbox\/items\/[^/]+\/answer$/u.exec(path);
    if (answered && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      answers.push(body);
      return (
        config.answer?.(body) ??
        Response.json({ duplicate: false, item: item({ state: 'closed', version: 2 }) })
      );
    }
    if (path === '/v1/conversations' && init?.method === 'POST') {
      return Response.json({ conversationId: 'cnv_new' });
    }
    if (path === '/v1/conversations/cnv_new/messages' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return Response.json({ messageId: 'msg_1' }, { status: 202 });
    }
    if (path === '/v1/projects') {
      if (config.projects === 404) return Response.json({}, { status: 404 });
      return Response.json({ projects: config.projects ?? [] });
    }
    const tasks = /\/v1\/conversations\/([^/]+)\/tasks\?/u.exec(path);
    if (tasks) return Response.json({ tasks: config.tasks?.[tasks[1] ?? ''] ?? [] });
    return Response.json({}, { status: 404 });
  };
  return { client: new CloudClient('fake', fetcher), calls, answers, posted };
}

function renderHome(
  config: Server,
  extra: { onOpen?: (id: string) => void; now?: () => number } = {},
) {
  const api = serve(config);
  const view = render(
    <Home
      client={api.client}
      conversations={conversations}
      onStarted={() => {}}
      onOpen={extra.onOpen ?? (() => {})}
      now={extra.now ?? (() => NOW)}
    />,
  );
  return { ...api, ...view };
}

test('decisions come first as one-tap cards with a verb, and one tap answers exactly once', async () => {
  const { answers } = renderHome({ inbox: [item()] });
  const waiting = await screen.findByRole('region', { name: 'Decisions waiting' });
  expect(within(waiting).getByText('Waiting on you (1)')).toBeTruthy();
  expect(within(waiting).getByText('Decide')).toBeTruthy();
  expect(within(waiting).getByRole('heading', { level: 3 }).textContent).toBe(
    'Merge PR #12: tests passed, review passed.',
  );
  // The recommended answer is the first button.
  const buttons = within(waiting).getAllByRole('button');
  expect(buttons[0]?.textContent).toBe('Merge PR #12');
  // Decisions sit above the start sentence.
  const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
  expect(regions.indexOf('Decisions waiting')).toBeLessThan(regions.indexOf('Start something'));

  const merge = within(waiting).getByRole('button', { name: 'Merge PR #12' });
  fireEvent.click(merge);
  fireEvent.click(merge);
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Decisions waiting' })).toBeNull(),
  );
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ optionId: 'merge', preconditionHash: 'h1' });
});

test('a card that went stale refreshes and does not act: the answer is refused and the new card is shown', async () => {
  const fresh = item({
    ask: 'Merge PR #12: a new commit changed it.',
    preconditionHash: 'h2',
    version: 2,
  });
  const { answers } = renderHome({
    inbox: [item()],
    answer: () => Response.json({ error: 'stale', item: fresh }, { status: 409 }),
  });
  const waiting = await screen.findByRole('region', { name: 'Decisions waiting' });
  fireEvent.click(within(waiting).getByRole('button', { name: 'Merge PR #12' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('changed while you were looking');
  // The card now shows the server's current version, and nothing was applied.
  await screen.findByText('Merge PR #12: a new commit changed it.');
  expect(answers).toHaveLength(1);
  // The next tap answers the refreshed card, with its own precondition.
  answers.length = 0;
  fireEvent.click(screen.getByRole('button', { name: 'Merge PR #12' }));
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers[0]?.preconditionHash).toBe('h2');
});

test('a decision can be opened in its conversation', async () => {
  const opened: string[] = [];
  renderHome({ inbox: [item({ conversationId: 'c2' })] }, { onOpen: (id) => opened.push(id) });
  fireEvent.click(await screen.findByRole('button', { name: 'Open “Taxes”' }));
  expect(opened).toEqual(['c2']);
});

test('no decisions and no inbox on this server: no empty card, the start sentence is there', async () => {
  renderHome({ inbox: 404, projects: 404 });
  await screen.findByLabelText('What would you like to get done?');
  expect(screen.queryByRole('region', { name: 'Decisions waiting' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'What runs next' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Since you were last here' })).toBeNull();
});

test('since you were last here: the results since the stored visit, three tiles, one line each with its cost', async () => {
  const api = serve({ tasks: {} });
  // The stored visit belongs to this invite and is read through its fingerprint, never its token.
  const print = await api.client.fingerprint();
  expect(print).toMatch(/^[0-9a-f]{16}$/u);
  expect(print).not.toContain('fake');
  localStorage.setItem(`maka.visit.${print}`, String(NOW - 5 * HOUR));
  cleanup();
  const opened: string[] = [];
  const tasks = {
    c1: [
      task({ taskId: 'before', finishedAt: NOW - 6 * HOUR, title: 'Older job' }),
      task({
        taskId: 'after',
        finishedAt: NOW - 2 * HOUR,
        title: 'Fix the login loop',
        costUsd: 0.4,
      }),
    ],
    c2: [
      task({
        taskId: 'bad',
        title: 'Upgrade deps',
        state: 'failed',
        finishedAt: NOW - HOUR,
        failureReason: 'The build broke.',
        manifest: undefined,
        costUsd: 0.1,
      }),
    ],
  };
  const second = serve({ tasks, inbox: [item()] });
  render(
    <Home
      client={second.client}
      conversations={conversations}
      onStarted={() => {}}
      onOpen={(id) => opened.push(id)}
      now={() => NOW}
    />,
  );
  const region = await screen.findByRole('region', { name: 'Since you were last here' });
  await within(region).findByText('Fix the login loop');
  expect(within(region).queryByText('Older job')).toBeNull();
  const tiles = region.querySelectorAll('.stat-tile');
  expect([...tiles].map((t) => t.textContent)).toEqual(['Done1', 'Did not finish1', 'Spent$0.50']);
  expect(within(region).getByText('The login page no longer loops.')).toBeTruthy();
  expect(within(region).getByText('The build broke.')).toBeTruthy();
  fireEvent.click(within(region).getByRole('button', { name: /Upgrade deps/u }));
  expect(opened).toEqual(['c2']);
});

test('the visit is written when the person leaves, per invite, and a first visit shows the last day', async () => {
  const api = serve({
    tasks: {
      c1: [
        task({ taskId: 'recent', finishedAt: NOW - 3 * HOUR }),
        task({ taskId: 'gone', title: 'Two days ago', finishedAt: NOW - 48 * HOUR }),
      ],
    },
  });
  const { unmount } = render(
    <Home
      client={api.client}
      conversations={conversations}
      onStarted={() => {}}
      onOpen={() => {}}
      now={() => NOW}
    />,
  );
  const region = await screen.findByRole('region', { name: 'Since you were last here' });
  expect(within(region).getByText('Fix the login loop')).toBeTruthy();
  expect(within(region).queryByText('Two days ago')).toBeNull();
  const print = await api.client.fingerprint();
  expect(localStorage.getItem(`maka.visit.${print}`)).toBeNull();
  unmount();
  expect(localStorage.getItem(`maka.visit.${print}`)).toBe(String(NOW));
  // Another invite has its own visit.
  const other = await new CloudClient('another', async () => Response.json({})).fingerprint();
  expect(other).not.toBe(print);
  expect(localStorage.getItem(`maka.visit.${other}`)).toBeNull();
});

test('what runs next lists scheduled duties with their time, and counts the ones that wake on GitHub', async () => {
  renderHome({
    projects: [
      {
        projectId: 'p1',
        repo: 'acme/web',
        defaultBranch: 'main',
        duties: [
          duty({}),
          duty({ dutyId: 'd3', name: 'Fix CI', trigger: { kind: 'issue_opened' } }),
        ],
      },
    ],
  });
  const region = await screen.findByRole('region', { name: 'What runs next' });
  expect(within(region).getByText('Nightly dependency check')).toBeTruthy();
  expect(within(region).getByText('acme/web')).toBeTruthy();
  expect(within(region).getByText(dutyTime(NOW + 30 * MIN, 'en', NOW))).toBeTruthy();
  expect(
    within(region).getByText('1 more duty wakes when something happens on GitHub.'),
  ).toBeTruthy();
});

test('words from the server are shown without vendor or model names', async () => {
  renderHome({
    inbox: [item({ ask: 'Claude and GPT disagree about PR #3.' })],
    tasks: {
      c1: [
        task({
          title: 'Ask OpenAI',
          manifest: {
            summary: 'Codex did it.',
            done: [],
            notDone: [],
            confidence: 'high',
            knownIssues: [],
          },
        }),
      ],
    },
  });
  await screen.findByRole('region', { name: 'Since you were last here' });
  expect(document.body.textContent).not.toMatch(/Claude|GPT|OpenAI|Codex/iu);
});

test('a retried answer reuses its id, so the server counts it once; a different answer or state gets its own', async () => {
  const seen: { answerId: string; optionId: string; preconditionHash: string }[] = [];
  let fail = true;
  const client = new CloudClient('fake', async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body);
    if (fail) return Response.json({ error: 'unavailable' }, { status: 503 });
    return Response.json({ duplicate: false, item: item({ state: 'closed', version: 2 }) });
  });
  const taken: unknown[] = [];
  const answer = inboxAnswerer(client, (i) => taken.push(i));
  await expect(answer(item(), 'merge')).rejects.toThrow();
  fail = false;
  await answer(item(), 'merge');
  expect(seen).toHaveLength(2);
  expect(seen[1]?.answerId).toBe(seen[0]?.answerId);
  // The next answer to the same card is a new answer once the first was taken.
  await answer(item(), 'merge');
  expect(seen[2]?.answerId).not.toBe(seen[0]?.answerId);
  // Another option, and another state of the card, are other answers.
  fail = true;
  await expect(answer(item(), 'wait')).rejects.toThrow();
  await expect(answer(item({ preconditionHash: 'h9' }), 'wait')).rejects.toThrow();
  expect(new Set(seen.slice(3).map((s) => s.answerId)).size).toBe(2);
});

test('starting something sends no mode unless one is picked, and a pick is sent with the message', async () => {
  const plain = renderHome({ inbox: [], projects: [] });
  const picker = await screen.findByRole('group', { name: 'How much care this needs' });
  const radios = within(picker).getAllByRole('radio') as HTMLInputElement[];
  expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
    'Let it decide',
    'Quick',
    'Standard',
    'Deep',
  ]);
  expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
  fireEvent.change(screen.getByLabelText('What would you like to get done?'), {
    target: { value: 'Fix the login loop' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(plain.posted).toHaveLength(1));
  expect(Object.keys(plain.posted[0] ?? {}).sort()).toEqual(['clientMessageId', 'text']);
  cleanup();

  const picked = renderHome({ inbox: [], projects: [] });
  fireEvent.click(await screen.findByLabelText('Deep'));
  expect((screen.getByLabelText('Deep') as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('What would you like to get done?'), {
    target: { value: 'Fix the login loop' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(picked.posted).toHaveLength(1));
  expect(picked.posted[0]).toMatchObject({ text: 'Fix the login loop', mode: 'deep' });
});

const suggestion = (over: Partial<InboxItem> = {}): InboxItem =>
  item({
    itemId: 'itm_s1',
    kind: 'suggestion',
    taskId: null,
    ask: 'Fix the failing test on main',
    options: [
      { id: 'do', label: 'Do it', recommended: true },
      { id: 'later', label: 'Not now', recommended: false },
    ],
    preconditionHash: 'hs1',
    suggestion: {
      kind: 'fix_main_ci',
      mode: 'standard',
      estimateUsd: 3,
      typical: true,
      repo: 'acme/widgets',
      detail: 'CI has failed on main since this morning.',
      external: false,
    },
    ...over,
  });

test('a suggestion is a card of its own with its cost in words, and does not count as waiting on you', async () => {
  const { answers } = renderHome({
    inbox: [suggestion()],
    answer: () =>
      Response.json({ duplicate: false, item: suggestion({ state: 'closed', version: 2 }) }),
  });
  const region = await screen.findByRole('region', { name: 'Suggestions' });
  expect(within(region).getByText('Noticed for you (1)')).toBeTruthy();
  expect(within(region).getByRole('heading', { level: 3 }).textContent).toBe(
    'Fix the failing test on main',
  );
  expect(within(region).getByText('Standard · about $3.00 (typical) · acme/widgets')).toBeTruthy();
  expect(within(region).getByText('CI has failed on main since this morning.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Decisions waiting' })).toBeNull();
  expect(screen.queryByText(/Part of this was written by someone else/u)).toBeNull();
  // An action sentence: the verb is the recommended answer's button, the other answer is quiet.
  const buttons = within(region).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['Fix', 'Not now']);
  expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
    'Do it: Fix the failing test on main',
    'Not now',
  ]);
  fireEvent.click(buttons[0] as HTMLElement);
  fireEvent.click(buttons[0] as HTMLElement);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull());
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ optionId: 'do', preconditionHash: 'hs1' });
});

test('a suggestion that moved is replaced by the new one and nothing is started', async () => {
  const fresh = suggestion({
    ask: 'Fix the 2 failing tests on main',
    preconditionHash: 'hs2',
    version: 2,
  });
  const { answers } = renderHome({
    inbox: [suggestion()],
    answer: () => Response.json({ error: 'stale', item: fresh }, { status: 409 }),
  });
  const region = await screen.findByRole('region', { name: 'Suggestions' });
  fireEvent.click(within(region).getByRole('button', { name: /^Do it:/u }));
  // The verb is a button inside the title, so the card is found by its name.
  await screen.findByRole('article', { name: 'Fix the 2 failing tests on main' });
  expect(screen.getByRole('alert').textContent).toContain('changed while you were looking');
  expect(answers).toHaveLength(1);
  answers.length = 0;
  fireEvent.click(screen.getByRole('button', { name: /^Do it:/u }));
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers[0]?.preconditionHash).toBe('hs2');
});

test('a suggestion with text from outside says so, and the offer to turn a kind off is a plain card', async () => {
  renderHome({
    inbox: [
      suggestion({
        suggestion: { ...(suggestion().suggestion as object), external: true } as never,
      }),
      suggestion({
        itemId: 'itm_o1',
        ask: '3 suggestions in a row to update vulnerable dependencies on acme/widgets went unanswered. Stop suggesting them?',
        suggestion: undefined,
        options: [
          { id: 'turn-off', label: 'Turn off', recommended: true },
          { id: 'keep', label: 'Keep', recommended: false },
        ],
        updatedAt: 0,
      }),
    ],
  });
  const region = await screen.findByRole('region', { name: 'Suggestions' });
  expect(within(region).getByText(/Part of this was written by someone else/u)).toBeTruthy();
  expect(within(region).getByRole('button', { name: 'Turn off' })).toBeTruthy();
  expect(within(region).getByRole('button', { name: 'Keep' })).toBeTruthy();
  expect(within(region).getByText('Noticed for you (2)')).toBeTruthy();
});

test('where decisions would be: bars while loading, a retry when they could not load, then a calm line', async () => {
  let fail = true;
  renderHome({ inboxFails: () => fail });
  expect(screen.getByRole('region', { name: 'Loading' })).toBeTruthy();
  const failed = await screen.findByRole('region', { name: 'Decisions could not be loaded' });
  fail = false;
  fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
  const calm = await screen.findByRole('region', { name: 'Nothing needs you' });
  expect(calm.textContent).toBe('Nothing needs you.');
  expect(screen.queryByRole('region', { name: 'Loading' })).toBeNull();
});

test('project and recent-conversation starters fill the composer without sending', async () => {
  const api = renderHome({
    projects: [{ projectId: 'p1', repo: 'alice/garden', defaultBranch: 'main', duties: [] }],
  });
  const fix = await screen.findByRole('button', {
    name: 'Fix the failing test in alice/garden and open a pull request.',
  });
  fireEvent.click(fix);
  expect(
    (screen.getByLabelText('What would you like to get done?') as HTMLTextAreaElement).value,
  ).toBe('Fix the failing test in alice/garden and open a pull request.');
  fireEvent.click(screen.getByRole('button', { name: 'Continue “Taxes”' }));
  expect(
    (screen.getByLabelText('What would you like to get done?') as HTMLTextAreaElement).value,
  ).toBe('Continue “Taxes”');
  expect(api.posted).toEqual([]);
});
