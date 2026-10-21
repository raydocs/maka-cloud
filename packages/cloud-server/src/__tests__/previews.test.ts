import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db.js';
import { plainLine, readPageMeta } from '../page-meta.js';
import { sniffImage } from '../image-type.js';
import {
  MAX_OPENED_PAGES,
  OpenedPages,
  PreviewBusy,
  PreviewService,
  type SafeFetch,
} from '../previews.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);

test('image bytes are named by their own first bytes, and SVG and the rest are not images', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('GIF87a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')), undefined);
  assert.equal(
    sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    undefined,
  );
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg/>')), undefined);
  assert.equal(sniffImage(Buffer.from('<html>')), undefined);
  assert.equal(sniffImage(Buffer.alloc(0)), undefined);
  assert.equal(sniffImage(Buffer.from([0x89, 0x50])), undefined);
});

const BASE = new URL('https://docs.example/guide/start');

test('a page names its title and image; the title is one short printable line', () => {
  const meta = readPageMeta(
    `<!doctype html><html><head>
      <title>  Plain &amp; simple
        title </title>
      <meta property="og:title" content="The &quot;real&quot; title &#169; &#x41;">
      <meta property="og:image" content="/img/card.png?v=2&amp;w=1">
    </head><body><meta property="og:title" content="late"></body></html>`,
    BASE,
  );
  assert.deepEqual(meta, {
    title: 'The "real" title © A',
    imageUrl: 'https://docs.example/img/card.png?v=2&w=1',
  });
  assert.deepEqual(readPageMeta('<title>Only a title</title>', BASE), { title: 'Only a title' });
  assert.deepEqual(readPageMeta('<html><p>nothing here</p>', BASE), {});
});

test('what a page says cannot make an unsafe image address or hide inside markup that is not markup', () => {
  const image = (value: string) =>
    readPageMeta(`<meta property="og:image" content="${value}">`, BASE).imageUrl;
  for (const bad of [
    'http://docs.example/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'https://127.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://user:pw@docs.example/a.png',
    'https://docs.example:8443/a.png',
    'https://intranet/a.png',
    '//localhost/a.png',
    '',
  ]) {
    assert.equal(image(bad), undefined, bad);
  }
  assert.equal(image('//cdn.example/a.png'), 'https://cdn.example/a.png');
  assert.equal(image('a.png'), 'https://docs.example/guide/a.png');
  // A comment, a script and a style are not the page's own tags.
  const hidden = readPageMeta(
    `<head><!-- <meta property="og:image" content="https://evil.example/x.png"> -->
     <script>var s = '<meta property="og:image" content="https://evil.example/y.png">';</script>
     <style>/* <title>css</title> */</style><title>Real</title></head>`,
    BASE,
  );
  assert.deepEqual(hidden, { title: 'Real' });
});

test('a title is cut, cleaned of invisible and direction characters, and never names a vendor', () => {
  assert.equal(plainLine('a\u202Eb\u200Bc\u0000d\ne\tf  g'), 'abc d e f g');
  assert.equal(plainLine('\u202E\u200B  \n'), undefined);
  assert.equal(plainLine('x'.repeat(500))?.length, 140);
  assert.ok(plainLine('x'.repeat(500))?.endsWith('…'));
  assert.equal(
    plainLine('Using Claude and GPT with Gemini'),
    'Using assistant and assistant with assistant',
  );
  assert.equal(plainLine('&#0; &#x110000; &#9999999; ok'), 'ok');
  // Work on a hostile page stays bounded.
  const started = Date.now();
  readPageMeta(`<meta ${'a="b" '.repeat(50_000)}>${'<title>'.repeat(20_000)}`, BASE);
  readPageMeta(`<head>${'<!--'.repeat(30_000)}`, BASE);
  assert.ok(Date.now() - started < 2000);
});

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) db.exec(step);
  return db;
}

test('the log keeps public https pages once, in order, at most twenty a task, and nothing else', () => {
  const db = database();
  let now = 1000;
  const log = new OpenedPages(db, () => now++);
  assert.equal(
    log.record('tsk_1', [
      { url: 'https://docs.example/a#section' },
      { url: 'https://docs.example/a#other' },
      { url: 'https://alt.example/b', label: 'alternative' },
      { url: 'http://insecure.example/' },
      { url: 'https://127.0.0.1/' },
      { url: 'https://user:pw@docs.example/c' },
      { url: 'https://docs.example:8443/' },
      { url: 'javascript:alert(1)' },
      { url: 'https://docs.example/d', label: 'a different word' as never },
      { url: 'not a url' },
    ]),
    2,
  );
  assert.deepEqual(log.list('tsk_1'), [
    { index: 0, url: 'https://docs.example/a', label: 'source' },
    { index: 1, url: 'https://alt.example/b', label: 'alternative' },
  ]);
  // A second batch adds only what is new, and the indexes stay put.
  assert.equal(
    log.record('tsk_1', [{ url: 'https://alt.example/b' }, { url: 'https://new.example/' }]),
    1,
  );
  assert.deepEqual(
    log.list('tsk_1').map((p) => [p.index, p.url]),
    [
      [0, 'https://docs.example/a'],
      [1, 'https://alt.example/b'],
      [2, 'https://new.example/'],
    ],
  );
  assert.deepEqual(log.list('tsk_2'), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ url: `https://site${i}.example/` }));
  assert.equal(log.record('tsk_3', many), MAX_OPENED_PAGES);
  assert.equal(log.record('tsk_3', [{ url: 'https://one-more.example/' }]), 0);
  assert.equal(log.list('tsk_3').length, MAX_OPENED_PAGES);
  // The same page may be on another task's list.
  assert.equal(log.record('tsk_4', [{ url: 'https://site0.example/' }]), 1);
});

test('a batch that fails halfway keeps none of it', () => {
  const db = database();
  const log = new OpenedPages(db);
  db.exec('DROP TABLE opened_pages');
  assert.throws(() => log.record('tsk_1', [{ url: 'https://a.example/' }]));
  // The transaction was rolled back, so the connection is usable again.
  db.exec(MIGRATIONS.at(-1) ?? '');
  assert.equal(log.record('tsk_1', [{ url: 'https://a.example/' }]), 1);
});

// The preview service, with a fetcher the test controls.

const PAGE = `<head><title>Guide</title><meta property="og:image" content="https://cdn.example/card.png"></head>`;

function page(body = PAGE) {
  return {
    ok: true as const,
    url: 'https://docs.example/a',
    contentType: 'text/html',
    body: Buffer.from(body),
  };
}
function image(body: Buffer, contentType = 'image/png') {
  return { ok: true as const, url: 'https://cdn.example/card.png', contentType, body };
}

function service(
  fetchImpl: SafeFetch,
  options: Partial<ConstructorParameters<typeof PreviewService>[0]> = {},
) {
  const clock = { now: 1_000_000 };
  const calls: string[] = [];
  const counted: SafeFetch = (url, request) => {
    calls.push(url);
    return fetchImpl(url, request);
  };
  return {
    svc: new PreviewService({ fetch: counted, now: () => clock.now, ...options }),
    calls,
    clock,
  };
}

const byUrl =
  (
    answers: Record<
      string,
      ReturnType<typeof page> | ReturnType<typeof image> | { ok: false; reason: 'network' }
    >,
  ): SafeFetch =>
  async (url) =>
    answers[url] ?? { ok: false, reason: 'network' };

test('a preview is the title and the page’s own image, fetched here and kept', async () => {
  const { svc, calls } = service(
    byUrl({ 'https://docs.example/a': page(), 'https://cdn.example/card.png': image(PNG) }),
  );
  const first = await svc.get('https://docs.example/a');
  assert.equal(first.site, 'docs.example');
  assert.equal(first.title, 'Guide');
  assert.equal(first.image?.type, 'image/png');
  assert.equal(first.image?.bytes.length, PNG.length);
  assert.equal(await svc.get('https://docs.example/a'), first);
  assert.deepEqual(calls, ['https://docs.example/a', 'https://cdn.example/card.png']);
  assert.equal(svc.held(), PNG.length);
  assert.equal(svc.inFlight(), 0);
});

test('an image is dropped unless its bytes are an image of the type the site declared', async () => {
  for (const [bytes, declared] of [
    [JPEG, 'image/png'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'],
    [Buffer.from('<html>not an image</html>'), 'image/jpeg'],
  ] as const) {
    const { svc } = service(
      byUrl({
        'https://docs.example/a': page(),
        'https://cdn.example/card.png': image(bytes as Buffer, declared),
      }),
    );
    const preview = await svc.get('https://docs.example/a');
    assert.equal(preview.title, 'Guide');
    assert.equal(preview.image, undefined);
  }
  const refused = service(byUrl({ 'https://docs.example/a': page() }));
  assert.equal((await refused.svc.get('https://docs.example/a')).image, undefined);
});

test('the page is asked for its start only, and the image with the image limits', async () => {
  const seen: Array<{
    url: string;
    accept: readonly string[];
    maxBytes: number;
    startOnly?: boolean;
  }> = [];
  const { svc } = service(async (url, request) => {
    seen.push({
      url,
      accept: request.accept,
      maxBytes: request.maxBytes,
      ...(request.startOnly ? { startOnly: true } : {}),
    });
    return url.endsWith('/a') ? page() : image(PNG);
  });
  await svc.get('https://docs.example/a');
  assert.deepEqual(seen[0], {
    url: 'https://docs.example/a',
    accept: ['text/html', 'application/xhtml+xml'],
    maxBytes: 512 * 1024,
    startOnly: true,
  });
  assert.deepEqual(seen[1]?.accept, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  assert.equal(seen[1]?.maxBytes, 1024 * 1024);
  assert.equal(seen[1]?.startOnly, undefined);
});

test('a page that cannot be read is a card without a preview, and a dead site is not asked again at once', async () => {
  let up = false;
  const { svc, calls, clock } = service(
    async (url) => (up ? page('<title>Back</title>') : { ok: false, reason: 'network' }),
    { failureTtlMs: 60_000, ttlMs: 3_600_000 },
  );
  assert.deepEqual(await svc.get('https://docs.example/a'), { site: 'docs.example' });
  assert.deepEqual(await svc.get('https://docs.example/a'), { site: 'docs.example' });
  assert.equal(calls.length, 1);
  up = true;
  clock.now += 61_000;
  assert.equal((await svc.get('https://docs.example/a')).title, 'Back');
  assert.equal(calls.length, 2);
  clock.now += 3_000_000;
  assert.equal((await svc.get('https://docs.example/a')).title, 'Back');
  assert.equal(calls.length, 2);
  clock.now += 700_000;
  await svc.get('https://docs.example/a');
  assert.equal(calls.length, 3);
});

test('a fetcher that throws is a card without a preview and frees its slot', async () => {
  const { svc } = service(
    async () => {
      throw new Error('boom');
    },
    { maxInFlight: 1 },
  );
  assert.deepEqual(await svc.get('https://docs.example/a'), { site: 'docs.example' });
  assert.equal(svc.inFlight(), 0);
  assert.deepEqual(await svc.get('https://docs.example/b'), { site: 'docs.example' });
});

test('the cache is bounded by entries and by image bytes, oldest out first', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(1000)]);
  const answers: Record<string, ReturnType<typeof page> | ReturnType<typeof image>> = {
    'https://cdn.example/card.png': image(big),
  };
  for (const n of [1, 2, 3, 4]) answers[`https://site${n}.example/`] = page();
  const { svc, calls } = service(byUrl(answers), { maxEntries: 3, maxImageBytes: big.length * 2 });
  for (const n of [1, 2, 3]) await svc.get(`https://site${n}.example/`);
  assert.ok(svc.held() <= big.length * 2);
  const before = calls.length;
  await svc.get('https://site3.example/');
  assert.equal(calls.length, before, 'the newest is still cached');
  await svc.get('https://site1.example/');
  assert.ok(calls.length > before, 'the oldest was dropped');
  for (const n of [1, 2, 3, 4]) await svc.get(`https://site${n}.example/`);
  assert.ok(svc.held() <= big.length * 2);

  // An image bigger than the whole budget is not kept, and the title still is.
  const tiny = service(
    byUrl({ 'https://docs.example/a': page(), 'https://cdn.example/card.png': image(big) }),
    { maxImageBytes: 10 },
  );
  const preview = await tiny.svc.get('https://docs.example/a');
  assert.equal(preview.title, 'Guide');
  assert.equal(preview.image, undefined);
  assert.equal(tiny.svc.held(), 0);
});

test('two askers for one page share one fetch; fetches in flight are capped and every slot is returned', async () => {
  const gates = new Map<string, (value: ReturnType<typeof page>) => void>();
  const { svc, calls } = service(
    (url) => new Promise((resolve) => gates.set(url, (value) => resolve(value))),
    { maxInFlight: 2 },
  );
  const a1 = svc.get('https://a.example/');
  const a2 = svc.get('https://a.example/');
  const b = svc.get('https://b.example/');
  assert.equal(svc.inFlight(), 2);
  assert.deepEqual(calls, ['https://a.example/', 'https://b.example/']);
  await assert.rejects(svc.get('https://c.example/'), PreviewBusy);
  // A page already in flight can still be joined when the cap is reached.
  const a3 = svc.get('https://a.example/');
  gates.get('https://a.example/')?.(page('<title>A</title>'));
  const [r1, r2, r3] = await Promise.all([a1, a2, a3]);
  assert.equal(r1, r2);
  assert.equal(r1, r3);
  assert.equal(svc.inFlight(), 1);
  const c = svc.get('https://c.example/');
  gates.get('https://b.example/')?.(page('<title>B</title>'));
  gates.get('https://c.example/')?.(page('<title>C</title>'));
  assert.equal((await b).title, 'B');
  assert.equal((await c).title, 'C');
  assert.equal(svc.inFlight(), 0);
});
