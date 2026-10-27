import * as boat from './boat.ts';
import { LoopGuard } from './guards.ts';
import { MAX_NEW, notesBlock } from './notes.ts';
import {
  describeTool,
  extractJson,
  type IntegrityFlag,
  integrityFlags,
  scrubModelNames,
} from './text.ts';

/**
 * One task, start to finish: work order, build, our own checks, an independent review, the fix,
 * the pull request and the result card. The roles have internal names only; which model plays
 * each one is configured here and never shown to the owner (`hide-model-names`).
 */

export interface Role {
  provider: string;
  model?: string;
  effort?: string;
}

export const ROLES: { builder: Role; oracle: Role } = {
  builder: {
    provider: 'claude',
    model: process.env.MAKA_DEMO_BUILDER_MODEL ?? 'opus-5-5',
  },
  oracle: {
    provider: 'codex',
    model: process.env.MAKA_DEMO_ORACLE_MODEL ?? 'gpt-6.1-sol',
    effort: process.env.MAKA_DEMO_ORACLE_EFFORT ?? 'high',
  },
};

/** What the owner sees for each role. */
const ROLE_LABEL = { builder: '开发', oracle: '独立审查' } as const;

export interface WorkOrder {
  outcome: string;
  done_means: string[];
  out_of_scope?: string[];
  assumptions?: string[];
  test_command?: string;
  questions?: { question: string; default: string }[];
}

export interface Finding {
  severity: 'high' | 'medium' | 'low';
  file?: string;
  issue: string;
  fix?: string;
}

interface Summary {
  summary?: string;
  changes?: string[];
  verified?: string[];
  notes?: string[];
  /** Durable notes about working in this repository, for the next task here. */
  lessons?: string[];
}

export interface LogEntry {
  at: number;
  kind: 'step' | 'note' | 'error' | 'agent';
  role?: string;
  text: string;
}

export interface ResultCard {
  title: string;
  summary: string;
  changes: string[];
  evidence: { ok: boolean; text: string }[];
  review: { found: number; items: string[] };
  flags: IntegrityFlag[];
  prUrl?: string;
  prError?: string;
  notes: string[];
  /** What this task added to the repository's notes, so the owner sees what was learned. */
  learned?: string[];
}

export type TaskState =
  | 'preparing'
  | 'planning'
  | 'waiting'
  | 'building'
  | 'checking'
  | 'reviewing'
  | 'fixing'
  | 'delivering'
  | 'done'
  | 'failed'
  | 'stopped';

/** One thing the computer did, for the live terminal panel. */
export interface Activity {
  at: number;
  role: string;
  kind: 'run' | 'edit' | 'read' | 'search' | 'other' | 'check';
  title: string;
  /** The command or the file, as the tool gave it. */
  detail?: string;
  /** For our own checks: what came back. */
  output?: string;
  ok?: boolean;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  patch: string;
}

export interface Task {
  id: string;
  repo: string;
  goal: string;
  createdAt: number;
  state: TaskState;
  /** One line: what is happening right now. */
  now: string;
  log: LogEntry[];
  activity: Activity[];
  diff?: DiffFile[];
  sandboxId?: string;
  branch?: string;
  base?: string;
  workOrder?: WorkOrder;
  answers?: string[];
  builderConvo?: string;
  result?: ResultCard;
  error?: string;
  /** For a task that did not finish: what its look back added to the repository's notes. */
  learned?: string[];
  endedAt?: number;
}

export interface Hooks {
  changed(task: Task): void;
  /** Resolves with the owner's answers to the work order's questions. */
  answers(task: Task): Promise<string[]>;
  stopped(task: Task): boolean;
  /** What earlier tasks learned about working in this repository. */
  notes?(repo: string): string[];
  /** Keeps what this task learned about the repository for the next one. */
  learn?(repo: string, notes: string[]): void;
}

const TEST_TIMEOUT_S = 600;
/** The longest one agent turn may run before it is interrupted; MAKA_TURN_MINUTES overrides it. */
const TURN_LIMIT_MS = Number(process.env.MAKA_TURN_MINUTES ?? 40) * 60_000;
/** How long an interrupted turn has to end before its local stream is cut off. */
const INTERRUPT_GRACE_MS = 30_000;
/** How long the look back after a task that did not finish may take. */
const LOOK_BACK_LIMIT_MS = 5 * 60_000;

export async function runTask(task: Task, hooks: Hooks): Promise<void> {
  const say = (kind: LogEntry['kind'], text: string, role?: string) => {
    task.log.push({ at: Date.now(), kind, text: scrubModelNames(text), ...(role ? { role } : {}) });
    hooks.changed(task);
  };
  const step = (state: TaskState, now: string) => {
    task.state = state;
    task.now = now;
    say('step', now);
  };
  const halt = () => {
    if (hooks.stopped(task)) throw new Stopped();
  };

  try {
    step('preparing', '正在准备一台干净的云端电脑');
    task.sandboxId = await boat.newSandbox({ name: `maka-${task.id}`, ttlSeconds: 7200 });
    hooks.changed(task);
    halt();

    task.now = '正在拉取代码';
    hooks.changed(task);
    const branch = `maka/${task.id}`;
    const setup = await boat.exec(task.sandboxId, setupScript(task.repo, branch), {
      timeoutSeconds: 300,
    });
    const base = setup.stdout.match(/^BASE=(\S+)$/mu)?.[1];
    if (setup.exitCode !== 0 || !base) {
      throw new Error(`拉取仓库 ${task.repo} 失败：${tail(setup.stderr || setup.stdout, 300)}`);
    }
    task.branch = branch;
    task.base = base;
    say('note', `代码已就绪（基于 ${base}）`);
    halt();

    // 1. Work order: read first, ask at most three questions, each with a default.
    step('planning', '正在读代码、写工作单');
    const known = hooks.notes?.(task.repo) ?? [];
    if (known.length > 0) say('note', `参考了之前在这个仓库记下的 ${known.length} 条经验`);
    const plan = await turn(task, 'builder', planPrompt(task.goal, known), undefined, hooks, say);
    task.builderConvo = plan.conversationId;
    const order = extractJson<WorkOrder>(plan.text);
    if (!order?.outcome) throw new Error('没能写出工作单，请换个说法再试一次。');
    order.questions = (order.questions ?? []).slice(0, 3);
    task.workOrder = order;
    hooks.changed(task);
    if (order.questions.length > 0) {
      task.state = 'waiting';
      task.now = '等你确认工作单';
      hooks.changed(task);
      task.answers = await hooks.answers(task);
      say('note', '工作单已确认');
    }
    halt();

    // 2. Build.
    step('building', '开始动手');
    const built = await turn(
      task,
      'builder',
      buildPrompt(order, task.answers ?? []),
      task.builderConvo,
      hooks,
      say,
    );
    let summary = extractJson<Summary>(built.text) ?? {};
    halt();

    // 3. Our own checks, before anyone believes "the tests pass".
    step('checking', '正在独立复核测试');
    let checks = await ownChecks(task, order);
    halt();

    // 4. Independent review in a fresh conversation, by another model.
    step('reviewing', '正在做独立审查');
    const reviewed = await turn(task, 'oracle', reviewPrompt(task, order), undefined, hooks, say);
    const review = extractJson<{ verdict?: string; findings?: Finding[] }>(reviewed.text);
    const findings = (review?.findings ?? []).filter((f) => f && f.issue);
    const serious = findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
    say(
      'note',
      serious.length ? `审查发现 ${serious.length} 个需要修的问题` : '审查没有发现需要修的问题',
    );
    halt();

    // 5. Fix what the review found (or what our checks caught), once.
    if (serious.length > 0 || !checks.testsOk || checks.flags.length > 0) {
      step('fixing', '正在按审查意见修改');
      const fixed = await turn(
        task,
        'builder',
        fixPrompt(order, serious, checks),
        task.builderConvo,
        hooks,
        say,
      );
      summary = extractJson<Summary>(fixed.text) ?? summary;
      step('checking', '正在再次复核测试');
      checks = await ownChecks(task, order);
    }
    halt();

    // 6. Pull request and the result card.
    step('delivering', '正在开 PR');
    const card: ResultCard = {
      title: order.outcome,
      summary: summary.summary ?? order.outcome,
      changes: summary.changes ?? [],
      evidence: [
        {
          ok: checks.testsOk,
          text: checks.testsOk
            ? `测试通过：${order.test_command ?? '（未指定测试命令）'}`
            : `测试没通过：${tail(checks.testOutput, 200)}`,
        },
        {
          ok: checks.flags.length === 0,
          text:
            checks.flags.length === 0
              ? '没有删改、跳过已有测试'
              : `有 ${checks.flags.length} 处测试改动需要你看一眼`,
        },
        {
          ok: true,
          text: serious.length
            ? `独立审查：发现 ${serious.length} 个问题，已交给开发修改，修改后重新复核了测试`
            : '独立审查：没有发现需要修的问题',
        },
      ],
      review: {
        found: serious.length,
        items: serious.map((f) => `${f.file ? `${f.file}：` : ''}${f.issue}`),
      },
      flags: checks.flags,
      notes: [...(summary.notes ?? []), ...(summary.verified ?? []).map((v) => `已验证：${v}`)],
    };
    // What this task learned about the repository: its own few notes, and the test command our
    // own run just proved, which is the one fact here we checked ourselves.
    const learned = (summary.lessons ?? [])
      .filter((note) => typeof note === 'string')
      .slice(0, MAX_NEW);
    if (checks.testsOk && order.test_command)
      learned.push(`能跑通的测试命令：${order.test_command}`);
    if (learned.length > 0) {
      card.learned = learned;
      hooks.learn?.(task.repo, learned);
    }
    const pr = await openPullRequest(task, card);
    if (pr.url) card.prUrl = pr.url;
    else card.prError = pr.error;
    task.result = scrubCard(card);
    task.state = 'done';
    task.now = pr.url ? '完成，PR 已开好' : '完成（PR 没开成，改动留在云端电脑里）';
    task.endedAt = Date.now();
    say('step', task.now);
  } catch (error) {
    task.endedAt = Date.now();
    if (error instanceof Stopped) {
      task.state = 'stopped';
      task.now = '已停止';
      say('step', '你停止了这个任务');
    } else {
      task.state = 'failed';
      task.error = scrubModelNames(error instanceof Error ? error.message : String(error));
      task.now = '没做完';
      say('error', task.error);
      hooks.changed(task);
      await lookBack(task, hooks, say);
    }
  } finally {
    hooks.changed(task);
    // Stop the sandbox: its disk (and the change) stays for 14 days, and it no longer costs.
    if (task.sandboxId) await boat.stop(task.sandboxId).catch(() => undefined);
  }
}

class Stopped extends Error {}

async function turn(
  task: Task,
  role: keyof typeof ROLES,
  text: string,
  resume: string | undefined,
  hooks: Hooks,
  say: (kind: LogEntry['kind'], text: string, role?: string) => void,
  limitMs = TURN_LIMIT_MS,
): Promise<boat.TurnResult> {
  const guard = new LoopGuard();
  const sandbox = task.sandboxId!;
  let blocked: string | null = null;
  let conversation = resume ?? '';
  // A turn is supervised: Stop and the time limit interrupt it at once, not at its next event,
  // and a turn that still has not ended a while after the interrupt is cut off locally.
  let interrupted = false;
  let timedOut = false;
  const cutOff = new AbortController();
  let cutOffTimer: NodeJS.Timeout | undefined;
  const interruptOnce = () => {
    // Before the turn has named its conversation there is nothing to interrupt yet; the cut-off
    // still starts, and a later call sends the interrupt once the id is known.
    cutOffTimer ??= setTimeout(() => cutOff.abort(), INTERRUPT_GRACE_MS);
    if (interrupted || !conversation) return;
    interrupted = true;
    void boat.interrupt(sandbox, conversation).catch(() => undefined);
  };
  const watch = setInterval(() => {
    if (hooks.stopped(task)) interruptOnce();
  }, 2000);
  const limit = setTimeout(() => {
    timedOut = true;
    interruptOnce();
  }, limitMs);
  let result: boat.TurnResult;
  try {
    result = await boat.prompt(
      sandbox,
      text,
      { ...ROLES[role], ...(resume ? { resume } : {}) },
      (event) => {
        if (event.conversationId) conversation = event.conversationId;
        if (event.kind === 'tool' && event.tool) {
          const title = describeTool(event.tool, event.input);
          task.now = `${ROLE_LABEL[role]}：${title}`;
          record(task, { role: ROLE_LABEL[role], ...toolActivity(event.tool, event.input), title });
          hooks.changed(task);
          const reason = guard.check(event.tool, event.input);
          if (reason && !blocked) {
            blocked = reason;
            interruptOnce();
          }
        } else if (event.kind === 'text' && event.text) {
          say('agent', event.text, ROLE_LABEL[role]);
        }
        if (hooks.stopped(task)) interruptOnce();
      },
      cutOff.signal,
    );
  } finally {
    clearInterval(watch);
    clearTimeout(limit);
    clearTimeout(cutOffTimer);
  }
  conversation = result.conversationId;
  if (blocked) throw new Error(`${ROLE_LABEL[role]}卡住了：${blocked}。`);
  if (hooks.stopped(task)) throw new Stopped();
  if (timedOut) {
    throw new Error(
      `${ROLE_LABEL[role]}这一步超过了 ${Math.round(limitMs / 60_000)} 分钟，已经停下。改动还在云端电脑里，可以重新开始。`,
    );
  }
  if (result.status !== 'finished') {
    throw new Error(`${ROLE_LABEL[role]}这一步没完成（${result.status}）：${result.error ?? ''}`);
  }
  return result;
}

/**
 * After a task that did not finish, the builder looks back in the same conversation, which still
 * holds everything it tried, and leaves the next attempt in this repository a few notes. The task
 * has already been marked as not finished; this only adds what was learned, and is skipped when
 * nothing ran yet or it would take long.
 */
async function lookBack(
  task: Task,
  hooks: Hooks,
  say: (kind: LogEntry['kind'], text: string) => void,
) {
  if (!task.builderConvo || !task.sandboxId || !hooks.learn) return;
  try {
    const looked = await turn(
      task,
      'builder',
      lookBackPrompt(task.error ?? ''),
      task.builderConvo,
      hooks,
      () => undefined,
      LOOK_BACK_LIMIT_MS,
    );
    const lessons = (extractJson<{ lessons?: unknown[] }>(looked.text)?.lessons ?? [])
      .filter((note): note is string => typeof note === 'string' && note.trim() !== '')
      .slice(0, MAX_NEW);
    if (lessons.length === 0) return;
    hooks.learn(task.repo, lessons);
    task.learned = lessons.map(scrubModelNames);
    say('note', `复盘后为这个仓库记下了 ${lessons.length} 条经验，下次直接用上`);
  } catch {
    // Looking back is a bonus; the task's outcome is already recorded.
  }
}

interface Checks {
  testsOk: boolean;
  testOutput: string;
  flags: IntegrityFlag[];
}

async function ownChecks(task: Task, order: WorkOrder): Promise<Checks> {
  const sandbox = task.sandboxId!;
  let testsOk = false;
  let testOutput = '没有可以运行的测试命令';
  if (order.test_command) {
    const tests = await boat.exec(sandbox, `cd ~/work && ${order.test_command} 2>&1`, {
      timeoutSeconds: TEST_TIMEOUT_S,
    });
    testsOk = tests.exitCode === 0;
    testOutput = tail(tests.stdout + tests.stderr, 2000);
    record(task, {
      role: '复核',
      kind: 'check',
      title: testsOk ? '我们自己跑了一遍测试：通过' : '我们自己跑了一遍测试：没通过',
      detail: order.test_command,
      output: tail(testOutput, 1200),
      ok: testsOk,
    });
  }
  const range = `${task.base}...HEAD`;
  const names = await boat.exec(sandbox, `cd ~/work && git diff --name-status ${range}`);
  const patch = await boat.exec(sandbox, `cd ~/work && git diff -U0 ${range}`, {
    timeoutSeconds: 120,
  });
  const flags = integrityFlags(names.stdout, patch.stdout);
  record(task, {
    role: '复核',
    kind: 'check',
    title: flags.length
      ? `测试完整性检查：${flags.length} 处需要看一眼`
      : '测试完整性检查：没有删改或跳过已有测试',
    ok: flags.length === 0,
  });
  const full = await boat.exec(sandbox, `cd ~/work && git diff ${range} | head -c 400000`, {
    timeoutSeconds: 120,
  });
  task.diff = splitDiff(full.stdout);
  return { testsOk, testOutput, flags };
}

async function openPullRequest(
  task: Task,
  card: ResultCard,
): Promise<{ url?: string; error?: string }> {
  const body = Buffer.from(prBody(card), 'utf8').toString('base64');
  const title = clip(scrubModelNames(card.title), 70);
  const script = [
    'set -e',
    'cd ~/work',
    'if [ -z "$(git log --oneline ${BASE}..HEAD)" ]; then echo "NO_COMMITS" >&2; exit 3; fi',
    `printf %s ${shq(body)} | base64 -d > /tmp/maka-pr.md`,
    'git push -u origin HEAD 2>&1',
    // A pull request this branch already has (an earlier try that timed out after opening it)
    // is the answer, not a second one.
    `gh pr view ${shq(task.branch!)} --json url -q .url 2>/dev/null && exit 0`,
    `gh pr create --base "$BASE" --head ${shq(task.branch!)} --title ${shq(title)} --body-file /tmp/maka-pr.md`,
  ].join('\n');
  const result = await boat.exec(task.sandboxId!, `BASE=${shq(task.base!)}\n${script}`, {
    timeoutSeconds: 180,
  });
  const url =
    pullUrl(result.stdout + result.stderr) ??
    // No address came back (a timeout, a dropped connection): the pull request may still have
    // been opened, so GitHub is asked before this is called a failure.
    pullUrl(
      (
        await boat
          .exec(task.sandboxId!, `cd ~/work && gh pr view ${shq(task.branch!)} --json url -q .url`)
          .catch(() => ({ stdout: '' }))
      ).stdout,
    );
  if (url) return { url };
  if (result.exitCode === 3) return { error: '这次没有产生任何提交，所以没有开 PR。' };
  return { error: `PR 没开成：${tail(result.stderr || result.stdout, 300)}` };
}

function pullUrl(text: string): string | undefined {
  return text.match(/https:\/\/github\.com\/\S+\/pull\/\d+/u)?.[0];
}

function prBody(card: ResultCard): string {
  const lines = [`## ${card.title}`, '', card.summary, ''];
  if (card.changes.length) lines.push('### 改了什么', ...card.changes.map((c) => `- ${c}`), '');
  lines.push('### 证据', ...card.evidence.map((e) => `- ${e.ok ? '✅' : '⚠️'} ${e.text}`), '');
  if (card.review.items.length) {
    lines.push(
      '### 独立审查发现的问题（已交给开发修改）',
      ...card.review.items.map((i) => `- ${i}`),
      '',
    );
  }
  if (card.flags.length) {
    lines.push('### 需要你看一眼', ...card.flags.map((f) => `- ${f.file}：${f.why}`), '');
  }
  if (card.notes.length) lines.push('### 备注', ...card.notes.map((n) => `- ${n}`), '');
  return scrubModelNames(lines.join('\n'));
}

function scrubCard(card: ResultCard): ResultCard {
  const s = scrubModelNames;
  return {
    ...card,
    title: s(card.title),
    summary: s(card.summary),
    changes: card.changes.map(s),
    evidence: card.evidence.map((e) => ({ ...e, text: s(e.text) })),
    review: { ...card.review, items: card.review.items.map(s) },
    flags: card.flags.map((f) => ({ ...f, why: s(f.why) })),
    notes: card.notes.map(s),
    ...(card.learned ? { learned: card.learned.map(s) } : {}),
    ...(card.prError ? { prError: s(card.prError) } : {}),
  };
}

/** Clones the repository into ~/work, makes the task branch and prints `BASE=<branch>`. */
export function setupScript(repo: string, branch: string): string {
  const slug = repoSlug(repo);
  return [
    'set -e',
    'cd ~',
    'rm -rf work',
    `gh repo clone ${shq(slug)} work -- --depth 100 2>&1 || git clone --depth 100 ${shq(`https://github.com/${slug}.git`)} work 2>&1`,
    'cd work',
    'git config user.name >/dev/null || git config user.name "Maka"',
    'git config user.email >/dev/null || git config user.email "maka@users.noreply.github.com"',
    // No "Co-Authored-By" or "Generated with" lines from the coding agent.
    `mkdir -p ~/.claude && python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
try:
    s = json.load(open(p))
except Exception:
    s = {}
s['includeCoAuthoredBy'] = False
s['attribution'] = {'commit': '', 'pr': ''}
json.dump(s, open(p, 'w'), indent=2)
PY`,
    'BASE=$(git rev-parse --abbrev-ref HEAD)',
    `git checkout -b ${shq(branch)}`,
    'echo "BASE=$BASE"',
  ].join('\n');
}

/** `owner/name` from what the owner typed: a slug, an https URL or an ssh URL. */
export function repoSlug(input: string): string {
  const match = input.trim().match(/(?:github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u);
  if (!match) throw new Error(`看不懂这个仓库：${input}`);
  return match[1]!;
}

const NO_NAMES = 'Never name any AI model, AI vendor or AI coding tool in anything you write.';

function planPrompt(goal: string, notes: readonly string[]): string {
  return `You are a senior software engineer starting a task in the git repository at ~/work (already cloned, on a fresh branch).

The owner's request:
"""
${goal}
"""
${notesBlock(notes)}
First read enough of the repository to understand it: the README, the package manifest, how tests run, and the code the request touches. Do not change any file yet.

Then answer with a work order: one JSON object in a \`\`\`json block, shaped like this:
{"outcome": "one sentence", "done_means": ["checkable result", "..."], "out_of_scope": ["..."], "assumptions": ["..."], "test_command": "the shell command, run from ~/work, that runs the tests that matter here", "questions": [{"question": "...", "default": "the answer you will use if the owner says nothing"}]}

Rules:
- Write outcome, done_means, out_of_scope, assumptions and questions in Simplified Chinese.
- Ask at most 3 questions, and only ones whose answer changes what you build. Each has a default. Zero questions is best when the request is clear.
- test_command must work in this repository as it is (install dependencies first in it if they are missing, e.g. "npm ci && npm test").
- ${NO_NAMES}`;
}

function buildPrompt(order: WorkOrder, answers: string[]): string {
  const qa = (order.questions ?? [])
    .map((q, i) => `- ${q.question} → ${answers[i]?.trim() || q.default}`)
    .join('\n');
  return `The owner approved the work order.${qa ? `\nTheir answers:\n${qa}` : ''}

Now do the work in ~/work, on the current branch:
- Make the change so that every item of done_means holds. Add or update tests that prove it.
- Run \`${order.test_command ?? 'the tests'}\` and keep going until it passes.
- Never delete, skip, loosen or rewrite an existing test or assertion to make it pass. If an existing test is wrong, leave it, and say why in notes.
- Commit your work with clear messages, without any co-author or "generated with" lines. Do not push.
- ${NO_NAMES}

Finish with one \`\`\`json block for the owner, in Simplified Chinese:
{"summary": "two sentences: what you did", "changes": ["file or area: what changed"], "verified": ["how you checked it"], "notes": ["anything the owner should know"], "lessons": ["at most 3 durable facts about working in this repository that would save the next task time: a command that works, a setup step, a pitfall. Not about this change. Empty when there is nothing new."]}`;
}

function lookBackPrompt(error: string): string {
  return `The task stopped without finishing. What stopped it:
"""
${error}
"""

Do not change any file. Look back at what you tried in this conversation, and write down what the next attempt in this repository should know from the start: a command that works or does not, a setup step, a pitfall, what to check first. Only durable facts about working here, not blame and not this task's plan. Zero lessons is fine.

Answer with one \`\`\`json block, in Simplified Chinese: {"lessons": ["at most 3 short lines"]}
${NO_NAMES}`;
}

function reviewPrompt(task: Task, order: WorkOrder): string {
  return `You are an independent senior reviewer. Do not change any file.

In ~/work, review the change on the current branch: run \`git diff ${task.base}...HEAD\` and read the code around it.

The owner asked for:
"""
${task.goal}
"""
The work order says it is done when:
${order.done_means.map((d) => `- ${d}`).join('\n')}

Check, in this order: does it really meet the request; correctness bugs; missing or weak tests; and whether any existing test was deleted, skipped, loosened or edited to pass (a fix, or a sidestep?). Report only real problems; an empty list is a good answer.

Answer with one \`\`\`json block:
{"verdict": "ship" or "fix", "findings": [{"severity": "high" | "medium" | "low", "file": "path", "issue": "the problem, in Simplified Chinese", "fix": "what to do, in Simplified Chinese"}]}
${NO_NAMES}`;
}

function fixPrompt(order: WorkOrder, findings: Finding[], checks: Checks): string {
  const items = findings.map(
    (f, i) =>
      `${i + 1}. [${f.severity}] ${f.file ?? ''} ${f.issue}${f.fix ? ` — suggested: ${f.fix}` : ''}`,
  );
  if (!checks.testsOk)
    items.push(
      `Our own run of \`${order.test_command}\` failed:\n${tail(checks.testOutput, 1500)}`,
    );
  for (const flag of checks.flags)
    items.push(
      `Our check flagged ${flag.file}: ${flag.why}. Restore the existing test unless the request requires changing it, and explain.`,
    );
  return `An independent review and our own checks found these problems:
${items.join('\n')}

Fix each one, or explain in notes why it is not a problem. Run \`${order.test_command ?? 'the tests'}\` again until it passes, and commit. Same rules as before: never weaken an existing test, no co-author lines, do not push. ${NO_NAMES}

Finish with the same \`\`\`json summary block as before, updated.`;
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const MAX_ACTIVITY = 400;

function record(task: Task, entry: Omit<Activity, 'at'>): void {
  task.activity.push({
    at: Date.now(),
    ...entry,
    title: scrubModelNames(entry.title),
    ...(entry.detail ? { detail: scrubModelNames(entry.detail) } : {}),
    ...(entry.output ? { output: scrubModelNames(entry.output) } : {}),
  });
  if (task.activity.length > MAX_ACTIVITY)
    task.activity.splice(0, task.activity.length - MAX_ACTIVITY);
}

function toolActivity(name: string, input: unknown): Pick<Activity, 'kind' | 'detail'> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  const lower = name.toLowerCase();
  const detail =
    text('command') ?? text('cmd') ?? text('file_path') ?? text('path') ?? text('pattern');
  const kind: Activity['kind'] = /bash|shell|exec|command|terminal/u.test(lower)
    ? 'run'
    : /edit|write|patch|apply/u.test(lower)
      ? 'edit'
      : /read|view|open/u.test(lower)
        ? 'read'
        : /grep|search|glob|find|ls/u.test(lower)
          ? 'search'
          : 'other';
  return { kind, ...(detail ? { detail: clip(detail, 300) } : {}) };
}

/** `git diff` output, one entry per file, with its added and removed line counts. */
export function splitDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/mu)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const path =
      chunk.match(/^\+\+\+ b\/(.+)$/mu)?.[1] ??
      chunk.match(/^diff --git a\/(.+?) b\//u)?.[1] ??
      '?';
    let added = 0;
    let removed = 0;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    files.push({ path, added, removed, patch: chunk.slice(0, 60_000) });
  }
  return files;
}
