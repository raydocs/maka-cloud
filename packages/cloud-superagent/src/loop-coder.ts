import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ClaudeCodeExecutor, type GatewayRoute } from './claude-code-executor.js';
import { CodexExecutor } from './codex-executor.js';
import { ExecutorCoder, type Executor, type ExecutorSessionStore } from './executor.js';
import { BoxProcessRunner, type ProcessRunner } from './executor-process.js';
import { BOX_REPO } from './loop-box.js';
import type { SandboxPort } from './sandbox.js';
import { CODER_MAX_TOKENS, createJudgeClientFromEnv } from './judge-client.js';
import { FakeCoder, type CoderPort, type CoderResult } from './loop.js';
import type { ModelCompletion } from './router.js';
import type { NormalizedEvent, WorkerRecord } from './types.js';

const CoderJson = z.object({
  summary: z.string().optional(),
  files: z.record(z.string(), z.string()),
});

/**
 * Host-side model coder. Reuses the Anthropic Messages client the Router
 * already has (`FetchJudgeClient`). The key never enters the sandbox.
 * A bad or missing completion falls back to FakeCoder so the scratch
 * add() fixture can still go green.
 */
export class HttpCoder implements CoderPort {
  constructor(
    private readonly complete: (prompt: string) => Promise<string | ModelCompletion>,
    private readonly fallback: CoderPort = new FakeCoder(),
  ) {}

  async apply(input: {
    dir?: string;
    snapshot?: string;
    brief: string;
    event: NormalizedEvent;
    worker: WorkerRecord;
  }): Promise<CoderResult> {
    const snapshot = input.snapshot ?? (input.dir ? await snapshotFiles(input.dir) : '');
    const started = Date.now();
    let raw: string | ModelCompletion;
    try {
      raw = await this.complete(promptOf(input.brief, snapshot));
    } catch {
      return this.fallback.apply(input);
    }
    const text = typeof raw === 'string' ? raw : raw.text;
    const parsed = parseCoderJson(text);
    if (!parsed) return this.fallback.apply(input);
    const changed: string[] = [];
    for (const [rel, content] of Object.entries(parsed.files)) {
      if (rel.includes('..') || rel.startsWith('/')) continue;
      if (input.dir) {
        const path = join(input.dir, rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
      changed.push(rel);
    }
    if (changed.length === 0) return this.fallback.apply(input);
    const usage =
      typeof raw === 'string'
        ? { tokens: Math.ceil(text.length / 4), usdMicros: 400, wallMs: Date.now() - started }
        : {
            tokens: raw.usage.tokens,
            usdMicros: raw.usage.usdMicros,
            wallMs: raw.usage.wallMs || Date.now() - started,
            inputTokens: raw.usage.inputTokens,
            outputTokens: raw.usage.outputTokens,
          };
    return {
      changed,
      files: Object.fromEntries(
        Object.entries(parsed.files).filter(([rel]) => !rel.includes('..') && !rel.startsWith('/')),
      ),
      summary: parsed.summary ?? `model coder wrote ${changed.join(', ')}`,
      usage,
    };
  }
}

export function parseCoderJson(
  raw: string,
): { summary?: string; files: Record<string, string> } | undefined {
  const json = extractJson(raw);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const data = CoderJson.safeParse(parsed);
  if (!data.success) return undefined;
  return data.data;
}

export const EXECUTOR_ENV = 'MAKA_CLOUD_EXECUTOR';
export const EXECUTOR_MODEL_ENV = 'MAKA_CLOUD_EXECUTOR_MODEL';
export const EXECUTOR_GATEWAY_ENV = 'MAKA_CLOUD_EXECUTOR_GATEWAY';
export const MAGPIE_URL_ENV = 'MAKA_CLOUD_MAGPIE_URL';
export const MAGPIE_KEY_ENV = 'MAKA_CLOUD_MAGPIE_KEY';
/** Model on the Magpie route (`auto/claude-sonnet-5-5`, `codex/gpt-6-luna`, ...). */
export const MAGPIE_MODEL_ENV = 'MAKA_CLOUD_MAGPIE_MODEL';
/** Name of the box variable (an Instabox Secret) that holds Claude Code's token. */
export const EXECUTOR_CLAUDE_SECRET_ENV = 'MAKA_CLOUD_EXECUTOR_CLAUDE_SECRET';
/** Name of the box variable (an Instabox Secret) that holds an OpenAI key for Codex. */
export const EXECUTOR_CODEX_SECRET_ENV = 'MAKA_CLOUD_EXECUTOR_CODEX_SECRET';

/**
 * `MAKA_CLOUD_EXECUTOR=claude-code` or `codex` runs that CLI headless as the
 * coder (off by default). With a sandbox it runs inside the worker's box.
 * Auth: the CLI's own login, else Magpie. `MAKA_CLOUD_EXECUTOR_GATEWAY=magpie`
 * always uses Magpie, `=builtin` never does; unset with a Magpie URL and key,
 * each box is checked once and Magpie is used only where the CLI is not
 * signed in. Unset or `fake` keeps the coder below.
 */
export function createCoderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  options: {
    sandbox?: SandboxPort;
    sessions?: ExecutorSessionStore;
    /** Box runner override (the bench passes one to read its peak RSS). */
    runner?: ProcessRunner;
  } = {},
): { coder: CoderPort; kind: 'fake' | 'model' | 'claude-code' | 'codex' } {
  const executor = env[EXECUTOR_ENV]?.trim();
  if (executor === 'claude-code' || executor === 'codex') {
    const sandbox = options.sandbox;
    return {
      coder: new ExecutorCoder(createExecutorFromEnv(executor, env, options), {
        ...(sandbox ? { box: { sandbox, workdir: BOX_REPO } } : {}),
        // A store-backed session store lets a restarted host resume each session.
        ...(options.sessions ? { sessions: options.sessions } : {}),
      }),
      kind: executor,
    };
  }
  if (executor && executor !== 'fake') {
    throw new Error(
      `${EXECUTOR_ENV}=${executor} is not a known executor (claude-code, codex, fake).`,
    );
  }
  const live = env.MAKA_CLOUD_LOOP_LIVE === '1';
  const hasKey = Boolean(env.ANTHROPIC_API_KEY?.trim() || env.MAKA_CLOUD_JUDGE_API_KEY?.trim());
  if (!live || !hasKey) return { coder: new FakeCoder(), kind: 'fake' };
  const client = createJudgeClientFromEnv(env, fetchImpl, { maxTokens: CODER_MAX_TOKENS });
  const detailed = client.completeDetailed?.bind(client);
  if (!detailed) throw new Error('Coder needs a judge client that implements completeDetailed.');
  return { coder: new HttpCoder((prompt) => detailed(prompt)), kind: 'model' };
}

/**
 * Claude Code or Codex as configured by env: model, box Secret login, Magpie
 * route (see `createCoderFromEnv`). With a sandbox it runs inside the box,
 * with the CLI's own permission checks off (the box is the sandbox).
 */
export function createExecutorFromEnv(
  kind: 'claude-code' | 'codex',
  env: NodeJS.ProcessEnv,
  options: { sandbox?: SandboxPort; runner?: ProcessRunner } = {},
): Executor {
  const model = env[EXECUTOR_MODEL_ENV]?.trim();
  const gatewayModel = env[MAGPIE_MODEL_ENV]?.trim();
  const { gateway, gatewayMode } = gatewayFromEnv(env);
  const sandbox = options.sandbox;
  const route = {
    env,
    ...(model ? { model } : {}),
    ...(gateway ? { gateway, gatewayMode } : {}),
    ...(gatewayModel ? { gatewayModel } : {}),
    ...(sandbox ? { runner: options.runner ?? new BoxProcessRunner(sandbox) } : {}),
  };
  if (kind === 'codex') {
    const secret = env[EXECUTOR_CODEX_SECRET_ENV]?.trim();
    return new CodexExecutor({
      ...route,
      ...(secret ? { boxSecretEnv: { OPENAI_API_KEY: secret } } : {}),
      ...(sandbox ? { sandbox: 'bypass' as const } : {}),
    });
  }
  const secret = env[EXECUTOR_CLAUDE_SECRET_ENV]?.trim();
  return new ClaudeCodeExecutor({
    ...route,
    ...(secret ? { boxSecretEnv: { CLAUDE_CODE_OAUTH_TOKEN: secret } } : {}),
    ...(sandbox ? { permissionMode: 'bypassPermissions' as const } : {}),
  });
}

/**
 * Magpie route from env. `MAKA_CLOUD_EXECUTOR_GATEWAY=magpie` → always (needs
 * `MAKA_CLOUD_MAGPIE_URL` and `MAKA_CLOUD_MAGPIE_KEY`); `=builtin` → never;
 * unset → fallback when both are set, else none.
 */
export function gatewayFromEnv(env: NodeJS.ProcessEnv): {
  gateway?: GatewayRoute;
  gatewayMode: 'always' | 'fallback';
} {
  const picked = env[EXECUTOR_GATEWAY_ENV]?.trim();
  if (picked && picked !== 'magpie' && picked !== 'builtin') {
    throw new Error(`${EXECUTOR_GATEWAY_ENV}=${picked} is not a known gateway (magpie, builtin).`);
  }
  const baseUrl = env[MAGPIE_URL_ENV]?.trim();
  const token = env[MAGPIE_KEY_ENV]?.trim();
  if (picked === 'builtin') return { gatewayMode: 'always' };
  if (picked === 'magpie') {
    if (!baseUrl || !token) {
      throw new Error(
        `${EXECUTOR_GATEWAY_ENV}=magpie needs ${MAGPIE_URL_ENV} and ${MAGPIE_KEY_ENV}.`,
      );
    }
    return { gateway: { baseUrl, token }, gatewayMode: 'always' };
  }
  return baseUrl && token
    ? { gateway: { baseUrl, token }, gatewayMode: 'fallback' }
    : { gatewayMode: 'always' };
}

async function snapshotFiles(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((name) => name !== '.git').slice(0, 8);
  const parts: string[] = [];
  for (const name of names) {
    try {
      const text = await readFile(join(dir, name), 'utf8');
      parts.push(`### ${name}\n${text.slice(0, 4000)}`);
    } catch {
      // skip directories
    }
  }
  return parts.join('\n');
}

function promptOf(brief: string, snapshot: string): string {
  return [
    'Edit this scratch repo so its tests pass. Reply with JSON only:',
    '{"summary":"...","files":{"path":"full file contents"}}',
    `brief=${brief}`,
    snapshot,
  ].join('\n');
}

function extractJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return undefined;
}
