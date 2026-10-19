import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import {
  type AttemptStore,
  type CellAttempt,
  type EvalResult,
  expandExperiment,
  runExperiment,
  selectCellResult,
} from '@maka/eval';
import { createCloudEvals } from '../cloud.js';
import { VendorAloneDriver } from '../drivers.js';
import { outcomeOf } from '../sandbox-ops.js';
import { BudgetLedger } from '../ledger.js';
import { makeSpec } from '../spec-gen.js';
import {
  DriverError,
  type DriverInput,
  type DriverResult,
  type Grader,
  type HiddenTests,
  type HiddenTestSource,
  type SubjectDriver,
} from '../types.js';
import { FakeRunner, FakeSandbox, deferred, finishWith } from './fakes.js';
import { TASK, tempDir } from './fixtures.js';

class MemoryStore implements AttemptStore {
  readonly attempts = new Map<string, CellAttempt[]>();

  async list(cellId: string): Promise<readonly CellAttempt[]> {
    return this.attempts.get(cellId) ?? [];
  }

  async append(attempt: CellAttempt): Promise<void> {
    this.attempts.set(attempt.cellId, [...(this.attempts.get(attempt.cellId) ?? []), attempt]);
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return await operation();
  }
}

const HIDDEN: HiddenTests = {
  suite: 'swe-bench-verified',
  testPatch: 'SECRET-TEST-PATCH',
  failToPass: ['tests/test_secret.py::test_hidden_one'],
  passToPass: ['tests/test_secret.py::test_hidden_two'],
};

const RESOLVING: Grader = { grade: async () => ({ resolved: true, detail: 'ok' }) };

function spec(options: { subjects?: ('codex' | 'claude-agent-sdk')[]; total?: number } = {}) {
  return makeSpec({
    suite: 'swe-bench-verified',
    tasks: [TASK],
    benchmarkVersion: 'test',
    subjects: options.subjects ?? ['codex'],
    taskBudgetUsd: 2,
    totalBudgetUsd: options.total ?? 100,
    timeoutSeconds: 60,
    mode: 'dry-run',
  });
}

function driverOf(run: (input: DriverInput) => Promise<DriverResult>): SubjectDriver {
  return { run };
}

const finished = (costUsd: number | null, patch = 'diff\n+1\n'): DriverResult => ({
  outcome: outcomeOf(patch, ['a.py']),
  costUsd,
  end: 'finished',
  failureReason: null,
});

async function setup(
  t: TestContext,
  options: {
    driver: SubjectDriver | ((id: string) => SubjectDriver);
    grader?: Grader;
    hidden?: HiddenTestSource;
    total?: number;
    subjects?: ('codex' | 'claude-agent-sdk')[];
    signal?: AbortSignal;
  },
) {
  const workRoot = await tempDir(t);
  const experiment = spec(options);
  const ledger = new BudgetLedger(options.total ?? 100);
  const pick = options.driver;
  const { executor, subject } = createCloudEvals({
    mode: 'dry-run',
    drivers: new Map(
      experiment.subjects.map((s) => [s.id, typeof pick === 'function' ? pick(s.id) : pick]),
    ),
    grader: options.grader ?? RESOLVING,
    hidden: options.hidden ?? { load: async () => HIDDEN },
    ledger,
    workRoot,
  });
  const store = new MemoryStore();
  const run = () =>
    runExperiment({
      spec: experiment,
      store,
      executor,
      subjects: [subject],
      ...(options.signal ? { signal: options.signal } : {}),
    });
  const results = (): EvalResult[] =>
    expandExperiment(experiment).flatMap((cell) =>
      (store.attempts.get(cell.id) ?? []).map((attempt) => attempt.result),
    );
  /** The attempts are gone, the reservation is back, the private directories are removed. */
  const assertClean = async () => {
    assert.equal(ledger.openReservations, 0, 'a budget reservation was left open');
    assert.equal(ledger.reservedUsd, 0);
    assert.deepEqual(await readdir(workRoot), [], 'an attempt directory was left behind');
  };
  return { run, store, ledger, results, assertClean, experiment };
}

test('a resolved cell: score 1, cost from the run, outcome and grade recorded, everything released', async (t) => {
  const s = await setup(t, { driver: driverOf(async () => finished(0.5)) });
  await s.run();
  const [result] = s.results();
  assert.equal(result?.status, 'completed');
  assert.equal(result?.score, 1);
  assert.equal(result?.costUsd, 0.5);
  assert.deepEqual(
    result?.artifacts.map((artifact) => artifact.kind),
    ['outcome', 'grade'],
  );
  assert.equal(s.ledger.spentUsd, 0.5);
  await s.assertClean();
});

test('an unresolved cell scores 0 and is still completed', async (t) => {
  const s = await setup(t, {
    driver: driverOf(async () => finished(0.5)),
    grader: { grade: async () => ({ resolved: false, detail: 'no' }) },
  });
  await s.run();
  assert.equal(s.results()[0]?.score, 0);
  assert.equal(s.results()[0]?.status, 'completed');
});

test('a run that finished with no change scores 0 without calling the grader', async (t) => {
  let graded = 0;
  const s = await setup(t, {
    driver: driverOf(async () => ({
      outcome: null,
      costUsd: 0.9,
      end: 'finished',
      failureReason: 'there is no change against the base commit',
    })),
    grader: { grade: async () => ((graded += 1), { resolved: true, detail: '' }) },
  });
  await s.run();
  assert.equal(graded, 0);
  assert.equal(s.results()[0]?.score, 0);
  assert.equal(s.results()[0]?.status, 'completed');
});

test("status: a failure or timeout after spending is the subject's, scored 0, and not retried", async (t) => {
  for (const end of ['failed', 'timeout'] as const) {
    const s = await setup(t, {
      driver: driverOf(async () => ({
        outcome: null,
        costUsd: 1.2,
        end,
        failureReason: 'stopped',
      })),
    });
    await s.run();
    const result = s.results()[0];
    assert.equal(result?.status, 'subject_failed', end);
    assert.equal(result?.score, 0, end);
    assert.equal(result?.costUsd, 1.2);
    assert.ok(
      selectCellResult(s.store.attempts.get(`${TASK.id}::1::codex`) ?? []),
      'the verdict stands',
    );
  }
});

test('status: a failure before any spend is infrastructure and the cell is replaceable', async (t) => {
  const s = await setup(t, {
    driver: driverOf(async () => ({
      outcome: null,
      costUsd: null,
      end: 'failed',
      failureReason: 'sandbox unreachable',
    })),
  });
  await s.run();
  assert.equal(s.results()[0]?.status, 'infra_failed');
  assert.equal(selectCellResult(s.store.attempts.get(`${TASK.id}::1::codex`) ?? []), undefined);
});

test('status: a driver error keeps what was spent; a grader error is infrastructure', async (t) => {
  const thrown = await setup(t, {
    driver: driverOf(async () => {
      throw new DriverError('could not confirm the run stopped', 0.7);
    }),
  });
  await thrown.run();
  assert.equal(thrown.results()[0]?.status, 'infra_failed');
  assert.equal(thrown.results()[0]?.costUsd, 0.7);
  assert.equal(thrown.ledger.spentUsd, 0.7);
  await thrown.assertClean();

  const graderFails = await setup(t, {
    driver: driverOf(async () => finished(0.4)),
    grader: {
      grade: async () => {
        throw new Error('docker is down');
      },
    },
  });
  await graderFails.run();
  const result = graderFails.results()[0];
  assert.equal(result?.status, 'infra_failed');
  assert.match(result?.failureReason ?? '', /docker is down/u);
  assert.equal(result?.costUsd, 0.4, "the subject's cost is kept");
  await graderFails.assertClean();
});

test('exit: an abort reaches the driver, ends the cell as indeterminate and releases everything', async (t) => {
  const controller = new AbortController();
  const entered = deferred();
  const s = await setup(t, {
    signal: controller.signal,
    driver: driverOf(async (input) => {
      entered.resolve();
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve()));
      return { outcome: null, costUsd: 0.2, end: 'cancelled', failureReason: null };
    }),
  });
  const running = s.run();
  await entered.promise;
  controller.abort();
  await running;
  assert.equal(s.results()[0]?.status, 'indeterminate');
  assert.equal(s.ledger.spentUsd, 0.2);
  await s.assertClean();
});

test('exit: a driver that throws without a cost is charged its whole cap, and released', async (t) => {
  const s = await setup(t, {
    driver: driverOf(async () => {
      throw new Error('boom');
    }),
  });
  await s.run();
  assert.equal(s.results()[0]?.status, 'infra_failed');
  assert.equal(s.ledger.spentUsd, 2, 'spend is unknown after a start, so the cap is charged');
  await s.assertClean();
});

test('exit: a cell that never reached its driver is charged nothing', async (t) => {
  const s = await setup(t, { driver: driverOf(async () => finished(0)) });
  const reservation = s.ledger.reserve('other', 99);
  assert.ok(reservation);
  await s.run();
  assert.equal(s.results()[0]?.status, 'infra_failed');
  assert.equal(s.results()[0]?.failureReason, 'executor preparation failed');
  assert.equal(s.ledger.spentUsd, 0);
});

test('budget: two cells that start together cannot both fit when only one does', async (t) => {
  const release = deferred();
  const entered = deferred();
  let calls = 0;
  const s = await setup(t, {
    subjects: ['codex', 'claude-agent-sdk'],
    total: 2,
    driver: driverOf(async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
      return finished(1);
    }),
  });
  const running = s.run();
  await entered.promise;
  // The second cell has been turned away while the first is still inside its driver.
  assert.equal(calls, 1);
  assert.equal(s.ledger.reservedUsd, 2);
  release.resolve();
  await running;
  const statuses = s
    .results()
    .map((result) => result.status)
    .sort();
  assert.deepEqual(statuses, ['completed', 'infra_failed']);
  assert.equal(s.ledger.spentUsd, 1);
  await s.assertClean();
});

test('validation: an unknown subject, a missing budget and live Terminal-Bench are refused', async (t) => {
  const workRoot = await tempDir(t);
  const make = (mode: 'dry-run' | 'live') =>
    createCloudEvals({
      mode,
      drivers: new Map([['codex', driverOf(async () => finished(0))]]),
      grader: RESOLVING,
      hidden: { load: async () => HIDDEN },
      ledger: new BudgetLedger(10),
      workRoot,
    });
  const [cell] = expandExperiment(spec());
  assert.ok(cell);
  make('dry-run').executor.validate?.(cell);
  assert.throws(
    () => make('dry-run').subject.validate?.({ ...cell, subject: { ...cell.subject, id: 'gpt' } }),
    /unknown subject/u,
  );
  assert.throws(
    () => make('dry-run').executor.validate?.({ ...cell, budget: {} }),
    /taskBudgetUsd/u,
  );
  const terminal = { ...cell, task: { ...cell.task, config: { suite: 'terminal-bench' } } };
  make('dry-run').executor.validate?.(terminal);
  assert.throws(() => make('live').executor.validate?.(terminal), /dry-run only/u);
});

test('hidden tests reach the grader only after the subject is stopped and its sandbox returned, and never the sandbox', async (t) => {
  const log: string[] = [];
  const sandbox = new FakeSandbox({ log, patch: 'diff --git a/a b/a\n+fix\n' });
  const runner = new FakeRunner('codex', log);
  runner.onStart = finishWith(0.8);
  const driver = new VendorAloneDriver({ runner, sandbox });
  const s = await setup(t, {
    driver,
    hidden: {
      load: async (id) => {
        log.push('hidden:load');
        assert.equal(id, TASK.id);
        return HIDDEN;
      },
    },
    grader: {
      grade: async ({ hidden }) => {
        log.push('grade');
        assert.equal(hidden.testPatch, 'SECRET-TEST-PATCH');
        return { resolved: true, detail: 'ok' };
      },
    },
  });
  await s.run();
  assert.equal(s.results()[0]?.score, 1);
  const at = (entry: string) => log.indexOf(entry);
  assert.ok(at('stopAll:done') !== -1 && at('release') !== -1 && at('hidden:load') !== -1);
  assert.ok(
    at('stopAll:done') < at('hidden:load'),
    'hidden tests loaded before the run was stopped',
  );
  assert.ok(
    at('release') < at('hidden:load'),
    'hidden tests loaded before the sandbox was returned',
  );
  assert.ok(at('hidden:load') < at('grade'));

  const secrets = [HIDDEN.testPatch, ...HIDDEN.failToPass, ...HIDDEN.passToPass, 'test_hidden_one'];
  const everything = [
    ...sandbox.sent,
    JSON.stringify(s.experiment),
    JSON.stringify([...s.store.attempts.values()]),
    ...runner.runs.map((run) => run.spec.briefPath),
  ].join('\n');
  for (const secret of secrets) assert.ok(!everything.includes(secret), `${secret} leaked`);
});
