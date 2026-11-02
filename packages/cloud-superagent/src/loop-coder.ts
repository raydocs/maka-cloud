import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createJudgeClientFromEnv } from './judge-client.js';
import { FakeCoder, type CoderPort, type CoderResult } from './loop.js';
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
    private readonly complete: (prompt: string) => Promise<string>,
    private readonly fallback: CoderPort = new FakeCoder(),
  ) {}

  async apply(input: {
    dir: string;
    brief: string;
    event: NormalizedEvent;
    worker: WorkerRecord;
  }): Promise<CoderResult> {
    const snapshot = await snapshotFiles(input.dir);
    let raw: string;
    try {
      raw = await this.complete(promptOf(input.brief, snapshot));
    } catch {
      return this.fallback.apply(input);
    }
    const parsed = parseCoderJson(raw);
    if (!parsed) return this.fallback.apply(input);
    const changed: string[] = [];
    for (const [rel, content] of Object.entries(parsed.files)) {
      if (rel.includes('..') || rel.startsWith('/')) continue;
      const path = join(input.dir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      changed.push(rel);
    }
    if (changed.length === 0) return this.fallback.apply(input);
    return {
      changed,
      summary: parsed.summary ?? `model coder wrote ${changed.join(', ')}`,
      usage: { tokens: Math.ceil(raw.length / 4), usdMicros: 400, wallMs: 1 },
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

export function createCoderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): { coder: CoderPort; kind: 'fake' | 'model' } {
  const live = env.MAKA_CLOUD_LOOP_LIVE === '1';
  const hasKey = Boolean(env.ANTHROPIC_API_KEY?.trim() || env.MAKA_CLOUD_JUDGE_API_KEY?.trim());
  if (!live || !hasKey) return { coder: new FakeCoder(), kind: 'fake' };
  const client = createJudgeClientFromEnv(env, fetchImpl);
  return { coder: new HttpCoder((prompt) => client.complete(prompt)), kind: 'model' };
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
