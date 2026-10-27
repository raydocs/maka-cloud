import { expect, test } from 'vitest';
import {
  type ArtifactListing,
  CloudClient,
  deliveryModel,
  loadSources,
  loadTaskResults,
  pullRequestOf,
  type SourceListing,
  type TaskView,
} from '../src/index';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  taskId: 't1',
  state: 'succeeded',
  createdAt: 1,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
  manifest: {
    summary: 'The readme is tidier. Two sections moved.',
    done: [],
    notDone: [],
    confidence: 'high',
    knownIssues: [],
  },
  ...over,
});

const file = (index: number, name: string, image?: true): ArtifactListing => ({
  index,
  name,
  kind: 'file',
  ...(image ? { image } : {}),
});
const link = (index: number, url: string): ArtifactListing => ({
  index,
  name: url,
  kind: 'link',
  url,
});
const source = (index: number, url: string, label: SourceListing['label']): SourceListing => ({
  index,
  url,
  site: new URL(url).host,
  label,
});

test('a result card needs a finished task with a summary, and says its outcome in one sentence', () => {
  expect(deliveryModel(task({ state: 'running' }), [], [])).toBeUndefined();
  expect(deliveryModel(task({ manifest: undefined }), [], [])).toBeUndefined();
  expect(deliveryModel(task(), [], [])?.outcome).toBe('The readme is tidier.');
});

test('the picture is the visual and the diff only stands in when there is none', () => {
  const both = deliveryModel(
    task(),
    [file(0, 'out/changes.diff'), file(1, 'out/home.png', true)],
    [],
  );
  expect(both?.shot?.index).toBe(1);
  expect(both?.caption).not.toBe('The changes');
  const onlyDiff = deliveryModel(task(), [file(0, 'out/changes.diff')], []);
  expect(onlyDiff?.shot).toBeUndefined();
  expect(onlyDiff?.diff?.index).toBe(0);
  expect(onlyDiff?.caption).toBe('The changes');
  // A report is not a diff, and a name alone does not make a picture.
  const neither = deliveryModel(task(), [file(0, 'out/report.md'), file(1, 'out/x.png')], []);
  expect(neither?.shot).toBeUndefined();
  expect(neither?.diff).toBeUndefined();
});

test('the actions are the pull request then the preview, public links only, at most two', () => {
  const model = deliveryModel(
    task(),
    [
      link(0, 'http://insecure.example/pull/9'),
      link(1, 'https://github.com/example/repo/issues/3'),
      link(2, 'https://github.com/example/repo/pull/7'),
    ],
    [
      source(0, 'https://docs.example/a', 'docs'),
      source(1, 'https://preview.example/app', 'preview'),
    ],
  );
  expect(model?.actions).toEqual([
    {
      label: 'Open pull request',
      url: 'https://github.com/example/repo/pull/7',
      host: 'github.com',
    },
    { label: 'Open preview', url: 'https://preview.example/app', host: 'preview.example' },
  ]);
  expect(deliveryModel(task(), [], [])?.actions).toEqual([]);
});

test('results load in order, a failed read is listed as failed and a non-public link is left out', async () => {
  const listings = [
    file(0, 'out/changes.diff'),
    file(1, 'out/report.md'),
    file(2, 'out/home.png', true),
    file(3, 'out/broken.md'),
    link(4, 'http://insecure.example/x'),
    link(5, 'https://github.com/example/repo/pull/7'),
  ];
  const fetcher = (async (url: string) => {
    const path = String(url);
    if (path.endsWith('/artifacts'))
      return Response.json({ artifacts: listings, total: listings.length });
    if (path.endsWith('/artifacts/0'))
      return new Response('+added\n-removed\n', {
        headers: {
          'content-disposition': 'attachment; filename="changes.diff"',
          'content-type': 'text/plain',
        },
      });
    if (path.endsWith('/artifacts/1'))
      return new Response('# Report', {
        headers: {
          'content-disposition': 'attachment; filename="report.md"',
          'content-type': 'text/markdown',
        },
      });
    if (path.endsWith('/artifacts/2'))
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: {
          'content-disposition': 'attachment; filename="home.png"',
          'content-type': 'image/png',
        },
      });
    return new Response('nope', { status: 500 });
  }) as unknown as typeof fetch;
  const client = new CloudClient('fake', { fetcher });
  const results = await loadTaskResults(client, 't1');
  expect(results.map((result) => `${result.kind}:${result.name}`)).toEqual([
    'diff:out/changes.diff',
    'report:out/report.md',
    'image:out/home.png',
    'failed:out/broken.md',
    'link:https://github.com/example/repo/pull/7',
  ]);
  expect(pullRequestOf(results)).toBe('https://github.com/example/repo/pull/7');
  expect(pullRequestOf(results.slice(0, 4))).toBeUndefined();
});

test('pages a task opened: none when the server has no route or the read fails', async () => {
  const ok = new CloudClient('fake', {
    fetcher: (async () =>
      Response.json({
        sources: [source(0, 'https://docs.example/a', 'docs')],
      })) as unknown as typeof fetch,
  });
  expect(await loadSources(ok, 't1')).toHaveLength(1);
  const missing = new CloudClient('fake', {
    fetcher: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  });
  expect(await loadSources(missing, 't1')).toEqual([]);
  const broken = new CloudClient('fake', {
    fetcher: (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  expect(await loadSources(broken, 't1')).toEqual([]);
});

test('screenshots of two or more viewports become views, widest first, with a caption that names them', () => {
  const model = deliveryModel(
    task(),
    [
      file(0, 'out/home-phone.png', true),
      file(1, 'out/notes.md'),
      file(2, 'out/home-desktop.png', true),
      file(3, 'out/home-tablet.png', true),
      file(4, 'out/home-iphone-2.png', true),
    ],
    [],
  );
  expect(model?.views?.map((view) => [view.viewport, view.listing.name])).toEqual([
    ['Desktop', 'out/home-desktop.png'],
    ['Tablet', 'out/home-tablet.png'],
    ['Phone', 'out/home-phone.png'],
  ]);
  expect(model?.shot?.name).toBe('out/home-desktop.png');
  expect(model?.caption).toBe('Desktop, tablet and phone');
  expect(
    deliveryModel(task(), [file(0, 'a-mobile.png', true), file(1, 'a-laptop.png', true)], [])
      ?.caption,
  ).toBe('Desktop and phone');
});

test('one viewport, or names that only contain the words, is an ordinary picture', () => {
  const single = deliveryModel(task(), [file(0, 'out/home-phone.png', true)], []);
  expect(single?.views).toBeUndefined();
  expect(single?.caption).toBe('Out/home phone');
  // "telephone" and "desktops2" are not viewport words; a non-image never is.
  const words = deliveryModel(
    task(),
    [file(0, 'telephone.png', true), file(1, 'mydesktops.png', true), file(2, 'desktop.txt')],
    [],
  );
  expect(words?.views).toBeUndefined();
  expect(words?.shot?.name).toBe('telephone.png');
});

test("a result without a picture says why, in the runner's words, and one with a picture does not", () => {
  const manifest = {
    summary: 'Verified change to acme/calc: add() adds.',
    done: ['verified: …', 'no screenshots: no page was named to look at'],
    notDone: [],
    confidence: 'high' as const,
    knownIssues: [],
  };
  const none = deliveryModel(task({ manifest }), [file(0, 'change.patch')], []);
  expect(none?.noPicture).toBe('no page was named to look at');
  expect(none?.diff?.name).toBe('change.patch');
  // The runner's screenshots win over a stale line, and a task that never says so claims nothing.
  const shot = deliveryModel(task({ manifest }), [file(0, 'viewport-desktop.png', true)], []);
  expect(shot?.noPicture).toBeUndefined();
  expect(deliveryModel(task(), [file(0, 'change.patch')], [])?.noPicture).toBeUndefined();
});
