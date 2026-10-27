import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as boat from './boat.ts';
import { RepoNotes } from './notes.ts';
import { repoSlug, runTask, type Task } from './pipeline.ts';

/**
 * The demo server: one page, the task API and a live stream. Tasks are kept in
 * ~/.maka-demo/tasks.json. Anyone who can reach the port could spend the owner's subscriptions,
 * so every API call needs the session cookie from signing in with the access key printed at start.
 */

const PORT = Number(process.env.MAKA_DEMO_PORT ?? 4317);
const HOST = process.env.MAKA_DEMO_HOST ?? '127.0.0.1';
const DATA = join(homedir(), '.maka-demo');
const STORE = join(DATA, 'tasks.json');
const KEY = process.env.MAKA_DEMO_KEY ?? loadKey();
const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');

mkdirSync(DATA, { recursive: true, mode: 0o700 });
/** What earlier tasks learned about each repository, read by the next task there. */
const notes = new RepoNotes(join(DATA, 'notes.json'));
const tasks = new Map<string, Task>();
const waiting = new Map<string, (answers: string[]) => void>();
const stopping = new Set<string>();
const streams = new Set<ServerResponse>();

function loadKey(): string {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const file = join(DATA, 'key');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    const key = randomBytes(18).toString('base64url');
    writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
}

function load(): void {
  try {
    for (const task of JSON.parse(readFileSync(STORE, 'utf8')) as Task[]) {
      // A run belongs to the process that started it; after a restart it cannot be followed.
      if (!['done', 'failed', 'stopped'].includes(task.state)) {
        task.state = 'failed';
        task.error = '服务重启了，这个任务被中断。改动还在云端电脑里，可以重新开始。';
        task.now = '没做完';
      }
      task.activity ??= [];
      tasks.set(task.id, task);
    }
  } catch {
    // No tasks yet.
  }
}

let saveTimer: NodeJS.Timeout | undefined;
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(DATA, { recursive: true, mode: 0o700 });
    writeFileSync(`${STORE}.tmp`, JSON.stringify([...tasks.values()], null, 1));
    renameSync(`${STORE}.tmp`, STORE);
  }, 200);
}

/** What the page gets live: everything but the diff, which it asks for when it shows it. */
function view(task: Task): Omit<Task, 'diff'> & { diffFiles: number } {
  const { diff, ...rest } = task;
  return { ...rest, diffFiles: diff?.length ?? 0 };
}

function broadcast(task: Task): void {
  const line = `data: ${JSON.stringify(view(task))}\n\n`;
  for (const res of streams) res.write(line);
  save();
}

function start(repo: string, goal: string): Task {
  const id = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const task: Task = {
    id,
    repo: repoSlug(repo),
    goal,
    createdAt: Date.now(),
    state: 'preparing',
    now: '排队中',
    log: [],
    activity: [],
  };
  tasks.set(id, task);
  broadcast(task);
  void runTask(task, {
    changed: broadcast,
    answers: (t) =>
      new Promise((resolve) => {
        waiting.set(t.id, resolve);
      }),
    stopped: (t) => stopping.has(t.id),
    notes: (repo) => notes.of(repo),
    learn: (repo, lines) => notes.learn(repo, lines),
  });
  return task;
}

const SESSION = createHmac('sha256', KEY).update('maka-demo-session').digest('base64url');
const COOKIE = 'maka_demo';

function same(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieOf(req: IncomingMessage): string {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return '';
}

/** The session cookie set at sign-in, or the access key itself (for scripts). */
function authorized(req: IncomingMessage): boolean {
  return same(cookieOf(req), SESSION) || same(String(req.headers['x-maka-key'] ?? ''), KEY);
}

/** Behind boat's https URL the cookie is Secure; on localhost it cannot be. */
function sessionCookie(req: IncomingMessage, value: string, maxAge: number): string {
  const secure =
    req.headers['x-forwarded-proto'] === 'https' || process.env.MAKA_DEMO_SECURE === '1';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Wrong keys slow down: at most 10 tries a minute from one address. */
const tries = new Map<string, { count: number; since: number }>();
function tooMany(req: IncomingMessage): boolean {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
    .split(',')[0]!
    .trim();
  const now = Date.now();
  const entry = tries.get(ip);
  if (!entry || now - entry.since > 60_000) {
    tries.set(ip, { count: 1, since: now });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求太大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://demo');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(PAGE));
      return;
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (tooMany(req)) return send(res, 429, { error: '试得太多了，一分钟后再试' });
      const input = await body(req);
      if (!same(String(input.key ?? '').trim(), KEY)) return send(res, 401, { error: '口令不对' });
      res.setHeader('set-cookie', sessionCookie(req, SESSION, 30 * 24 * 3600));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      res.setHeader('set-cookie', sessionCookie(req, '', 0));
      return send(res, 200, { ok: true });
    }
    if (!authorized(req)) return send(res, 401, { error: '需要登录' });

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': hello\n\n');
      streams.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        streams.delete(res);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      return send(
        res,
        200,
        [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map(view),
      );
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const input = await body(req);
      const repo = String(input.repo ?? '').trim();
      const goal = String(input.goal ?? '').trim();
      if (!repo || !goal) return send(res, 400, { error: '需要仓库和需求' });
      return send(res, 201, view(start(repo, goal)));
    }
    // The owner can see what Maka keeps about a repository, and clear it.
    if (url.pathname === '/api/notes' && (req.method === 'GET' || req.method === 'DELETE')) {
      let repo: string;
      try {
        repo = repoSlug(url.searchParams.get('repo') ?? '');
      } catch {
        return send(res, 400, { error: '看不懂这个仓库' });
      }
      if (req.method === 'DELETE') notes.forget(repo);
      return send(res, 200, { repo, notes: notes.of(repo) });
    }
    const read = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/(diff|desktop)$/u);
    if (read && req.method === 'GET') {
      const task = tasks.get(read[1]!);
      if (!task) return send(res, 404, { error: 'not found' });
      if (read[2] === 'diff') return send(res, 200, task.diff ?? []);
      const running = !['done', 'failed', 'stopped'].includes(task.state);
      if (!task.sandboxId || !running) return send(res, 409, { error: '云端电脑已经关了' });
      const desktop = await boat.desktopUrl(task.sandboxId);
      if (!desktop) return send(res, 502, { error: '画面暂时打不开' });
      return send(res, 200, { url: desktop });
    }
    const match = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/(answers|stop|steer)$/u);
    const task = match ? tasks.get(match[1]!) : undefined;
    if (!match || !task || req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const input = await body(req);
    if (match[2] === 'answers') {
      const resolve = waiting.get(task.id);
      if (!resolve) return send(res, 409, { error: '这个任务现在不在等你回答' });
      waiting.delete(task.id);
      resolve(Array.isArray(input.answers) ? input.answers.map(String) : []);
      return send(res, 200, { ok: true });
    }
    if (match[2] === 'stop') {
      stopping.add(task.id);
      waiting.get(task.id)?.([]);
      return send(res, 200, { ok: true });
    }
    const text = String(input.text ?? '').trim();
    if (!text || !task.sandboxId || !task.builderConvo) {
      return send(res, 409, { error: '现在还不能补充要求' });
    }
    await boat.steer(task.sandboxId, task.builderConvo, text);
    task.log.push({ at: Date.now(), kind: 'note', text: `你补充了：${text}` });
    broadcast(task);
    return send(res, 200, { ok: true });
  })().catch((error: unknown) => {
    if (!res.headersSent)
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

load();
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Maka demo: http://${shown}:${PORT}/  (access key: ${KEY})`);
});
