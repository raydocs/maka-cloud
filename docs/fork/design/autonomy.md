# Working on its own

The goal: the owner states what they want and approves the result, and nothing in between needs them. Today a person
still does six jobs by hand around every run: choosing the work, checking the result, getting an outside review and
turning its findings into fixes, giving the same correction again, deciding how far to trust a change, and judging
whether the last change to the system helped. Each job below becomes a piece of the product. Measurement comes first,
because without it every later step is tuned by feel.

| Job done by hand today | Product piece | Status |
|---|---|---|
| Judge whether a change to the system helped | **Scorecard** (`cloud-evals scorecard`): resolve rate, hands-off rate, false confidence, cost, against a baseline run | this change |
| Check that a result is right | Proof block: reproduction test, the repository's tests, a second vendor's review (`verification.json`, C5) | built; the PR body is #332 |
| Run an outside review and turn findings into fix PRs | Review loop: P1 and P2 findings go back to the implementer until the review is clean or a round or dollar cap is reached | built: up to `fixRounds` (default 3) rounds, each re-checked and reviewed afresh, recorded in `review.fix` |
| Choose what to work on | Intake: failing CI (C2), GitHub issues (C3) and the employee's own suggestions (T30) start tasks | T30 built; C2, C3 open |
| Give the same correction again | Repository conventions (C4) and memory: a correction given twice becomes a rule every brief carries | open |
| Decide how far to trust a change | Autonomy levels per repository, earned on the scorecard (below) | open |

## The scorecard

It reads a `cloud-evals` run and answers two questions: can a subject work on its own yet, and did the last change
help. Per subject:

- **Resolved**: cells the hidden tests accept.
- **Hands-off**: the change was delivered with a reproduction test, a second agent's review and no open P1, so nothing
  was left for the owner (`handsOff` in `src/proof.ts`). Only the coding playbook keeps the record this is read from.
- **False confidence**: of the hands-off changes, the share the hidden tests reject. This is the number that decides
  whether a change may merge without being read.
- **Cost per resolved task** and **median time**.

Against a baseline run it lists, per subject, the tasks now fixed and now broken, and a sign test over the two counts
says `better`, `worse` or `no clear change` (p < 0.05). Deltas are over the tasks both runs have. A dry run fills
every column from deterministic fakes, so the scorecard can be checked without spending.

```
cloud-evals run spec.json --out run-002
cloud-evals scorecard run-002 --baseline run-001     # writes run-002/report/scorecard.md and .json
```

A live run follows the harness's budget rule (`benchmark-harness.md`): nothing runs `--live` without the owner's
approval of the dollar amount. Fifty tasks, three subjects and a $5 cap per cell is at most $750.

## Autonomy levels

Per repository, starting at level 1.

| Level | The employee may | Earned by |
|---|---|---|
| 0 | propose tasks; the owner starts each one | the owner's choice |
| 1 | start tasks and open pull requests; the owner merges | default |
| 2 | merge its own hands-off changes once the repository's CI is green | the scorecard says "Merge on its own? yes": at least 30 hands-off changes seen, at most 5% of them wrong |

A merged change that is reverted drops the repository to level 1 until a new scorecard run earns level 2 again.
Anything the approval gates already guard (an irreversible tool, egress, spend over a cap) asks the owner at every
level. Level 2 is off by default and is turned on per repository by the owner.

## Order of work

1. **Measure.** The scorecard (this change), then a first live baseline on the SWE-bench Verified 50 once the owner
   approves its budget.
2. **A suite from our own work.** SWE-bench is Python libraries; the work Maka does here is TypeScript in a monorepo.
   Tasks mined from this repository's merged fix pull requests: the parent commit, a statement written from the pull
   request's title and description (never its diff), and as hidden tests the test files the pull request added, which
   must fail on the parent and pass on the merge. Packages that test on their own (`cloud-design`, `cloud-client`)
   come first, because a full monorepo build does not fit in a check's time limit.
3. **Close the review loop.** Findings go back for fixing until the review is clean, within a round and dollar cap.
   Built: up to three fix rounds by default (`limits.fixRounds`), each re-running the checks and a fresh review by
   the other vendor, within the review's share of the budget; a P1 left at the end keeps the change for the owner
   (see the coding playbook). Kept only if a scorecard run shows the hands-off rate up and false confidence not up.
4. **Intake.** Failing CI and labelled issues start tasks on their own (C2, C3). Nothing merges at level 1.
5. **Remember corrections** (C4), measured on the suite from step 2.
6. **Autonomy level 2**, per repository, once its scorecard earns it.
7. **Dogfood.** Maka works this repository's own backlog, including the outside reviews that are run by hand today.
