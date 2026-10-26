# Working like an employee: brief once, then work, never grind

Owner direction (2026-10-26): Maka Cloud is a software employee. The owner gives an instruction the way a manager
does, often a vague one. The employee asks the few questions that matter, then works on its own until the job is
done or it is truly stuck, and reports like a colleague. Two failure modes are ruled out:

- **Grinding.** A goal loop that keeps trying the same thing when it cannot succeed, burning money and time.
- **Gaming.** Turning "do better than the competitor" into "make the score read 95" and meeting the number instead
  of the need: weakening a test, special-casing its input, skipping what fails.

This note takes how a good engineer handles an assignment and turns each habit into a piece of the product. It
builds on `autonomy.md` (scorecard, autonomy levels) and `coding-playbook.md` (the runner's loop), and does not
repeat them.

## What a good engineer does, and what Maka does today

| Habit | Maka today | Gap |
|---|---|---|
| Restates the assignment, asks only what would change the approach, writes down the rest as assumptions, then starts | The conductor may ask only `taste`, `budget_overrun` or `irreversible`, and otherwise "picks the reasonable reading" silently (`cloud-conductor/src/prompts.ts`) | No up-front work order; assumptions are made but not shown |
| Treats the metric as evidence of the goal, not the goal | Agents are told never to use hidden tests (`NO_TAMPERING`, `coding/briefs.ts`); the hidden tests grade outside the runner; a second vendor reviews; the scorecard counts false confidence | Nothing in code notices a change that weakens or sidesteps the checks it is graded by |
| Time-boxes, changes approach once, then escalates with options | The coding runner stops edit loops, hands over after two failures to the other vendor once, and writes `failure_brief.json`; supervisor R4 flags a task with no events for a while | The conductor can delegate again after a failure with no cap but money and steps; a run that is busy but not progressing is not caught above the runner; the end of the road is a "not done" message, not a decision the owner can take in one tap |
| Reports what was done, the proof, and the judgment calls made | The result card carries the proof (reproduction, checks, review) | Assumptions and judgment calls are not listed |
| Is not told the same correction twice | C4 in `autonomy.md` | open, not in this note |

## 1. The work order

Before any delegation, the conductor writes a **work order**: one structured card, not prose.

- **Outcome**: what the owner will see when it is done, in their terms ("the export no longer drops rows with
  accents"), never a metric alone.
- **Done means**: the checks that will show the outcome (the reproduction test, the repository's tests, the review),
  and, when the instruction named a metric, the metric listed here as evidence.
- **Out of scope**: what the employee will not touch. Always includes "existing tests, test configuration and CI
  are not weakened" unless the instruction is about them.
- **Assumptions**: each reading the conductor chose where the instruction was open, one line each.
- **Questions**: at most three, and only where the answer changes the plan. Each carries a default that is used if
  the owner does not answer. A question whose answer would not change the plan is an assumption instead.

Flow:

- No questions: the work order is shown and the run starts at once. The card is a receipt, not a gate.
- Questions: the run waits. The owner answers or taps **Start with defaults**. One tap, never a form.
- After the start, the run asks nothing more except the existing gates (`budget_overrun`, `irreversible`) and the
  stuck report (section 3). `taste` questions after the start are folded into assumptions.

Mechanism:

- A new conductor tool `post_work_order` with a typed body (the five fields above, capped lengths), called once per
  run before the first `delegate_task`. `delegate_task` refuses a run without a work order. The order is stored with
  the run and is the first item of the run's timeline.
- A new `ask_user` reason, `work_order`, used only by that tool; its answer is the owner's answers or "defaults".
  The existing per-run question cap counts it as one.
- The work order's out-of-scope and assumption lines go into every brief the run delegates, as data in the brief's
  fenced block, so a runner sees the same contract the owner saw.
- The prompt change lives in `conductorSystemPrompt`. It is byte-stable per session, so only new sessions get it,
  and earlier turns are never rewritten.

## 2. Integrity: the checks are evidence, not the target

The runner already decides "verified" from checks it runs itself. What is missing is noticing a change that makes
the checks pass by changing the checks. This must be code on the host, not a prompt.

**Integrity scan.** After a change is read out (step 7 of the coding task), the runner compares it with the base
commit and records `integrity` in `verification.json`:

- test files that existed at the base and are modified or deleted (a test file is one the repository's own
  conventions mark as a test: path patterns per ecosystem, plus files the reproduction test's command runs);
- added skip or focus markers (`.skip(`, `.only(`, `xit(`, `@pytest.mark.skip`, `#[ignore]`, `t.Skip(` and the like);
- changed snapshot files;
- changes to how tests run: the test script in the package manifest, test runner configuration, CI workflow files,
  coverage thresholds;
- fewer assertions in the changed test files than at the base (a count, per ecosystem, deliberately rough).

Each flag names its file and hunk. The scan reads files on the host from the delivered change, so nothing in the
sandbox can hide from it, and it is deterministic, so no model writes a flag.

**What a flag does.**

- A change with any flag is not **hands-off** (`handsOff` in `cloud-evals/src/proof.ts` gains the condition), unless
  the work order's outcome is about those files and the owner's instruction said so.
- The reviewer gets the flagged hunks as data with one fixed question: "Does this change fix the problem, or make
  the checks stop seeing it?" Its answer is a finding like any other; "sidesteps the check" is a P1.
- The result card shows the flags under the proof, plainly ("changed an existing test: `export.test.ts`, 2
  assertions removed").

**Measuring it.** The scorecard adds two numbers: the share of delivered changes with integrity flags, and the
**shortcut rate** on a small set of eval tasks built to tempt a shortcut (a hidden test that catches a special case
for the visible test's input). A change to prompts or modes that raises either is a regression, whatever it does to
the resolve rate.

## 3. No grinding: progress, one change of approach, then a stuck report

The coding runner's loop is already bounded (two failures per vendor, one handover, edit-loop detection, budget).
The gaps are above it and at its end.

**Same failure twice is information.** When the other vendor fails on the same thing as the first (the same failing
test or check, the same first error line after normalising paths and numbers), the runner records `sameFailure`
in the failure brief. Two different agents failing identically points at the environment or the task statement, not
the code, and the stuck report says so instead of suggesting a third try.

**A cap on failed delegations per run.** The conductor's state already keys delegations per run. After two
delegations of a run end not verified, `delegate_task` refuses further delegations for that run and tells the
conductor to write the stuck report. The coding playbook already says never to start a second attempt; this makes it
true for every playbook, in code.

**Busy is not progress.** Supervisor R4 sees silence. A run that keeps producing events without moving is caught by
a progress check on the run: no new verified result, no new passing check and no new file changed for a window
(default 20 minutes of agent time) while spend keeps rising. It raises the same stuck report rather than an inbox
"no progress" item.

**The stuck report.** A new `ask_user` reason, `stuck`, with a typed body:

- what was tried (each attempt in one line, from the failure briefs, not from a model's memory);
- where it is stuck (the failing check and its output tail, scrubbed);
- the employee's diagnosis, with `sameFailure` when it applies;
- two to four options, each with what it costs, and one marked recommended. Options are things the owner can grant
  in one tap: more budget for a named approach, a narrower scope, a different base, "stop here and keep what was
  done".

The run ends its turn after the report. The owner's tap continues the same run with that option as the next
instruction. A stuck report is never an approval: it grants nothing an approval gate guards.

## 4. The result card

The result card adds one section, **Calls I made**: each assumption from the work order with how it turned out, and
each integrity flag with the reason given. The proof stays as it is.

## Order of work

1. **Integrity scan** and the `handsOff` condition, with the reviewer question. Smallest, and it protects the
   scorecard every later change is measured on.
2. **Failed-delegation cap**, `sameFailure` and the **stuck report**.
3. **Work order**: the tool, the reason, the prompt change, the web and phone card.
4. **Progress check** on busy runs.
5. **Calls I made** on the result card.
6. Scorecard: integrity-flag share and the shortcut suite.

Each step is measured on the scorecard before and after (`autonomy.md`). Hands-off rate must not fall and false
confidence must not rise, except where step 1 lowers hands-off by catching changes that were wrongly counted.

## Tests

- A change that edits an existing test, adds a skip, updates a snapshot or changes the test script carries the flag;
  a change that only adds a new test file does not; a flagged change is never hands-off.
- The reviewer receives the flagged hunks and the fixed question; a "sidesteps the check" finding is a P1 and keeps
  the change for the owner.
- `delegate_task` without a work order is refused; a third delegation after two unverified ones is refused with the
  instruction to report.
- Two vendor failures with the same normalised first error set `sameFailure`; different ones do not.
- A work order with questions waits; "Start with defaults" starts with the defaults recorded as assumptions; one
  without questions starts at once; a fourth question is refused.
- A stuck report's options continue the same run; choosing one grants nothing an approval gate guards.
- The work order and stuck report are scrubbed like any text a person reads, and outside text in them is quoted as
  data (T15).
