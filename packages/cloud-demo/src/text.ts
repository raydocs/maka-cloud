/** Text helpers: what users may see, what the agents' answers mean, what a diff did to tests. */

/**
 * Model and vendor names never reach a user (`hide-model-names`): the work is ours. Longest names
 * first, so "Claude Code" goes before "Claude".
 */
const MODEL_NAMES =
  /\b(?:Claude\s+Code|Claude\s+Agent|Claude|Anthropic|OpenAI|ChatGPT|Codex(?:\s+CLI)?|GPT[-\s]?\d+(?:\.\d+)?(?:[-\s]?(?:sol|terra|luna|astra|mini|codex))?|o\d(?:-mini)?|Opus(?:\s+\d+(?:\.\d+)?)?|Sonnet(?:\s+\d+(?:\.\d+)?)?|Haiku(?:\s+\d+(?:\.\d+)?)?|Fable(?:\s+\d+(?:\.\d+)?)?|Grok(?:\s+Build)?|xAI|OpenCode|Gemini)\b/giu;

/** Removes model and vendor names from text a user will read. */
export function scrubModelNames(text: string): string {
  return text
    .replace(MODEL_NAMES, 'AI')
    .replace(/\bAI(?:\s+AI)+\b/gu, 'AI')
    .replace(/^.*Co-Authored-By:.*$\n?/gimu, '')
    .replace(/^.*Generated with \[?AI\]?.*$\n?/gimu, '');
}

/** True when the text still names a model or vendor. */
export function namesAModel(text: string): boolean {
  MODEL_NAMES.lastIndex = 0;
  return MODEL_NAMES.test(text);
}

/**
 * The JSON object an agent was asked to end its answer with: the last ```json block, else the
 * last balanced `{…}` in the text.
 */
export function extractJson<T>(text: string): T | undefined {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gu)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse<T>(fences[i]![1]!);
    if (parsed !== undefined) return parsed;
  }
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      const c = text[start];
      if (c === '}') depth++;
      else if (c === '{' && --depth === 0) {
        const parsed = tryParse<T>(text.slice(start, end + 1));
        if (parsed !== undefined) return parsed;
        break;
      }
    }
  }
  return undefined;
}

function tryParse<T>(text: string): T | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

/** One short line, in Chinese, for what a tool call is doing right now. */
export function describeTool(name: string, input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  };
  const file = shortPath(pick('file_path', 'path', 'filePath', 'notebook_path'));
  const command = pick('command', 'cmd');
  const lower = name.toLowerCase();
  if (/bash|shell|exec|command|terminal/u.test(lower) && command) {
    if (/\b(test|vitest|jest|pytest|cargo test|go test|npm (run )?test)\b/u.test(command)) {
      return `正在跑测试：${clip(command, 60)}`;
    }
    if (/^git\s/u.test(command)) return `正在整理提交：${clip(command, 60)}`;
    return `正在执行：${clip(command, 60)}`;
  }
  if (/edit|write|patch|apply/u.test(lower)) return file ? `正在修改 ${file}` : '正在修改代码';
  if (/read|view|open/u.test(lower)) return file ? `正在阅读 ${file}` : '正在阅读代码';
  if (/grep|search|glob|find|ls/u.test(lower)) {
    const pattern = pick('pattern', 'query', 'glob');
    return pattern ? `正在查找 ${clip(pattern, 40)}` : '正在查找相关代码';
  }
  if (/todo|plan/u.test(lower)) return '正在规划步骤';
  if (/web|fetch|browse/u.test(lower)) return '正在查资料';
  return '正在处理';
}

function shortPath(path: string): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface IntegrityFlag {
  file: string;
  why: string;
}

const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb)$|(?:^|\/)test_[^/]+\.py$|\.snap$/u;
const TEST_CONFIG =
  /(?:^|\/)(?:jest|vitest|playwright|karma|mocha)\.config\.[cm]?[jt]s$|(?:^|\/)pytest\.ini$|(?:^|\/)\.github\/workflows\//u;
const SKIP_MARKER =
  /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|\b(?:xit|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip\(|#\[ignore\]/u;

/**
 * The host's own look at a change, before anyone trusts "the tests pass" (T33's integrity scan):
 * an existing test changed or deleted, a skip or focus marker added, test config or CI touched.
 * `nameStatus` is `git diff --name-status base...HEAD`; `patch` is `git diff -U0 base...HEAD`.
 */
export function integrityFlags(nameStatus: string, patch: string): IntegrityFlag[] {
  const flags: IntegrityFlag[] = [];
  // Lines taken out of each file: adding tests to a test file is normal, removing or rewriting
  // existing test lines is what needs a second look.
  const removed = new Map<string, number>();
  let current = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ')) current = line.replace(/^--- (?:a\/)?/u, '');
    else if (line.startsWith('+++ ')) {
      const next = line.replace(/^\+\+\+ (?:b\/)?/u, '');
      if (next !== '/dev/null') current = current === '/dev/null' ? next : current;
    } else if (line.startsWith('-') && !line.startsWith('---') && line.slice(1).trim()) {
      removed.set(current, (removed.get(current) ?? 0) + 1);
    } else if (line.startsWith('+') && !line.startsWith('+++') && SKIP_MARKER.test(line)) {
      flags.push({
        file: current,
        why: `加了跳过或只跑某个测试的标记：${clip(line.slice(1), 60)}`,
      });
    }
  }
  for (const line of nameStatus.split('\n')) {
    const [status, ...rest] = line.trim().split(/\s+/u);
    if (!status || rest.length === 0) continue;
    const file = rest[rest.length - 1]!;
    const was = rest[0]!;
    if (TEST_FILE.test(was) && status.startsWith('D')) {
      flags.push({ file: was, why: '删除了已有的测试' });
    } else if (TEST_FILE.test(was) && (status.startsWith('M') || status.startsWith('R'))) {
      const lines = removed.get(was) ?? 0;
      if (lines > 0) flags.push({ file: was, why: `删改了已有测试的 ${lines} 行` });
    }
    if (TEST_CONFIG.test(file)) flags.push({ file, why: '改动了测试配置或 CI' });
  }
  return flags;
}
