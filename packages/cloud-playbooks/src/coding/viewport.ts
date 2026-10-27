import { z } from 'zod';
import { AGENT_READS_DIR } from './task.js';

/**
 * The viewport check: the runner, not the agent, looks at the page a change affects. The agent only
 * says how to start the app (`preview.json`, like `repro.json`); the runner starts it inside a check
 * of its own, opens it in a headless browser at desktop and phone width with the change and on the
 * base commit, and keeps the screenshots it took under names it chose. What the agent says it saw is
 * not read.
 *
 * The check is evidence, not a gate: the app runs in the same namespace as the browser, so the
 * repository's own code could in principle draw over a screenshot or forge the report line. A task
 * is never failed or held back by it; what it found is shown beside the change as what it is.
 */
export const PREVIEW_FILE = `${AGENT_READS_DIR}/preview.json`;

/** Where the capture writes, relative to the task directory; the runner reads only names it chose. */
export const VIEWPORT_DIR = `${AGENT_READS_DIR}/viewport`;

export const PreviewSchema = z
  .object({
    /** Starts the app from the repository root and keeps it running (a dev or preview server). */
    command: z.string().trim().min(1).max(2_000),
    /** The local port the app listens on (127.0.0.1). */
    port: z.number().int().min(1024).max(65_535),
    /** Pages to look at, as paths of that server. Default `/`. */
    paths: z
      .array(
        z
          .string()
          .max(200)
          .regex(
            /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/u,
            'a path starts with / and has no spaces',
          ),
      )
      .min(1)
      .max(3)
      .optional(),
  })
  .strict();

export type Preview = z.infer<typeof PreviewSchema>;

export const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800, scale: 1, mobile: false },
  { name: 'phone', width: 390, height: 844, scale: 2, mobile: true },
] as const;

export type ViewportName = (typeof VIEWPORTS)[number]['name'];

/** A screenshot's file name, chosen by the runner: the first page has the plain name. */
export function shotName(index: number, viewport: ViewportName): string {
  return index === 0 ? `viewport-${viewport}.png` : `viewport-${index + 1}-${viewport}.png`;
}

/** How long the app has to start listening, and the whole capture, in seconds. */
export const PREVIEW_START_SECONDS = 90;
export const VIEWPORT_TIMEOUT_SECONDS = 240;

const ReportPageSchema = z.object({
  path: z.string().max(200),
  viewport: z.enum(['desktop', 'phone']),
  file: z.string().max(80).optional(),
  status: z.number().int().optional(),
  error: z.string().max(300).optional(),
  overflowPx: z.number().int().min(0).max(1_000_000),
  smallControls: z.number().int().min(0).max(100_000),
  consoleErrors: z.array(z.string().max(300)).max(5),
});

const ReportSchema = z.union([
  z.object({ ok: z.literal(true), pages: z.array(ReportPageSchema).max(6) }),
  z.object({ ok: z.literal(false), reason: z.string().max(600) }),
]);

export type CaptureReport = z.infer<typeof ReportSchema>;
export type CapturedPage = z.infer<typeof ReportPageSchema>;

/** Reads the capture's last `MAKA_VIEWPORT` line from a check's output tail. */
export function parseCaptureReport(output: string): CaptureReport | undefined {
  const line = output
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith('MAKA_VIEWPORT '));
  if (line === undefined) return undefined;
  try {
    const parsed = ReportSchema.safeParse(JSON.parse(line.slice('MAKA_VIEWPORT '.length)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** One page at one size, as the record and the pull request read it. */
export interface ViewportPage {
  path: string;
  viewport: ViewportName;
  width: number;
  /** The artifact the screenshot was kept under, with its hash; absent when none was taken. */
  file?: string;
  sha256?: string;
  status?: number;
  error?: string;
  overflowPx: number;
  smallControls: number;
  consoleErrors: string[];
}

export interface ViewportPass {
  result: 'captured' | 'not_run';
  reason?: string;
  pages?: ViewportPage[];
}

/** `verification.viewport`: what the runner saw with the change, and on the base commit. */
export interface ViewportRecord {
  /** `not_declared`: the agent named no page, so there is no picture, and the record says so. */
  result: 'captured' | 'not_run' | 'not_declared';
  reason?: string;
  command?: string;
  port?: number;
  pages?: ViewportPage[];
  before?: ViewportPass;
}

/** The issues of one pass, in a few words each; empty when nothing was found. */
export function viewportIssues(pages: readonly ViewportPage[]): string[] {
  const issues: string[] = [];
  for (const page of pages) {
    const at = `${page.path} at ${page.width} px`;
    if (page.error) issues.push(`${at}: ${page.error}`);
    else if (page.status !== undefined && page.status >= 400)
      issues.push(`${at}: HTTP ${page.status}`);
    if (page.overflowPx > 0) issues.push(`${at}: ${page.overflowPx} px wider than the screen`);
    if (page.viewport === 'phone' && page.smallControls > 0)
      issues.push(`${at}: ${page.smallControls} control(s) under 44 px`);
    if (page.consoleErrors.length > 0)
      issues.push(`${at}: ${page.consoleErrors.length} console error(s)`);
  }
  return issues;
}

/** The largest screenshot kept; the server serves an artifact of at most 2 MiB. */
export const MAX_SHOT_BYTES = 2 * 1024 * 1024;

/** A screenshot the runner read back, under the artifact name it chose. */
export interface Shot {
  name: string;
  bytes: Buffer;
}

export function isPng(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/**
 * The size of a file the capture wrote, read as the agent's account (it can read nothing the agent
 * could not): MISSING, SYMLINK, NOTFILE or `SIZE <bytes>`.
 */
export const AGENT_FILE_SIZE_SCRIPT = `set -u
cd "$MAKA_DIR" 2>/dev/null || { echo MISSING; exit 0; }
f="$MAKA_FILE"
if [ -L "$f" ]; then echo SYMLINK; exit 0; fi
if [ ! -e "$f" ]; then echo MISSING; exit 0; fi
if [ ! -f "$f" ]; then echo NOTFILE; exit 0; fi
echo "SIZE $(stat -c %s -- "$f")"
`;

/** One chunk of that file: base64 of \`$MAKA_LEN\` bytes from \`$MAKA_OFF\`. */
export const AGENT_FILE_CHUNK_SCRIPT = `set -u
cd "$MAKA_DIR" || exit 1
[ -f "$MAKA_FILE" ] && [ ! -L "$MAKA_FILE" ] || exit 1
tail -c +$((MAKA_OFF + 1)) -- "$MAKA_FILE" | head -c "$MAKA_LEN" | base64 -w0
`;

const shq = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The check's command: starts the app in the background, waits for its port, then runs the capture.
 * `label` is `after` or `before`, the folder the screenshots go to under `VIEWPORT_DIR`. The check
 * runs from the workspace, so the task directory is its parent.
 */
export function captureCommand(preview: Preview, label: 'after' | 'before'): string {
  const out = `../${VIEWPORT_DIR}/${label}`;
  const paths = JSON.stringify(preview.paths ?? ['/']);
  const script = Buffer.from(CAPTURE_JS, 'utf8').toString('base64');
  return [
    'set -u',
    'report() { printf "\\nMAKA_VIEWPORT %s\\n" "$1"; }',
    't=$(mktemp -d) || { report \'{"ok":false,"reason":"no temporary directory"}\'; exit 0; }',
    `printf %s ${shq(script)} | base64 -d > "$t/capture.mjs"`,
    `rm -rf -- ${shq(out)} && mkdir -p -- ${shq(out)}`,
    `bash -c ${shq(preview.command)} > "$t/preview.log" 2>&1 < /dev/null &`,
    'app=$!',
    'up=0',
    `for _ in $(seq 1 ${PREVIEW_START_SECONDS}); do`,
    `  if (exec 3<>/dev/tcp/127.0.0.1/${preview.port}) 2>/dev/null; then up=1; break; fi`,
    '  kill -0 "$app" 2>/dev/null || break',
    '  sleep 1',
    'done',
    'if [ "$up" != 1 ]; then',
    '  tail -n 20 "$t/preview.log"',
    `  if kill -0 "$app" 2>/dev/null; then report '{"ok":false,"reason":"the preview command did not listen on port ${preview.port} within ${PREVIEW_START_SECONDS} s"}';`,
    `  else report '{"ok":false,"reason":"the preview command exited before it listened on port ${preview.port}"}'; fi`,
    '  exit 0',
    'fi',
    `if ! command -v node > /dev/null 2>&1; then report '{"ok":false,"reason":"node is not installed in the sandbox"}'; exit 0; fi`,
    `node "$t/capture.mjs" ${shq(out)} ${preview.port} ${shq(paths)}`,
  ].join('\n');
}

/**
 * The capture, run with node in the check: it drives a headless Chromium over the DevTools protocol
 * (node's own WebSocket, no package), and prints one `MAKA_VIEWPORT` JSON line. Kept free of
 * backticks and template placeholders: it is shipped as text.
 */
export const CAPTURE_JS = String.raw`
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const [out, port, pathsJson] = process.argv.slice(2);
const paths = JSON.parse(pathsJson);
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800, scale: 1, mobile: false },
  { name: 'phone', width: 390, height: 844, scale: 2, mobile: true },
];
const report = (value) => process.stdout.write('\nMAKA_VIEWPORT ' + JSON.stringify(value) + '\n');
const clip = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '\u2026' : flat;
};
let chrome;
let profile;
const finish = (value) => {
  report(value);
  try { chrome?.kill('SIGKILL'); } catch {}
  try { if (profile) rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
};
if (typeof WebSocket !== 'function') {
  finish({ ok: false, reason: 'node ' + process.version + ' has no WebSocket; the viewport check needs node 22 or later' });
}
const NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'headless_shell'];
let browser;
for (const dir of (process.env.PATH || '').split(delimiter)) {
  if (!dir) continue;
  browser = NAMES.map((name) => join(dir, name)).find((path) => existsSync(path));
  if (browser) break;
}
if (!browser) finish({ ok: false, reason: 'no headless browser (chromium or chrome) on the sandbox PATH' });

profile = mkdtempSync(join(tmpdir(), 'maka-viewport-'));
chrome = spawn(browser, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.on('error', (error) => finish({ ok: false, reason: 'the browser could not start: ' + clip(error.message, 200) }));

const wsUrl = await new Promise((resolve) => {
  let seen = '';
  const timer = setTimeout(() => resolve(undefined), 30000);
  chrome.stderr.on('data', (chunk) => {
    seen = (seen + chunk).slice(-8192);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  chrome.on('exit', () => { clearTimeout(timer); resolve(undefined); });
});
if (!wsUrl) finish({ ok: false, reason: 'the browser did not open its DevTools port within 30 s' });

const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('could not connect to the browser')), { once: true });
}).catch((error) => finish({ ok: false, reason: error.message }));

let nextId = 0;
const pending = new Map();
const listeners = new Set();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  } else {
    for (const listener of listeners) listener(message);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const waitFor = (method, sessionId, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => { listeners.delete(listener); resolve(false); }, ms);
    const listener = (message) => {
      if (message.method === method && message.sessionId === sessionId) {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(true);
      }
    };
    listeners.add(listener);
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MEASURE = '(() => {' +
  'const doc = document.documentElement;' +
  'const overflow = Math.max(0, Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0) - doc.clientWidth);' +
  'let small = 0;' +
  'for (const el of document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[onclick]")) {' +
  '  const style = getComputedStyle(el);' +
  '  if (style.visibility === "hidden" || style.display === "none" || style.display === "inline") continue;' +
  '  const rect = el.getBoundingClientRect();' +
  '  if (rect.width === 0 || rect.height === 0) continue;' +
  '  if (rect.width < 44 || rect.height < 44) small++;' +
  '}' +
  'return { overflow: Math.round(overflow), small };' +
  '})()';

const pages = [];
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  let errors = [];
  let status;
  listeners.add((message) => {
    if (message.sessionId !== sessionId) return;
    const params = message.params || {};
    if (message.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      errors.push((params.args || []).map((arg) => arg.description ?? arg.value ?? '').join(' '));
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      errors.push(details.exception?.description ?? details.text ?? 'an uncaught exception');
    } else if (message.method === 'Log.entryAdded' && params.entry?.level === 'error' && !/\/favicon\.ico$/.test(params.entry.url || '')) {
      errors.push(params.entry.text ?? 'an error');
    } else if (message.method === 'Network.responseReceived' && params.type === 'Document') {
      status = params.response?.status;
    }
  });
  for (const viewport of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.mobile,
    }, sessionId);
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile }, sessionId);
    for (const [index, path] of paths.entries()) {
      errors = [];
      status = undefined;
      const page = { path, viewport: viewport.name, overflowPx: 0, smallControls: 0, consoleErrors: [] };
      const loaded = waitFor('Page.loadEventFired', sessionId, 20000);
      const nav = await send('Page.navigate', { url: 'http://127.0.0.1:' + port + path }, sessionId);
      if (nav.errorText) {
        page.error = clip('the page did not open: ' + nav.errorText, 300);
      } else {
        if (!(await loaded)) page.error = 'the page did not finish loading within 20 s';
        await sleep(800);
        const measured = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true }, sessionId);
        const value = measured.result?.value || {};
        page.overflowPx = Number.isInteger(value.overflow) ? Math.min(value.overflow, 1000000) : 0;
        page.smallControls = Number.isInteger(value.small) ? Math.min(value.small, 100000) : 0;
        const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        const file = (index === 0 ? 'viewport-' : 'viewport-' + (index + 1) + '-') + viewport.name + '.png';
        writeFileSync(join(out, file), Buffer.from(shot.data, 'base64'));
        page.file = file;
      }
      if (status !== undefined) page.status = status;
      page.consoleErrors = errors.slice(0, 5).map((text) => clip(text, 300));
      pages.push(page);
    }
  }
} catch (error) {
  finish({ ok: false, reason: clip('the browser failed: ' + error.message, 300) });
}
finish({ ok: true, pages });
`;
