import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  CloudClient,
  type DutyView,
  type InboxItem,
  type ProjectView,
  type TaskView,
} from '@maka-cloud/client';
import { Projects } from '../src/Projects';
import { TaskPage } from '../src/TaskPage';

beforeEach(() => {
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => `blob:fake/${++n}`,
      revokeObjectURL: () => {},
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const duty = (over: Partial<DutyView> = {}): DutyView => ({
  dutyId: 'd1',
  name: 'Fix red CI',
  trigger: { kind: 'ci_failed_default_branch' },
  authority: 'open-pr',
  runBudgetUsd: 2,
  dailyCapUsd: 6,
  state: 'active',
  activatedAt: 1,
  offReason: null,
  consecutiveFailures: 0,
  ...over,
});
const project = (duties: DutyView[]): ProjectView => ({
  projectId: 'p1',
  repo: 'example/repo',
  defaultBranch: 'main',
  duties,
});

function serveProjects(
  state: { projects: ProjectView[] | 404 },
  patch?: (body: { state: string }) => Response,
) {
  const patches: { path: string; state: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path === '/v1/projects' && init?.method === undefined) {
      return state.projects === 404
        ? Response.json({}, { status: 404 })
        : Response.json({ projects: state.projects });
    }
    if (init?.method === 'PATCH' && /^\/v1\/projects\/[^/]+\/duties\/[^/]+$/u.test(path)) {
      const body = JSON.parse(String(init.body)) as { state: string };
      patches.push({ path, state: body.state });
      if (patch) return patch(body);
      const [only] = (state.projects as ProjectView[])[0]?.duties ?? [];
      if (only) only.state = body.state as DutyView['state'];
      return Response.json({ state: body.state });
    }
    return Response.json({}, { status: 404 });
  };
  return { client: new CloudClient('fake', fetcher), patches };
}

test('a duty shows its trigger, authority and budget, and its switch turns it off and reads the server again', async () => {
  const api = serveProjects({ projects: [project([duty()])] });
  render(<Projects client={api.client} />);
  const region = await screen.findByRole('region', { name: 'example/repo' });
  expect(within(region).getByText('When CI fails on the default branch')).toBeTruthy();
  expect(
    within(region).getByText('Opens pull requests · Up to $2.00 a run, $6.00 a day'),
  ).toBeTruthy();
  const toggle = within(region).getByRole('switch', { name: 'Fix red CI is on' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(within(region).getByRole('switch', { name: 'Fix red CI is off' })).toBeTruthy(),
  );
  expect(api.patches).toEqual([{ path: '/v1/projects/p1/duties/d1', state: 'off' }]);
});

test('a refused switch says why in words and shows what the server holds', async () => {
  const api = serveProjects({ projects: [project([duty({ state: 'off' })])] }, () =>
    Response.json({ error: 'duty_limit' }, { status: 409 }),
  );
  render(<Projects client={api.client} />);
  fireEvent.click(await screen.findByRole('switch', { name: 'Fix red CI is off' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/up to 20 duties/u);
  expect(screen.getByRole('switch', { name: 'Fix red CI is off' })).toBeTruthy();
});

test('a duty that is not approved has no switch, and one turned off by failures says so', async () => {
  const api = serveProjects({
    projects: [
      project([
        duty({ dutyId: 'a', name: 'Proposed one', state: 'proposed', activatedAt: null }),
        duty({
          dutyId: 'b',
          name: 'Failing one',
          state: 'off',
          offReason: 'failures',
          consecutiveFailures: 10,
        }),
      ]),
    ],
  });
  render(<Projects client={api.client} />);
  await screen.findByText('Proposed one');
  expect(screen.queryByRole('switch', { name: /Proposed one/u })).toBeNull();
  expect(screen.getByText(/Waiting for your approval/u)).toBeTruthy();
  expect(screen.getByText('Turned off after it failed 10 times in a row.')).toBeTruthy();
});

test('a server without duties says so instead of failing', async () => {
  const api = serveProjects({ projects: 404 });
  render(<Projects client={api.client} />);
  expect(await screen.findByText(/not available on this server/u)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a double tap on a switch sends one change', async () => {
  const api = serveProjects({ projects: [project([duty()])] });
  render(<Projects client={api.client} />);
  const toggle = await screen.findByRole('switch', { name: 'Fix red CI is on' });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'Fix red CI is off' })).toBeTruthy(),
  );
  expect(api.patches).toHaveLength(1);
});

const finished = (over: Partial<TaskView> = {}): TaskView => ({
  taskId: 't1',
  title: 'Fix the login loop',
  state: 'succeeded',
  createdAt: 1,
  finishedAt: 2,
  costUsd: 1.25,
  budgetUsd: 5,
  progress: ['step: Reproduce the loop', 'step: Patch the redirect'],
  cancelRequested: false,
  pauseRequested: false,
  manifest: {
    summary: 'The login page no longer loops.',
    done: ['Patched the redirect'],
    notDone: ['Did not touch the mobile app'],
    confidence: 'medium',
    knownIssues: ['One flaky test'],
  },
  ...over,
});
const inboxItem = (over: Partial<InboxItem>): InboxItem => ({
  itemId: 'i1',
  kind: 'finished',
  conversationId: 'c1',
  taskId: 't1',
  ask: 'Finished (independently checked): the login loop is fixed.',
  options: [],
  allowText: false,
  evidence: [],
  state: 'closed',
  closeReason: null,
  preconditionHash: 'h',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function serveTask(inbox: InboxItem[] | 404 = []) {
  const reads: number[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    if (path === '/v1/tasks/t1/artifacts') {
      return Response.json({
        total: 4,
        artifacts: [
          { index: 0, name: 'changes.diff', kind: 'file' },
          { index: 1, name: 'test-output.txt', kind: 'file' },
          { index: 2, name: 'after.png', kind: 'file', image: true },
          {
            index: 3,
            name: 'pull request',
            kind: 'link',
            url: 'https://github.com/example/repo/pull/12',
          },
        ],
      });
    }
    const artifact = /\/artifacts\/(\d+)$/u.exec(path);
    if (artifact) {
      const index = Number(artifact[1]);
      reads.push(index);
      const bodies: Record<number, [string, string, BodyInit]> = {
        0: ['changes.diff', 'text/plain', '+added line\n-removed line\n context'],
        1: ['test-output.txt', 'text/plain', '12 passed'],
        2: ['after.png', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      };
      const [name, type, body] = bodies[index] ?? ['x', 'text/plain', ''];
      return new Response(body, {
        headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"` },
      });
    }
    if (path.startsWith('/v1/inbox/items')) {
      return inbox === 404 ? Response.json({}, { status: 404 }) : Response.json({ items: inbox });
    }
    if (path === '/v1/tasks/t1/sources') return Response.json({ sources: [], total: 0 });
    return Response.json({}, { status: 404 });
  };
  return { client: new CloudClient('fake', fetcher), reads };
}

test('a task page shows outcome, review, steps, the diff, the report, the picture and the pull request', async () => {
  const api = serveTask([inboxItem({})]);
  const back = vi.fn();
  render(<TaskPage client={api.client} task={finished()} onBack={back} />);
  const page = screen.getByRole('article', { name: 'Task: Fix the login loop' });
  expect(within(page).getByText(/Cost \$1\.25 of \$5\.00/u)).toBeTruthy();
  const outcome = within(page).getByRole('region', { name: 'Outcome' });
  expect(within(outcome).getByText('The login page no longer loops.')).toBeTruthy();
  expect(within(outcome).getByText('Patched the redirect')).toBeTruthy();
  expect(within(outcome).getByText('Did not touch the mobile app')).toBeTruthy();
  expect(within(outcome).getByText('One flaky test')).toBeTruthy();
  expect(within(outcome).getByText(/medium/u)).toBeTruthy();
  const steps = within(page).getByRole('region', { name: 'Steps' });
  expect(
    within(steps)
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['Reproduce the loop', 'Patch the redirect']);
  const review = await within(page).findByRole('region', { name: 'Review' });
  expect(review.textContent).toContain(
    'Finished (independently checked): the login loop is fixed.',
  );
  const results = within(page).getByRole('region', { name: 'Results' });
  await waitFor(() => expect(within(results).getByText('+added line')).toBeTruthy());
  expect(within(results).getByText('+added line').className).toContain('add');
  expect(within(results).getByText('-removed line').className).toContain('del');
  expect(within(results).getByText('12 passed')).toBeTruthy();
  expect(within(results).getByRole('img', { name: 'after.png' })).toBeTruthy();
  const pull = within(page).getAllByRole('link', { name: /Pull request|pull\/12/u })[0];
  expect(pull?.getAttribute('href')).toBe('https://github.com/example/repo/pull/12');
  fireEvent.click(screen.getByRole('button', { name: '← Back' }));
  expect(back).toHaveBeenCalled();
});

test('a task page works on a server with no inbox, and a result that cannot load says so', async () => {
  const api = serveTask(404);
  render(<TaskPage client={api.client} task={finished()} onBack={() => {}} />);
  await screen.findByText('12 passed');
  expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
});

test('a failed task page says why and shows no outcome it never reported', async () => {
  const api = serveTask();
  render(
    <TaskPage
      client={api.client}
      task={finished({
        state: 'failed',
        manifest: undefined,
        failureReason: 'The tests would not run.',
        progress: [],
      })}
      onBack={() => {}}
    />,
  );
  expect(screen.getByText('The tests would not run.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Outcome' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Steps' })).toBeNull();
});

test('the second agent’s review is shown on its own, in the runner’s words, and not twice', async () => {
  const api = serveTask();
  const base = finished();
  const line =
    'review: an independent agent reviewed the change; 1 finding(s) remain: P2 1 (see review.md)';
  render(
    <TaskPage
      client={api.client}
      task={finished({
        manifest: {
          ...(base.manifest as NonNullable<typeof base.manifest>),
          done: ['Patched the redirect', line],
        },
      })}
      onBack={() => {}}
    />,
  );
  const review = screen.getByRole('region', { name: 'Independent review' });
  expect(within(review).getByText(line.slice('review: '.length))).toBeTruthy();
  const outcome = screen.getByRole('region', { name: 'Outcome' });
  expect(within(outcome).getByText('Patched the redirect')).toBeTruthy();
  expect(within(outcome).queryByText(line)).toBeNull();
  await screen.findByText('12 passed');
});

test('a task with no review line shows no independent review section', async () => {
  const api = serveTask();
  render(<TaskPage client={api.client} task={finished()} onBack={() => {}} />);
  await screen.findByText('12 passed');
  expect(screen.queryByRole('region', { name: 'Independent review' })).toBeNull();
});

function serveSuggestions(kinds: Array<Record<string, unknown>> | 404) {
  const patches: { kind: string; enabled: boolean }[] = [];
  const base = serveProjects({ projects: [project([duty()])] });
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path === '/v1/projects/p1/suggestions') {
      if (kinds === 404) return Response.json({}, { status: 404 });
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { kind: string; enabled: boolean };
        patches.push(body);
        const row = kinds.find((k) => k.kind === body.kind);
        if (row) row.enabled = body.enabled;
        return Response.json(body);
      }
      return Response.json({ suggestions: { kinds, cards: [] } });
    }
    return (base.client as unknown as { fetcher: typeof fetch }).fetcher(input, init);
  };
  return { client: new CloudClient('fake', fetcher), patches };
}
const kindRow = (over: Record<string, unknown> = {}) => ({
  kind: 'fix_main_ci',
  label: 'Fix failing tests on the default branch',
  enabled: true,
  accepted: 2,
  dismissed: 1,
  ignored: 0,
  ignoredInARow: 0,
  backedOff: false,
  offer: 'none',
  ...over,
});

test('a project shows a switch for each kind of suggestion, with what the owner did with them', async () => {
  const kinds = [
    kindRow(),
    kindRow({
      kind: 'rebase_pr',
      label: 'Rebase its own pull requests',
      enabled: false,
      accepted: 0,
      dismissed: 0,
    }),
  ];
  const api = serveSuggestions(kinds);
  render(<Projects client={api.client} />);
  const list = await screen.findByRole('list', { name: 'Suggestions' });
  expect(within(list).getByText('2 done · 1 not now · 0 unanswered')).toBeTruthy();
  expect(within(list).getByText('Nothing suggested yet.')).toBeTruthy();
  const sw = within(list).getByRole('switch', {
    name: 'Fix failing tests on the default branch suggestions are on',
  });
  fireEvent.click(sw);
  await waitFor(() => expect(api.patches).toEqual([{ kind: 'fix_main_ci', enabled: false }]));
  await waitFor(() =>
    expect(
      within(list).getByRole('switch', {
        name: 'Fix failing tests on the default branch suggestions are off',
      }),
    ).toBeTruthy(),
  );
});

test('a server without suggestions shows no suggestion section and no error', async () => {
  const api = serveSuggestions(404);
  render(<Projects client={api.client} />);
  await screen.findByRole('region', { name: 'example/repo' });
  expect(screen.queryByRole('list', { name: 'Suggestions' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
