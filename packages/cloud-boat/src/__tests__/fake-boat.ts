import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';

/**
 * A fake boat.dev API (`/api/v1`). A command really runs with bash on this machine, with `HOME`
 * set to the sandbox's own temp directory, so the client's staging of environment and stdin is
 * exercised end to end. Answers and errors follow boat's documented shapes.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

export interface FakeSandbox {
  id: string;
  name: string;
  state: string;
  ttlSeconds: number | null;
  home: string;
}

export interface FakeSavedSnapshot {
  name: string;
  status: 'saving' | 'ready' | 'failed';
  sourceSandboxId: string;
  /** Times `GET` answers `saving` before `ready`. */
  pendingReads: number;
}

export interface FakeBoatError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export class FakeBoat {
  readonly requests: RecordedRequest[] = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly snapshots = new Map<string, FakeSavedSnapshot>();
  /** Errors to answer instead of the next requests whose `METHOD /path` starts with the key. */
  private readonly failures: { prefix: string; error: FakeBoatError }[] = [];
  /** Reads of a resuming sandbox before it is `ready`. */
  resumeReads = 1;
  private readonly root = mkdtempSync(join(tmpdir(), 'fake-boat-'));
  private server: Server | undefined;
  private resuming = new Map<string, number>();
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    rmSync(this.root, { recursive: true, force: true });
  }

  /** A running sandbox with an empty home directory. */
  addSandbox(id: string, state = 'ready'): FakeSandbox {
    const home = join(this.root, id);
    mkdirSync(home, { recursive: true });
    const sandbox = { id, name: id, state, ttlSeconds: 3600, home };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  failNext(prefix: string, error: FakeBoatError): void {
    this.failures.push({ prefix, error });
  }

  /** The commands boat was asked to run, in order. */
  commands(): string[] {
    return this.requests
      .filter((r) => r.method === 'POST' && r.path.endsWith('/commands'))
      .map((r) => String(r.body.command));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\/api\/v1/u, '');
    const body = text ? JSON.parse(text) : undefined;
    this.requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });

    if (req.headers.authorization !== 'Bearer boat_test') {
      return this.error(res, { status: 401, code: 'unauthorized', message: 'bad key' });
    }
    const key = `${req.method} ${path}`;
    const failure = this.failures.findIndex((f) => key.startsWith(f.prefix));
    if (failure >= 0) {
      const [{ error }] = this.failures.splice(failure, 1);
      return this.error(res, error);
    }

    let match: RegExpMatchArray | null;
    if ((match = path.match(/^\/sandboxes\/([^/]+)$/u))) {
      const sandbox = this.sandboxes.get(decodeURIComponent(match[1]!));
      if (!sandbox)
        return this.error(res, { status: 404, code: 'not_found', message: 'no such sandbox' });
      if (req.method === 'GET') {
        const left = this.resuming.get(sandbox.id);
        if (left !== undefined) {
          if (left <= 0) {
            sandbox.state = 'ready';
            this.resuming.delete(sandbox.id);
          } else {
            this.resuming.set(sandbox.id, left - 1);
          }
        }
        return this.json(res, 200, { ok: true, type: 'sandbox.info', sandbox: this.view(sandbox) });
      }
      if (req.method === 'PATCH') {
        if (body && 'ttlSeconds' in body) sandbox.ttlSeconds = body.ttlSeconds;
        return this.json(res, 200, {
          ok: true,
          type: 'sandbox.updated',
          sandbox: this.view(sandbox),
        });
      }
    }
    if ((match = path.match(/^\/sandboxes\/([^/]+)\/resume$/u)) && req.method === 'POST') {
      const sandbox = this.sandboxes.get(decodeURIComponent(match[1]!));
      if (!sandbox)
        return this.error(res, { status: 404, code: 'not_found', message: 'no such sandbox' });
      sandbox.state = 'provisioned';
      this.resuming.set(sandbox.id, this.resumeReads);
      return this.json(res, 202, {
        ok: true,
        type: 'sandbox.resuming',
        id: sandbox.id,
        status: 'provisioned',
      });
    }
    if ((match = path.match(/^\/sandboxes\/([^/]+)\/commands$/u)) && req.method === 'POST') {
      const sandbox = this.runnable(res, match[1]!);
      if (!sandbox) return;
      const result = await runBash(String(body.command), sandbox.home, body.timeoutSeconds ?? 30);
      return this.json(res, 200, {
        ok: true,
        type: 'command.finished',
        success: result.exitCode === 0,
        ...result,
      });
    }
    if ((match = path.match(/^\/sandboxes\/([^/]+)\/files$/u)) && req.method === 'PUT') {
      const sandbox = this.runnable(res, match[1]!);
      if (!sandbox) return;
      const target = normalize(isAbsolute(body.path) ? body.path : join(sandbox.home, body.path));
      if (!target.startsWith(sandbox.home)) {
        return this.error(res, {
          status: 400,
          code: 'invalid_path',
          message: 'outside the sandbox',
        });
      }
      if (!existsSync(dirname(target))) {
        return this.error(res, { status: 400, code: 'invalid_path', message: 'no such directory' });
      }
      const bytes = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      writeFileSync(target, bytes);
      return this.json(res, 200, {
        ok: true,
        type: 'file.written',
        success: true,
        path: body.path,
        encoding: body.encoding ?? 'utf8',
        size: bytes.length,
      });
    }
    if (path === '/saved-snapshots' && req.method === 'POST') {
      if (!this.sandboxes.has(body.sandboxId)) {
        return this.error(res, { status: 404, code: 'not_found', message: 'no such sandbox' });
      }
      const saved: FakeSavedSnapshot = {
        name: body.name,
        status: 'saving',
        sourceSandboxId: body.sandboxId,
        pendingReads: 1,
      };
      this.snapshots.set(saved.name, saved);
      return this.json(res, 202, {
        ok: true,
        type: 'snapshot.saved.saving',
        status: 'saving',
        snapshot: this.snapshotView(saved),
      });
    }
    if ((match = path.match(/^\/saved-snapshots\/([^/]+)$/u))) {
      const name = decodeURIComponent(match[1]!);
      const saved = this.snapshots.get(name);
      if (!saved)
        return this.error(res, {
          status: 404,
          code: 'snapshot_not_found',
          message: 'no such snapshot',
        });
      if (req.method === 'GET') {
        if (saved.status === 'saving') {
          if (saved.pendingReads <= 0) saved.status = 'ready';
          else saved.pendingReads--;
        }
        return this.json(res, 200, {
          ok: true,
          type: 'snapshot.saved.info',
          snapshot: this.snapshotView(saved),
        });
      }
      if (req.method === 'DELETE') {
        this.snapshots.delete(name);
        return this.json(res, 200, {
          ok: true,
          type: 'snapshot.saved.deleted',
          name,
          status: 'deleted',
        });
      }
    }
    return this.error(res, { status: 404, code: 'not_found', message: `no route ${key}` });
  }

  private runnable(res: ServerResponse, rawId: string): FakeSandbox | undefined {
    const sandbox = this.sandboxes.get(decodeURIComponent(rawId));
    if (!sandbox) {
      this.error(res, { status: 404, code: 'not_found', message: 'no such sandbox' });
      return undefined;
    }
    if (!['ready', 'idle', 'running'].includes(sandbox.state)) {
      this.error(res, {
        status: 409,
        code: 'machine_not_running',
        message: 'the sandbox has no machine',
      });
      return undefined;
    }
    return sandbox;
  }

  private view(sandbox: FakeSandbox) {
    return {
      id: sandbox.id,
      name: sandbox.name,
      state: sandbox.state,
      ttlSeconds: sandbox.ttlSeconds,
      error: null,
    };
  }

  private snapshotView(saved: FakeSavedSnapshot) {
    return {
      name: saved.name,
      status: saved.status,
      sourceSandboxId: saved.sourceSandboxId,
      error: null,
    };
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  }

  private error(res: ServerResponse, error: FakeBoatError): void {
    this.json(res, error.status, {
      ok: false,
      type: 'sandbox.error',
      status: error.status,
      code: error.code,
      message: error.message,
      requestId: 'req_fake',
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        details: error.details ?? {},
      },
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    });
  }
}

function runBash(
  command: string,
  home: string,
  timeoutSeconds: number,
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}
