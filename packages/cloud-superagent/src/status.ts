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

export const PROGRESS_HTTP_PATH = '/v1/superagent/progress';

export function handleProgressRequest(input: {
  method: string;
  url: string;
  accept?: string;
  snapshot: StatusSnapshot;
}): { status: number; headers: Record<string, string>; body: string } {
  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { allow: 'GET, HEAD' }, body: 'method not allowed' };
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
): Promise<void> {
  const url = req.url ?? PROGRESS_HTTP_PATH;
  const accept = headerOf(req, 'accept');
  const answered = handleProgressRequest({
    method: req.method ?? 'GET',
    url,
    accept,
    snapshot,
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

  const close: Array<() => void> = [];
  let read: () => StatusSnapshot;
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
    return listenStatus(port, read, close);
  }

  const snapshot = read();
  write(json ? JSON.stringify(snapshot) : formatStatusText(snapshot));
  close.forEach((fn) => fn());
  return 0;
}

async function listenStatus(
  port: number,
  read: () => StatusSnapshot,
  close: Array<() => void>,
): Promise<number> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] !== PROGRESS_HTTP_PATH && req.url !== '/') {
      res.writeHead(404).end('not found');
      return;
    }
    void writeProgressResponse(req, res, read());
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
