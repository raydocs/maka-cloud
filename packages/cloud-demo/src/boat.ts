import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * boat.dev through its signed-in CLI (`boat … --json`). The demo needs no API key: it uses the
 * owner's own boat login, and the agents use the subscriptions connected on boat's Agents page.
 */

const BOAT = process.env.BOAT_BIN ?? `${process.env.HOME}/.ascii/bin/boat`;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BOAT, [...args, '--no-update'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** Every JSON object printed one per line. */
export function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Not a JSON line (a progress note); skip it.
    }
  }
  return out;
}

function failure(what: string, result: CommandResult): Error {
  const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
  return new Error(`${what} failed (exit ${result.exitCode}): ${detail.slice(0, 400)}`);
}

/** A new sandbox, ready to run commands. Returns its id. */
export async function newSandbox(options: { name: string; ttlSeconds: number }): Promise<string> {
  const result = await run(
    [
      'new',
      '--json',
      '--type',
      'default',
      '--ttl',
      String(options.ttlSeconds),
      '--name',
      options.name,
    ],
    10 * 60_000,
  );
  const lines = jsonLines(result.stdout);
  const ready =
    lines.find((l) => l.event === 'ready') ?? lines.find((l) => typeof l.id === 'string');
  if (result.exitCode !== 0 || typeof ready?.id !== 'string')
    throw failure('creating a sandbox', result);
  return ready.id;
}

/** Runs a shell command in the sandbox (`cwd` relative to /home/user). Up to 600 s. */
export async function exec(
  id: string,
  command: string,
  options: { cwd?: string; timeoutSeconds?: number } = {},
): Promise<CommandResult> {
  const timeout = options.timeoutSeconds ?? 120;
  const args = ['exec', id, '--json', '--timeout', String(timeout)];
  if (options.cwd) args.push('--cwd', options.cwd);
  const result = await run([...args, '--', command], (timeout + 90) * 1000);
  const parsed = jsonLines(result.stdout).find((l) => 'exitCode' in l);
  if (!parsed) throw failure(`running "${command.slice(0, 60)}"`, result);
  return {
    exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : -1,
    stdout: String(parsed.stdout ?? ''),
    stderr: String(parsed.stderr ?? ''),
  };
}

export async function extend(id: string, hours: number): Promise<void> {
  await run(['extend', id, '--hours', String(hours), '--json']);
}

export async function stop(id: string): Promise<void> {
  await run(['stop', id, '--json'], 5 * 60_000);
}

export async function steer(id: string, conversationId: string, message: string): Promise<void> {
  const result = await run(['steer', id, '--convo', conversationId, '--json', '--', message]);
  if (result.exitCode !== 0) throw failure('steering the agent', result);
}

export async function interrupt(id: string, conversationId: string): Promise<void> {
  await run(['interrupt', id, '--convo', conversationId, '--json']);
}

/** What one agent turn did, as boat reports it. */
export interface TurnResult {
  conversationId: string;
  /** The agent's last complete answer. */
  text: string;
  /** `finished`, `failed` or `interrupted`. */
  status: string;
  error?: string;
}

export interface AgentEvent {
  kind: 'text' | 'tool' | 'status';
  /** The turn's conversation, once boat has named it. */
  conversationId?: string;
  text?: string;
  tool?: string;
  input?: unknown;
  status?: string;
}

/**
 * Sends one prompt and streams its events until the turn ends. `provider` is boat's harness name;
 * it never leaves the server.
 */
export async function prompt(
  id: string,
  text: string,
  options: { provider: string; model?: string; effort?: string; resume?: string },
  onEvent: (event: AgentEvent) => void,
): Promise<TurnResult> {
  const args = ['prompt', id, '--json', '--provider', options.provider];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--reasoning-effort', options.effort);
  args.push(...(options.resume ? ['--resume', options.resume] : ['--new']));
  args.push('--', text);

  const child = spawn(BOAT, [...args, '--no-update'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const result: TurnResult = { conversationId: options.resume ?? '', text: '', status: 'unknown' };
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const [event] = jsonLines(line);
    if (!event) continue;
    readEvent(event, result, onEvent);
  }
  const code: number = await new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on('close', (c) => resolve(c ?? -1));
  });
  if (result.status === 'unknown') result.status = code === 0 ? 'finished' : 'failed';
  if (result.status !== 'finished' && !result.error) {
    result.error = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `exit ${code}`;
  }
  return result;
}

/** Folds one line of `boat prompt --json` into the turn's result. Exported for tests. */
export function readEvent(
  event: Record<string, unknown>,
  result: TurnResult,
  onEvent: (event: AgentEvent) => void,
): void {
  if (typeof event.conversationId === 'string' && event.conversationId) {
    result.conversationId = event.conversationId;
  }
  const conversation = result.conversationId ? { conversationId: result.conversationId } : {};
  const data = (
    typeof event.data === 'object' && event.data !== null ? event.data : event
  ) as Record<string, unknown>;
  const type = String(event.type ?? event.event ?? '');
  if (type === 'response' || type === 'agent.response') {
    const tools = Array.isArray(data.tools) ? (data.tools as Record<string, unknown>[]) : [];
    for (const tool of tools) {
      const name = String(tool.name ?? tool.tool ?? tool.type ?? 'tool');
      onEvent({
        kind: 'tool',
        tool: name,
        input: tool.input ?? tool.arguments ?? tool.args,
        ...conversation,
      });
    }
    if (typeof data.content === 'string' && data.content.trim() && data.is_streaming !== true) {
      result.text = data.content;
      onEvent({ kind: 'text', text: data.content, ...conversation });
    }
  }
  const status = typeof data.status === 'string' ? data.status : undefined;
  if ((type === 'prompt' || type.startsWith('prompt')) && status) {
    if (['finished', 'failed', 'interrupted'].includes(status)) result.status = status;
    onEvent({ kind: 'status', status, ...conversation });
  }
  const error = data.error ?? event.error;
  if (typeof error === 'string' && error) result.error = error;
  else if (typeof error === 'object' && error !== null && 'message' in error) {
    result.error = String((error as { message: unknown }).message);
  }
}
