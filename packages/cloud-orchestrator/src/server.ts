import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SessionInfo } from './auth.js';
import { MAX_BRIEF_BYTES } from './handoff.js';
import type { Orchestrator } from './orchestrator.js';
import { MAX_WAIT_MS } from './orchestrator.js';
import { OrchestratorError } from './types.js';

const MAX_REQUEST_BYTES = MAX_BRIEF_BYTES + 64 * 1024;

const waitMs = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MS)
  .optional()
  .describe('Milliseconds to wait. Defaults to 60000, at most 600000.');

const taskIdInput = z.object({
  taskId: z.string().min(1).describe('Id returned by delegate_task'),
});

function ok(view: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(view, null, 2) }],
    structuredContent: view as Record<string, unknown>,
  };
}

function failure(error: unknown): CallToolResult {
  const text =
    error instanceof OrchestratorError ? `${error.code}: ${error.message}` : 'internal_error';
  return { isError: true, content: [{ type: 'text', text }] };
}

async function guarded(run: () => Promise<unknown> | unknown): Promise<CallToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return failure(error);
  }
}

/** One MCP server per request, bound to the session that authenticated it. */
export function createSessionMcpServer(
  orchestrator: Orchestrator,
  session: SessionInfo,
): McpServer {
  const server = new McpServer({ name: 'maka-cloud-orchestrator', version: '0.1.0' });
  server.registerTool(
    'delegate_task',
    {
      description:
        'Start a child task on a named runner. The brief is written to a file the runner reads; the result comes back as a manifest (summary, done, notDone, confidence, knownIssues). mode "async" returns the task id at once; mode "wait" blocks until the task ends or the timeout passes (the task keeps running after a timeout).',
      inputSchema: z.object({
        runner: z
          .string()
          .min(1)
          .describe('Runner name, for example "claude-agent-sdk" or "codex"'),
        brief: z.string().min(1).describe('What the child must do, self-contained'),
        title: z.string().max(200).optional(),
        mode: z.enum(['async', 'wait']).optional().describe('Defaults to "async"'),
        timeoutMs: waitMs,
      }),
    },
    (input) => guarded(() => orchestrator.delegate(session, input)),
  );
  server.registerTool(
    'task_status',
    {
      description: 'Current state of a task you created or one of its descendants.',
      inputSchema: taskIdInput,
    },
    ({ taskId }) => guarded(() => orchestrator.status(session, taskId)),
  );
  server.registerTool(
    'task_wait',
    {
      description:
        'Block until the task ends or the timeout passes. A timeout returns the current state with waitTimedOut true and does not cancel the task.',
      inputSchema: taskIdInput.extend({ timeoutMs: waitMs }),
    },
    ({ taskId, timeoutMs }) => guarded(() => orchestrator.wait(session, taskId, timeoutMs)),
  );
  server.registerTool(
    'task_cancel',
    {
      description:
        'Cancel a task and everything it delegated. A task that already ended keeps its final state.',
      inputSchema: taskIdInput,
    },
    ({ taskId }) => guarded(() => orchestrator.cancel(session, taskId)),
  );
  return server;
}

export interface OrchestratorServerOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  path?: string;
}

/**
 * Streamable-HTTP MCP endpoint. Every request needs `Authorization: Bearer
 * <session token>`; the tools it exposes only reach that session's tasks.
 */
export class OrchestratorServer {
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private http: Server | undefined;

  constructor(
    private readonly orchestrator: Orchestrator,
    options: OrchestratorServerOptions = {},
  ) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.path = options.path ?? '/mcp';
  }

  /** Starts listening and tells the orchestrator its URL so executors get a scoped endpoint. */
  async listen(): Promise<string> {
    if (this.http) throw new Error('Orchestrator server is already listening');
    const http = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) respond(res, 500, { error: 'internal_error' });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.port, this.host, resolve);
    });
    this.http = http;
    const { port } = http.address() as AddressInfo;
    const url = `http://${this.host}:${port}${this.path}`;
    this.orchestrator.setEndpoint(url);
    return url;
  }

  async close(): Promise<void> {
    const http = this.http;
    if (!http) return;
    this.http = undefined;
    this.orchestrator.setEndpoint(undefined);
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== this.path) return respond(res, 404, { error: 'not_found' });
    const token = /^Bearer\s+(\S+)$/iu.exec(req.headers.authorization ?? '')?.[1];
    const session = token === undefined ? undefined : this.orchestrator.authenticate(token);
    if (!session) {
      res.setHeader('www-authenticate', 'Bearer');
      return respond(res, 401, { error: 'unauthorized' });
    }
    let body: unknown;
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) return respond(res, parsed.status, { error: parsed.error });
      body = parsed.value;
    }
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createSessionMcpServer(this.orchestrator, session);
    await server.connect(transport);
    res.once('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res, body);
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) return { ok: false, error: 'request_too_large', status: 413 };
    chunks.push(buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, error: 'invalid_json', status: 400 };
  }
}
