import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  encodeProgressSse,
  formatStatusText,
  wantsProgressSse,
  type StatusSnapshot,
} from './progress.js';
import { Superagent } from './runtime.js';
import { SqliteSuperagentStore } from './sqlite-store.js';
import { formatWatchdogAnswer, type WatchdogAnswer } from './watchdog-query.js';

export const PROGRESS_HTTP_PATH = '/v1/superagent/progress';

export interface ProgressHandlers {
  ask?: (text: string) => Promise<WatchdogAnswer> | WatchdogAnswer;
  instruct?: (text: string) => Promise<WatchdogAnswer> | WatchdogAnswer;
}

export function handleProgressRequest(input: {
  method: string;
  url: string;
  accept?: string;
  snapshot: StatusSnapshot;
}): { status: number; headers: Record<string, string>; body: string } {
  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return { status: 405, headers: { allow: 'GET, HEAD, POST' }, body: 'method not allowed' };
  }
  if (wantsProgressSse(input.url, input.accept)) {
    const body = method === 'HEAD' ? '' : encodeProgressSse(input.snapshot);
    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      },
      body,
    };
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: method === 'HEAD' ? '' : JSON.stringify(input.snapshot),
  };
}

export async function writeProgressResponse(
  req: IncomingMessage,
  res: ServerResponse,
  snapshot: StatusSnapshot,
  handlers: ProgressHandlers = {},
): Promise<void> {
  const url = req.url ?? PROGRESS_HTTP_PATH;
  const accept = headerOf(req, 'accept');
  const method = req.method ?? 'GET';
  const snapshotWithAsk = await attachWatchdog(method, url, snapshot, handlers, req);
  const answered = handleProgressRequest({
    method: method === 'POST' ? 'GET' : method,
    url,
    accept,
    snapshot: snapshotWithAsk,
  });
  res.writeHead(answered.status, answered.headers);
  res.end(answered.body);
}

export interface StatusCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  snapshot?: StatusSnapshot;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  listen?: (port: number, handler: typeof writeProgressResponse) => Promise<number>;
  askWatchdog?: (
    tenantId: string | undefined,
    text: string,
  ) => Promise<WatchdogAnswer> | WatchdogAnswer;
  instructWatchdog?: (
    tenantId: string | undefined,
    text: string,
  ) => Promise<WatchdogAnswer> | WatchdogAnswer;
}

export async function runStatusCli(options: StatusCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const write = options.stdout ?? ((text) => console.log(text));
  const error = options.stderr ?? ((text) => console.error(text));
  const json = hasFlag(argv, '--json');
  const listen = flag(argv, '--listen');
  const tenant = flag(argv, '--tenant') ?? env.MAKA_CLOUD_SUPERAGENT_TENANT?.trim();
  const dbPath = flag(argv, '--db') ?? env.MAKA_CLOUD_SUPERAGENT_DB?.trim() ?? 'superagent.db';
  const askText = flag(argv, '--ask');
  const instructText =
    flag(argv, '--instruct') ??
    commandFlag(argv, '--nudge', 'nudge') ??
    commandFlag(argv, '--pause', 'pause') ??
    commandFlag(argv, '--resume', 'resume') ??
    commandFlag(argv, '--cancel', 'cancel') ??
    (hasFlag(argv, '--stuck-check') ? 'stuck-check' : undefined);

  const close: Array<() => void> = [];
  let read: () => StatusSnapshot;
  let ask = options.askWatchdog;
  let instruct = options.instructWatchdog;
  if (options.snapshot) {
    const frozen = options.snapshot;
    read = () => frozen;
  } else {
    if (!existsSync(dbPath)) {
      error(`status: no superagent database at ${dbPath}`);
      return 2;
    }
    const store = SqliteSuperagentStore.open(dbPath);
    close.push(() => store.close());
    const agent = new Superagent({ store });
    close.push(() => agent.close());
    read = () => (tenant ? agent.statusSnapshot(tenant) : agent.statusSnapshot());
    ask ??= (owner, text) => agent.askWatchdog(owner ?? tenant ?? '', text);
    instruct ??= (owner, text) => agent.instructWatchdog(owner ?? tenant ?? '', text);
  }

  if (listen !== undefined) {
    const port = listen === '' || listen === 'true' ? 8788 : Number(listen);
    if (!Number.isInteger(port) || port <= 0) {
      error('usage: status --listen [port]');
      close.forEach((fn) => fn());
      return 2;
    }
    if (options.listen) {
      const code = await options.listen(port, writeProgressResponse);
      close.forEach((fn) => fn());
      return code;
    }
    return listenStatus(port, read, close, {
      ask: ask ? (text) => ask(tenant, text) : undefined,
      instruct: instruct ? (text) => instruct(tenant, text) : undefined,
    });
  }

  const snapshot = read();
  let watchdog: WatchdogAnswer | undefined;
  if (instructText !== undefined && instructText !== '') {
    if (!instruct) {
      error('status: --instruct needs a Super-agent store or instructWatchdog hook');
      close.forEach((fn) => fn());
      return 2;
    }
    watchdog = await instruct(tenant, instructText);
  } else if (askText !== undefined && askText !== '') {
    if (!ask) {
      error('status: --ask needs a Super-agent store or askWatchdog hook');
      close.forEach((fn) => fn());
      return 2;
    }
    watchdog = await ask(tenant, askText);
  }
  const payload = watchdog ? { ...snapshot, watchdog } : snapshot;
  if (json) write(JSON.stringify(payload));
  else {
    write(formatStatusText(snapshot));
    if (watchdog) write(formatWatchdogAnswer(watchdog));
  }
  close.forEach((fn) => fn());
  return 0;
}

async function listenStatus(
  port: number,
  read: () => StatusSnapshot,
  close: Array<() => void>,
  handlers: ProgressHandlers,
): Promise<number> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] !== PROGRESS_HTTP_PATH && req.url !== '/') {
      res.writeHead(404).end('not found');
      return;
    }
    void writeProgressResponse(req, res, read(), handlers);
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`progress on http://127.0.0.1:${port}${PROGRESS_HTTP_PATH}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.close(() => {
        close.forEach((fn) => fn());
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function attachWatchdog(
  method: string,
  url: string,
  snapshot: StatusSnapshot,
  handlers: ProgressHandlers,
  req: IncomingMessage,
): Promise<StatusSnapshot> {
  const verb = method.toUpperCase();
  if (verb === 'POST') {
    const body = await readBody(req);
    const parsed = parseProgressBody(body);
    if (parsed.instruct && handlers.instruct) {
      return { ...snapshot, watchdog: await handlers.instruct(parsed.instruct) };
    }
    if (parsed.ask && handlers.ask) {
      return { ...snapshot, watchdog: await handlers.ask(parsed.ask) };
    }
    return snapshot;
  }
  const ask = askParam(url);
  if (ask && handlers.ask) return { ...snapshot, watchdog: await handlers.ask(ask) };
  return snapshot;
}

function parseProgressBody(raw: string): { ask?: string; instruct?: string } {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as { ask?: unknown; instruct?: unknown };
    return {
      ...(typeof parsed.ask === 'string' ? { ask: parsed.ask } : {}),
      ...(typeof parsed.instruct === 'string' ? { instruct: parsed.instruct } : {}),
    };
  } catch {
    return {};
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function askParam(url: string): string | undefined {
  try {
    const parsed = new URL(url, 'http://superagent.local');
    return parsed.searchParams.get('ask') ?? undefined;
  } catch {
    return undefined;
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) return '';
  return next;
}

function commandFlag(argv: string[], name: string, verb: string): string | undefined {
  const value = flag(argv, name);
  if (value === undefined) return undefined;
  return value ? `${verb} ${value}` : verb;
}
