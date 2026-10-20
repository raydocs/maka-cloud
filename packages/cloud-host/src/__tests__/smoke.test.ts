import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPEN_PULL_REQUEST_TOOL } from '@maka-cloud/playbooks/coding';
import {
  defaultCodingPrompt,
  formatSmokeReport,
  ledgersAgree,
  runSmoke,
  type SmokeDeps,
  type SmokeOptions,
  type SmokeQuestion,
  type SmokeTask,
  type SmokeTotals,
  smokeGate,
} from '../smoke.js';

const REPO = 'scratch-owner/scratch-repo';

interface Faults {
  researchFails?: boolean;
  noPullRequestLink?: boolean;
  cancelNeverConfirmed?: boolean;
  spendAfterCancel?: boolean;
  capIgnored?: boolean;
  ledgerMismatch?: boolean;
  restartNeverReturns?: boolean;
  stuckAfterRestart?: boolean;
  startWithServerSpend?: number;
  unexpectedIrreversible?: boolean;
  pullRequestOnWrongRepo?: boolean;
}

interface Conversation {
  tasks: SmokeTask[];
  questions: SmokeQuestion[];
  transcript: string[];
  work: Map<
    string,
    { kind: 'research' | 'coding'; ticks: number; asked: boolean; approved: boolean }
  >;
}

/** A pretend server, driven by the smoke test's own sleeps: one `tick` per sleep. */
class World implements SmokeDeps {
  clock = 0;
  lines: string[] = [];
  conversations = new Map<string, Conversation>();
  gateway = new Map<string, number>();
  inviteDay = 0;
  serverDay: number;
  cap: number | undefined;
  capCalls: Array<number | undefined> = [];
  answers: Array<{ questionId: string; optionId: string }> = [];
  cancels: string[] = [];
  restarts = 0;
  unhealthyFor = 0;
  network = 0;
  private next = 0;
  private cancelling = new Map<string, number>();
  private zombies = new Set<string>();
  private frozen = new Set<string>();

  constructor(readonly faults: Faults = {}) {
    this.serverDay = faults.startWithServerSpend ?? 0;
  }

  now = () => this.clock;
  log = (line: string) => this.lines.push(line);

  async sleep(ms: number): Promise<void> {
    this.clock += ms;
    this.tick();
  }

  private spend(taskId: string, usd: number): boolean {
    if (
      this.cap !== undefined &&
      !this.faults.capIgnored &&
      this.inviteDay + usd > this.cap + 1e-9
    ) {
      return false;
    }
    this.gateway.set(taskId, (this.gateway.get(taskId) ?? 0) + usd);
    this.inviteDay += usd;
    this.serverDay += usd;
    return true;
  }

  private tick(): void {
    if (this.unhealthyFor > 0) this.unhealthyFor -= 1;
    for (const [id, conversation] of this.conversations) {
      for (const task of conversation.tasks) {
        const work = conversation.work.get(task.taskId);
        const left = this.cancelling.get(task.taskId);
        if (left !== undefined) {
          if (this.faults.spendAfterCancel) this.spend(task.taskId, 0.01);
          if (left <= 1 && !this.faults.cancelNeverConfirmed) {
            task.stopPending = false;
            task.treeStopPending = false;
            this.cancelling.delete(task.taskId);
            if (this.faults.spendAfterCancel) this.zombies.add(task.taskId);
          } else this.cancelling.set(task.taskId, left - 1);
          continue;
        }
        if (this.zombies.has(task.taskId)) this.spend(task.taskId, 0.01);
        if (this.frozen.has(task.taskId)) continue;
        if (!work || ['succeeded', 'failed', 'cancelled'].includes(task.state)) continue;
        if (task.state === 'queued') {
          task.state = 'running';
          continue;
        }
        if (!this.spend(task.taskId, 0.01)) {
          task.state = 'failed';
          task.failureReason = 'a spending limit stopped this work';
          continue;
        }
        work.ticks -= 1;
        if (work.ticks > 0) continue;
        if (work.kind === 'coding' && !work.approved) {
          if (!work.asked) {
            work.asked = true;
            conversation.questions.push({
              questionId: `q_${id}`,
              reason: 'irreversible',
              question: `Open a pull request on ${this.faults.pullRequestOnWrongRepo ? 'someone/else' : REPO}?`,
              options: [
                { id: 'approve', label: 'Go ahead' },
                { id: 'reject', label: 'Do not' },
              ],
              recommended: 'approve',
              action: {
                tool: this.faults.unexpectedIrreversible ? 'delete_branch' : OPEN_PULL_REQUEST_TOOL,
              },
            });
          }
          const answered = this.answers.find((a) => a.questionId === `q_${id}`);
          if (answered?.optionId === 'approve') work.approved = true;
          else if (answered) {
            task.state = 'failed';
            task.failureReason = 'the pull request was not approved';
            continue;
          } else {
            work.ticks = 1;
            continue;
          }
        }
        if (work.kind === 'research' && this.faults.researchFails) {
          task.state = 'failed';
          task.failureReason = 'the run crashed';
          continue;
        }
        task.state = 'succeeded';
        const spent = this.gateway.get(task.taskId) ?? 0;
        task.costUsd = this.faults.ledgerMismatch ? spent * 3 + 1 : spent;
        if (work.kind === 'coding' && !this.faults.noPullRequestLink) {
          conversation.transcript.push(`Opened https://github.com/${REPO}/pull/7 for you.`);
        }
      }
    }
  }

  async startConversation(): Promise<string> {
    const id = `cnv_${++this.next}`;
    this.conversations.set(id, { tasks: [], questions: [], transcript: [], work: new Map() });
    return id;
  }

  async say(conversationId: string, text: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    assert.ok(conversation, 'a known conversation');
    conversation.transcript.push(`you: ${text}`);
    const kind = text.includes('pull request')
      ? 'coding'
      : text.startsWith('Are you')
        ? undefined
        : 'research';
    if (kind === undefined) return;
    const taskId = `tsk_${++this.next}`;
    conversation.tasks.push({ taskId, state: 'queued' });
    conversation.work.set(taskId, { kind, ticks: 3, asked: false, approved: false });
  }

  async tasks(conversationId: string): Promise<SmokeTask[]> {
    return structuredClone(this.conversations.get(conversationId)?.tasks ?? []);
  }

  async openQuestions(conversationId: string): Promise<SmokeQuestion[]> {
    const conversation = this.conversations.get(conversationId);
    return (conversation?.questions ?? []).filter(
      (q) => !this.answers.some((a) => a.questionId === q.questionId),
    );
  }

  async answer(_conversationId: string, questionId: string, optionId: string): Promise<void> {
    this.answers.push({ questionId, optionId });
  }

  async transcript(conversationId: string): Promise<string[]> {
    return [...(this.conversations.get(conversationId)?.transcript ?? [])];
  }

  async cancel(taskId: string): Promise<void> {
    this.cancels.push(taskId);
    for (const conversation of this.conversations.values()) {
      const task = conversation.tasks.find((candidate) => candidate.taskId === taskId);
      if (!task) continue;
      task.state = 'cancelled';
      task.stopPending = true;
      task.treeStopPending = true;
      this.cancelling.set(taskId, 2);
    }
  }

  async restart(): Promise<void> {
    this.restarts += 1;
    this.unhealthyFor = this.faults.restartNeverReturns ? Number.POSITIVE_INFINITY : 3;
    for (const conversation of this.conversations.values()) {
      for (const task of conversation.tasks) {
        if (task.state !== 'running' && task.state !== 'queued') continue;
        if (this.faults.stuckAfterRestart) this.frozen.add(task.taskId);
        else task.state = 'cancelled';
      }
    }
  }

  async healthy(): Promise<boolean> {
    return this.unhealthyFor <= 0;
  }

  async totals(): Promise<SmokeTotals> {
    return {
      taskUsd: new Map(this.gateway),
      inviteDayUsd: this.inviteDay,
      serverDayUsd: this.serverDay,
    };
  }

  async setDailyCap(usd: number | undefined): Promise<void> {
    this.capCalls.push(usd);
    this.cap = usd;
  }
}

const options: SmokeOptions = {
  repo: REPO,
  maxUsd: 5,
  pollMs: 1_000,
  settleMs: 5_000,
  scenarioTimeoutMs: 60_000,
  restartTimeoutMs: 30_000,
};

const NAMES = [
  'research task',
  'coding task and pull request',
  'cancel mid-run',
  'budget stop',
  'ledgers agree',
  'restart',
];

const byName = (report: Awaited<ReturnType<typeof runSmoke>>) =>
  Object.fromEntries(report.results.map((result) => [result.name, result]));

test('a dry run against a healthy fake server passes every scenario, in order, and prints the two ledgers', async () => {
  const world = new World();
  const report = await runSmoke(world, options);
  assert.deepEqual(
    report.results.map((result) => result.name),
    NAMES,
  );
  assert.deepEqual(
    report.results.filter((result) => !result.ok),
    [],
  );
  assert.equal(report.ok, true);
  // The only approval given is the pull request on the scratch repository.
  assert.deepEqual(
    world.answers.map((answer) => answer.optionId),
    ['approve'],
  );
  assert.equal(world.cancels.length, 1);
  assert.equal(world.restarts, 1);
  // The cap is set for the budget stop and put back, once.
  assert.equal(world.capCalls.length, 2);
  assert.equal(world.capCalls[1], undefined);
  assert.equal(report.ledger.length >= 3, true);
  const printed = formatSmokeReport(report).join('\n');
  assert.match(printed, /PASS  research task/u);
  assert.match(printed, /Ledger \(orchestrator task cost \| gateway journal\)/u);
  assert.match(printed, /All scenarios passed/u);
});

test('a failing research task is reported, and the other scenarios still run', async () => {
  const world = new World({ researchFails: true });
  const report = await runSmoke(world, options);
  const results = byName(report);
  assert.equal(results['research task']?.ok, false);
  assert.match(results['research task']?.detail ?? '', /failed: the run crashed/u);
  assert.equal(report.ok, false);
  assert.equal(report.results.length, NAMES.length);
  assert.match(formatSmokeReport(report).join('\n'), /Some scenarios failed/u);
});

test('the coding scenario fails when no pull request link appears, and approves nothing else', async () => {
  const none = await runSmoke(new World({ noPullRequestLink: true }), options);
  const result = byName(none)['coding task and pull request'];
  assert.equal(result?.ok, false);
  assert.match(result?.detail ?? '', /timed out waiting for the pull request link/u);

  const wrongRepo = new World({ pullRequestOnWrongRepo: true });
  const report = await runSmoke(wrongRepo, options);
  assert.equal(byName(report)['coding task and pull request']?.ok, false);
  assert.deepEqual(
    wrongRepo.answers.map((answer) => answer.optionId),
    ['reject'],
    'a pull request on any other repository is rejected',
  );

  const other = new World({ unexpectedIrreversible: true });
  await runSmoke(other, options);
  assert.deepEqual(
    other.answers.map((answer) => answer.optionId),
    ['reject'],
    'so is any other irreversible action',
  );
});

test('a stop that is never confirmed, or spend that goes on after a cancel, fails the cancel scenario', async () => {
  const unconfirmed = await runSmoke(new World({ cancelNeverConfirmed: true }), options);
  const a = byName(unconfirmed)['cancel mid-run'];
  assert.equal(a?.ok, false);
  assert.match(a?.detail ?? '', /timed out waiting for the stop to be confirmed/u);

  const spending = await runSmoke(new World({ spendAfterCancel: true }), { ...options });
  const b = byName(spending)['cancel mid-run'];
  assert.equal(b?.ok, false);
  assert.match(b?.detail ?? '', /kept spending/u);
});

test('a cap that does not hold fails the budget scenario, and the cap is put back either way', async () => {
  const ignored = new World({ capIgnored: true });
  const report = await runSmoke(ignored, options);
  const result = byName(report)['budget stop'];
  assert.equal(result?.ok, false);
  assert.match(result?.detail ?? '', /succeeded although|past its cap/u);
  assert.equal(ignored.capCalls.at(-1), undefined, 'the cap was restored after the failure');

  const held = new World();
  const fine = await runSmoke(held, options);
  assert.equal(byName(fine)['budget stop']?.ok, true);
  assert.equal(held.capCalls.length, 2);
});

test('ledgers that differ are named, with both numbers', async () => {
  const report = await runSmoke(new World({ ledgerMismatch: true }), options);
  const result = byName(report)['ledgers agree'];
  assert.equal(result?.ok, false);
  assert.match(result?.detail ?? '', /cnv_\d+ orchestrator \$\d+\.\d{4} vs gateway \$\d+\.\d{4}/u);
  assert.ok(report.ledger.some((row) => !row.ok));
  assert.match(formatSmokeReport(report).join('\n'), /MISMATCH/u);
  assert.equal(ledgersAgree(0.01, 0.015), true);
  assert.equal(ledgersAgree(1, 1.09), true);
  assert.equal(ledgersAgree(1, 1.5), false);
  assert.equal(ledgersAgree(0, 0.02), false);
});

test('a server that does not come back, or leaves work running after a restart, fails the restart scenario', async () => {
  const gone = await runSmoke(new World({ restartNeverReturns: true }), options);
  assert.match(
    byName(gone).restart?.detail ?? '',
    /timed out waiting for the server to come back/u,
  );
  const stuck = await runSmoke(new World({ stuckAfterRestart: true }), options);
  assert.equal(byName(stuck).restart?.ok, false);
  assert.match(
    byName(stuck).restart?.detail ?? '',
    /timed out waiting for the stop to be confirmed/u,
  );
});

test('once the owner’s budget is reached nothing else starts', async () => {
  const world = new World({ startWithServerSpend: 5 });
  const report = await runSmoke(world, options);
  assert.equal(report.ok, false);
  assert.match(byName(report)['research task']?.detail ?? '', /reaches the budget of \$5\.0000/u);
  for (const result of report.results.slice(1)) {
    assert.match(result.detail, /budget/u, result.name);
  }
  assert.equal(world.conversations.size, 0, 'no conversation was even opened');
  assert.deepEqual(world.capCalls, []);
});

test('the budget is checked between scenarios, so the run stops soon after it is reached', async () => {
  const world = new World({ startWithServerSpend: 4.995 });
  const report = await runSmoke(world, { ...options, maxUsd: 5 });
  const names = report.results.filter((result) => result.ok).map((result) => result.name);
  assert.ok(names.length < NAMES.length, 'it did not run to the end');
  assert.match(report.results.at(-1)?.detail ?? '', /budget/u);
});

const GOOD_ENV = {
  MAKA_CLOUD_LIVE: '1',
  MAKA_CLOUD_SMOKE_URL: 'https://maka.example.test',
  MAKA_CLOUD_SMOKE_TOKEN: 'mki_inv_0123456789ab.secret-secret-secret',
  MAKA_CLOUD_SMOKE_INVITE_ID: 'inv_0123456789ab',
  MAKA_CLOUD_SMOKE_REPO: REPO,
  MAKA_CLOUD_SMOKE_MAX_USD: '5',
  MAKA_CLOUD_DATA_DIR: '/srv/maka',
  MAKA_CLOUD_SMOKE_RESTART_CMD: '["systemctl","restart","maka-cloud"]',
};

test('the smoke test refuses to start unless MAKA_CLOUD_LIVE is exactly 1, whatever else is set', () => {
  for (const live of [undefined, '', '0', 'true', 'yes', '1 ', 'TRUE', '11']) {
    const gate = smokeGate({ ...GOOD_ENV, MAKA_CLOUD_LIVE: live });
    if (live === '1 ') {
      assert.equal(gate.ok, false, 'no trimming: it is exactly 1');
    }
    assert.equal(gate.ok, false, String(live));
    if (!gate.ok) assert.match(gate.problems.join(' '), /MAKA_CLOUD_LIVE=1/u);
  }
  assert.equal(smokeGate(GOOD_ENV).ok, true);
  assert.equal(smokeGate({}).ok, false);
});

test('with the gate open each missing or bad setting is named, and no value is repeated', () => {
  const secretToken = GOOD_ENV.MAKA_CLOUD_SMOKE_TOKEN;
  for (const [name, bad, pattern] of [
    ['MAKA_CLOUD_SMOKE_URL', undefined, /MAKA_CLOUD_SMOKE_URL is not set/u],
    ['MAKA_CLOUD_SMOKE_URL', 'ftp://x', /http or https/u],
    ['MAKA_CLOUD_SMOKE_URL', 'https://user:pw@maka.example.test', /without credentials/u],
    ['MAKA_CLOUD_SMOKE_TOKEN', undefined, /MAKA_CLOUD_SMOKE_TOKEN is not set/u],
    ['MAKA_CLOUD_SMOKE_INVITE_ID', 'someone', /invite id/u],
    ['MAKA_CLOUD_SMOKE_REPO', 'just-a-name', /owner\/name/u],
    ['MAKA_CLOUD_SMOKE_MAX_USD', undefined, /MAKA_CLOUD_SMOKE_MAX_USD is not set/u],
    ['MAKA_CLOUD_SMOKE_MAX_USD', '0', /above 0/u],
    ['MAKA_CLOUD_SMOKE_MAX_USD', '5000', /above 0/u],
    ['MAKA_CLOUD_SMOKE_MAX_USD', 'five', /above 0/u],
    ['MAKA_CLOUD_DATA_DIR', undefined, /MAKA_CLOUD_DATA_DIR is not set/u],
    ['MAKA_CLOUD_SMOKE_RESTART_CMD', 'systemctl restart maka-cloud', /JSON array/u],
    ['MAKA_CLOUD_SMOKE_RESTART_CMD', '[]', /JSON array/u],
    ['MAKA_CLOUD_SMOKE_RESTART_CMD', '[1]', /JSON array/u],
  ] as const) {
    const gate = smokeGate({ ...GOOD_ENV, [name]: bad });
    assert.equal(gate.ok, false, `${name}=${String(bad)}`);
    if (!gate.ok) {
      const text = gate.problems.join('\n');
      assert.match(text, pattern, `${name}=${String(bad)}`);
      assert.ok(!text.includes(secretToken));
    }
  }
  const open = smokeGate(GOOD_ENV);
  assert.ok(open.ok);
  if (open.ok) {
    assert.deepEqual(open.settings.restartCommand, ['systemctl', 'restart', 'maka-cloud']);
    assert.equal(open.settings.maxUsd, 5);
    assert.equal(open.settings.url, 'https://maka.example.test');
  }
});

test('the default prompts name the scratch repository and ask for one small change', () => {
  assert.match(defaultCodingPrompt(REPO), new RegExp(REPO, 'u'));
  assert.match(defaultCodingPrompt(REPO), /pull request/u);
});
