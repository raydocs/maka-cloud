import {
  driveTurn,
  emptyExecutorUsage,
  executorSystemPrompt,
  type Executor,
  type ExecutorKind,
  type ExecutorUsage,
} from './executor.js';
import type { ReviewerPort } from './review.js';
import { actMandate } from './types.js';

/** The other vendor reviews: Claude Code's work goes to Codex and back. */
export function crossVendorKind(kind: ExecutorKind): 'claude-code' | 'codex' {
  return kind === 'codex' ? 'claude-code' : 'codex';
}

export interface ExecutorReviewRecord {
  ref: string;
  verdict: 'CLEAR' | 'BLOCK' | undefined;
  usage: ExecutorUsage;
  ms: number;
}

/**
 * A `ReviewerPort` that runs a coding CLI (usually the other vendor's) as a
 * fresh read-only session on the checkout that holds the commit. Each review
 * is its own session, so the reviewer never sees the author's context.
 */
export class ExecutorReviewer implements ReviewerPort {
  readonly records: ExecutorReviewRecord[] = [];

  constructor(
    private readonly executor: Executor,
    private readonly options: {
      /** Where the commit is checked out: a host dir, or the box's checkout. */
      locate(input: { repo: string; number: number; sha: string }): {
        workdir: string;
        boxId?: string;
        /**
         * How to read the change. Default `git diff <sha>^!`; a box checkout
         * whose edits are not committed there passes `git status --short && git diff HEAD`.
         */
        show?: string;
      };
      model?: string;
      now?: () => number;
    },
  ) {}

  async review(input: { repo: string; number: number; sha: string }): Promise<{ text: string }> {
    const now = this.options.now ?? Date.now;
    const started = now();
    const where = this.options.locate(input);
    const show = where.show ?? `git diff ${input.sha}^!`;
    const brief = [
      `Review pull request ${input.repo}#${input.number} at commit ${input.sha}.`,
      `Read the change with \`${show}\` and the files it touches. Run the tests if that helps.`,
      'Do not edit, commit or push anything: this is a review only.',
      'Look for correctness bugs, missing tests and unsafe changes. List findings by severity, each with file:line and why.',
      'End with the status line; its summary must start with `VERDICT: CLEAR` (nothing blocking) or `VERDICT: BLOCK` (a finding must be fixed first), then one short reason.',
    ].join('\n');
    const mandate = actMandate([input.repo]);
    const turn = await this.executor.start({
      workerId: `review-${input.repo}#${input.number}@${input.sha.slice(0, 12)}`,
      ticket: brief,
      mandate,
      workdir: where.workdir,
      systemPrompt: executorSystemPrompt(
        mandate,
        "You are reviewing someone else's change. Never modify the checkout.",
      ),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(where.boxId ? { boxId: where.boxId } : {}),
    });
    const ran = await driveTurn(turn);
    const terminal = ran.terminal;
    // Only a ready turn's final summary can carry the verdict. Any other
    // `VERDICT:` text (progress, errors) is defused so it cannot make a receipt.
    const verdictLine =
      terminal.type === 'ready' ? /^(VERDICT:\s*(CLEAR|BLOCK)\b.*)$/m.exec(terminal.summary) : null;
    const context =
      terminal.type === 'ready'
        ? [...ran.progress.slice(-5), terminal.summary].join('\n')
        : terminal.type === 'failed'
          ? `reviewer failed: ${terminal.error}`
          : `reviewer stopped (${terminal.type})`;
    const defused = context.replace(/VERDICT:/g, 'verdict:');
    const text = verdictLine ? `${defused}\n${verdictLine[1]}` : defused;
    this.records.push({
      ref: `${input.repo}#${input.number}@${input.sha}`,
      verdict: verdictLine?.[2] as 'CLEAR' | 'BLOCK' | undefined,
      usage: { ...emptyExecutorUsage(), ...ran.usage },
      ms: now() - started,
    });
    await this.executor.stop(turn.session).catch(() => undefined);
    return { text };
  }
}
