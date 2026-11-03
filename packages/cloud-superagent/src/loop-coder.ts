import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AnthropicLoopModel } from './coder-model.js';
import { ToolLoopCoder, type LoopTool } from './coder-loop.js';
import { CODER_MAX_TOKENS, DEFAULT_JUDGE_MODEL, createJudgeClientFromEnv } from './judge-client.js';
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

/**
 * `MAKA_CLOUD_CODER_LOOP=1` (default off) swaps the single-request coder for
 * the multi-turn tool loop; the single-request coder stays its fallback when
 * there is no box workspace. `MAKA_CLOUD_TOOL_LOADING=1` starts the loop with
 * core tools only. `MAKA_CLOUD_CODER_MODEL` picks the loop model.
 */
export function createCoderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  extras: { extraTools?: readonly LoopTool[] } = {},
): { coder: CoderPort; kind: 'fake' | 'model' | 'model-loop' } {
  const live = env.MAKA_CLOUD_LOOP_LIVE === '1';
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || env.MAKA_CLOUD_JUDGE_API_KEY?.trim() || '';
  if (!live || !apiKey) return { coder: new FakeCoder(), kind: 'fake' };
  const client = createJudgeClientFromEnv(env, fetchImpl, { maxTokens: CODER_MAX_TOKENS });
  const detailed = client.completeDetailed?.bind(client);
  if (!detailed) throw new Error('Coder needs a judge client that implements completeDetailed.');
  const single = new HttpCoder((prompt) => detailed(prompt));
  if (env.MAKA_CLOUD_CODER_LOOP !== '1') return { coder: single, kind: 'model' };
  const model = new AnthropicLoopModel({
    apiKey,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || env.MAKA_CLOUD_JUDGE_BASE_URL?.trim() || undefined,
    model:
      env.MAKA_CLOUD_CODER_MODEL?.trim() ||
      env.MAKA_CLOUD_JUDGE_MODEL?.trim() ||
      DEFAULT_JUDGE_MODEL,
    fetch: fetchImpl,
  });
  return {
    coder: new ToolLoopCoder({
      model,
      fallback: single,
      toolLoading: env.MAKA_CLOUD_TOOL_LOADING === '1',
      ...(extras.extraTools ? { extraTools: extras.extraTools } : {}),
    }),
    kind: 'model-loop',
  };
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
