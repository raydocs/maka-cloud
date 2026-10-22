import { randomUUID } from 'node:crypto';
import { InstaboxOperationError, isQuotaExceeded } from '@maka-cloud/instabox';
import type { InstaboxApiError, InstaboxMachine } from '@maka-cloud/instabox';
import type { TaskId } from '@maka-cloud/orchestrator';
import type { AgentChannel, SandboxLease, SandboxProvider } from '@maka-cloud/runners';
import {
  boxLabels,
  boxName,
  builderLabels,
  builderName,
  checkBox,
  isBuilderBox,
  LABEL,
} from './labels.js';
import { REPOS_ROOT, type BuilderBoxes } from './snapshots.js';
import { AGENT_CHECK_SCRIPT, agentProblems, asRepoUser } from './agent.js';
import {
  BoxRefusedError,
  NoFreeBoxError,
  type BoxApi,
  type BoxPoolOptions,
  type BoxUseReason,
  type SetupChoice,
} from './types.js';

const DEFAULT_MAX_PER_INVITE = 3;
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_LIMIT_RECHECK_MS = 600_000;
/** Amp's rule: sleep when the agent has done nothing for 5 minutes and nobody has looked for 20. */
const DEFAULT_AGENT_IDLE_MS = 5 * 60_000;
const DEFAULT_USER_IDLE_MS = 20 * 60_000;
/** A wake that times out is tried once more with a longer limit before the box counts as lost. */
const DEFAULT_WAKE_TIMEOUTS_MS = [60_000, 180_000] as const;
const SLEEP_RETRY_MS = 5 * 60_000;
const DEFAULT_LOST_GRACE_MS = 30 * 60_000;
const DEFAULT_LOST_DELETE_MS = 24 * 60 * 60_000;
const CLEANUP_RETRY_MS = 30 * 60_000;
const CHECKPOINT_TIMEOUT_SECONDS = 30;
const DEFAULT_RESUME_TIMEOUT_SECONDS = 120;
/** Runs `.agents/resume` of the box's checkout when the repository has one. */
const RESUME_SCRIPT = `[ -d "$MAKA_REPO_DIR" ] || exit 0
cd "$MAKA_REPO_DIR"
[ -x .agents/resume ] || exit 0
exec ./.agents/resume`;

/**
 * `suspending` is a box being put to sleep: while it is still in its `checkpoint` phase a task may
 * take it (that cancels the sleep); once the suspend is issued it is not available until it is
 * `suspended`. A `suspended` box is taken by waking it (`waking`).
 */
type BoxState =
  | 'creating'
  | 'ready'
  | 'claimed'
  | 'suspending'
  | 'suspended'
  | 'waking'
  | 'lost'
  /** Its labels or name no longer say it is this pool's box for this slot: never used, never relabelled. */
  | 'refused'
  /** Being checked for deletion: nothing may take it. */
  | 'deleting';

/**
 * `adopted` marks a claim held by the task itself rather than by a run: one found in the labels after a
 * restart, or one whose run gave its lease back while the task was still live (the task keeps its box
 * across its runs). No lease object will ever release it; `reconcile` (or the next ask for a box of the
 * invite) frees it once the task has ended.
 */
type Holder = symbol | 'adopted';

interface Box {
  tenantId: string;
  slot: number;
  /** Unset while the box is being created. */
  machineId: string | undefined;
  state: BoxState;
  taskId: TaskId | undefined;
  holder: Holder | undefined;
  /** The conversation of the last task that held it, so its next task prefers this box. */
  conversationId: string | undefined;
  setup: string | undefined;
  /** The `repoKey` of the repository whose checkout the box holds, when it was made from a setup snapshot. */
  repo: string | undefined;
  /** While the box is being made: a second ask by the same task waits on it. */
  creation: Promise<void> | undefined;
  /** While the box is being woken: a second ask by the same task waits on it. True when it woke. */
  waking: Promise<boolean> | undefined;
  /** When the box last had no task (the agent's idleness is counted from here). */
  idleSince: number;
  /** The last time a person looked at the box (a terminal or desktop view), if ever. */
  userSeenAt: number | undefined;
  sleepPhase: 'checkpoint' | 'suspend' | undefined;
  /**
   * Counts every change of who has the box (a claim, a sleep that starts). A sleep remembers the
   * count it began with and stops acting on the box when the count has moved, even if the state
   * reads the same again (a task took the box and gave it back).
   */
  generation: number;
  /** When the box was marked lost. */
  lostAt: number | undefined;
  /** No sleep attempt before this time, after one that failed or was turned back. */
  sleepAfter: number;
  /** Label writes of this box run one after another; each sends what the box is by then. */
  labels: Promise<void>;
}

interface Waiter {
  tenantId: string;
  taskId: TaskId;
  choice: SetupChoice | undefined;
  settle: (finish: () => Promise<Held>) => void;
  fail: (error: Error) => void;
  timer: unknown;
}

/** What a task wants of the box it gets. */
interface Want {
  /** Restoring a task: a box made from this task snapshot. */
  snapshotId?: string;
  /** The setup snapshot of the task's repository. */
  choice?: SetupChoice;
}

/** A box taken by one `acquire`, with the claim token only that call's lease may release. */
interface Held {
  box: Box;
  holder: symbol;
}

type Plan =
  | { kind: 'have'; box: Box; holder: symbol; choice?: SetupChoice }
  | {
      kind: 'create';
      box: Box;
      holder: symbol;
      why: BoxUseReason;
      snapshotId?: string;
      choice?: SetupChoice;
    }
  | { kind: 'none' };

/**
 * A pool of labelled instabox boxes per invite, handed out one task at a time.
 *
 * - A box is found by its labels and used only when they all match; anything else is refused.
 * - One task per box. A task asks again and gets its own box back (`acquire` is idempotent per
 *   task), and a lease that was replaced by a newer one frees nothing.
 * - Boxes are made when a task needs one, up to `maxPerInvite`, and never more than the account
 *   allows: the limit is learned from instabox's refusal, and a task waits (bounded) rather than fail
 *   while its invite has a box it can wait for.
 * - Every decision about shared state (is it free, who has it, may I make one) is made in one
 *   synchronous step, before any await, so two callers cannot take the same box or the last slot.
 */
export class BoxPool implements SandboxProvider {
  private readonly api: BoxApi;
  private readonly maxPerInvite: number;
  private readonly waitMs: number;
  private readonly limitRecheckMs: number;
  private readonly agentIdleMs: number;
  private readonly userIdleMs: number;
  private readonly wakeTimeoutsMs: readonly number[];
  private sweeping: Promise<string[]> | undefined;
  private cleaning: Promise<CleanupResult> | undefined;
  private readonly refused: { machineId: string; reason: string }[] = [];
  private readonly lostGraceMs: number;
  private readonly lostDeleteMs: number;
  private readonly idleDeleteMs: number | undefined;
  private readonly now: () => number;
  private readonly timers: NonNullable<BoxPoolOptions['timers']>;
  private readonly tenants = new Map<string, Map<number, Box>>();
  private readonly waiters: Waiter[] = [];
  private discovery: Promise<void> | undefined;
  /** Boxes whose agent account passed the check in this process. */
  private readonly agentChecked = new Set<string>();
  /** Invites with a builder box in this process. */
  private readonly builders = new Set<string>();
  /** A builder box of an invite that could not be deleted: the next build removes it first. */
  private readonly leftoverBuilders = new Map<string, string>();
  private closed = false;
  /** Creates (of task boxes and builders) under way, for `settled`. */
  private readonly inFlight = new Set<Promise<void>>();
  /** The most boxes the account let the pool have, once instabox refused a create. */
  private learned: { boxes: number; at: number } | undefined;

  constructor(private readonly options: BoxPoolOptions) {
    this.api = options.api;
    this.maxPerInvite = options.maxPerInvite ?? DEFAULT_MAX_PER_INVITE;
    if (!Number.isInteger(this.maxPerInvite) || this.maxPerInvite < 1 || this.maxPerInvite > 32) {
      throw new Error('BoxPool: maxPerInvite must be an integer from 1 to 32');
    }
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.limitRecheckMs = options.limitRecheckMs ?? DEFAULT_LIMIT_RECHECK_MS;
    this.agentIdleMs = options.idle?.agentMs ?? DEFAULT_AGENT_IDLE_MS;
    this.userIdleMs = options.idle?.userMs ?? DEFAULT_USER_IDLE_MS;
    this.lostGraceMs = options.cleanup?.lostGraceMs ?? DEFAULT_LOST_GRACE_MS;
    this.lostDeleteMs = options.cleanup?.lostDeleteMs ?? DEFAULT_LOST_DELETE_MS;
    this.idleDeleteMs = options.cleanup?.idleDeleteMs;
    this.wakeTimeoutsMs = options.wakeTimeoutsMs ?? DEFAULT_WAKE_TIMEOUTS_MS;
    if (this.wakeTimeoutsMs.length === 0) throw new Error('BoxPool: wakeTimeoutsMs is empty');
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  // -- SandboxProvider ---------------------------------------------------------------------------

  async acquire(input: { tenantId: string; taskId: TaskId }): Promise<SandboxLease> {
    this.assertOpen();
    await this.discovered();
    const choice = await this.setupChoice(input.tenantId, input.taskId);
    return this.lease(await this.take(input.tenantId, input.taskId, choice));
  }

  private async setupChoice(tenantId: string, taskId: TaskId): Promise<SetupChoice | undefined> {
    try {
      const choice = await this.options.setupOf?.(tenantId, taskId);
      if (choice !== undefined && choice.tenantId !== tenantId) {
        // A snapshot of another invite is never a start for this one, whatever the lookup said.
        this.options.onWarning?.(
          `the setup snapshot ${choice.snapshotId} is not this invite's; starting from the template`,
        );
        return undefined;
      }
      return choice;
    } catch (error) {
      // No setup snapshot is not a reason to keep the task from a box.
      this.options.onWarning?.(`could not look up the setup snapshot for task ${taskId}`, error);
      return undefined;
    }
  }

  /**
   * A new box from `snapshotId` for a task whose box is gone. The task's old box is forgotten (the
   * runner asks only after it found the box deleted or broken), and the new one takes a missing
   * slot. With none missing it fails at once instead of waiting: nothing here would free one.
   */
  async restoreFromSnapshot(input: {
    tenantId: string;
    taskId: TaskId;
    snapshotId: string;
  }): Promise<SandboxLease> {
    this.assertOpen();
    await this.discovered();
    await this.dropBoxOf(input.tenantId, input.taskId);
    this.assertOpen();
    const plan = this.plan(input.tenantId, input.taskId, { snapshotId: input.snapshotId });
    if (plan.kind !== 'create') {
      throw new NoFreeBoxError(
        'no box slot is free to restore the task into (every slot of the invite is in use, or the account limit is reached)',
      );
    }
    return this.lease(await this.finish(plan));
  }

  async knownMachines(): Promise<string[]> {
    await this.discovered();
    const ids: string[] = [];
    for (const boxes of this.tenants.values()) {
      for (const box of boxes.values()) if (box.machineId !== undefined) ids.push(box.machineId);
    }
    return ids;
  }

  // -- life --------------------------------------------------------------------------------------

  /**
   * Frees claims found after a restart whose task is no longer live. A claim held by a lease in this
   * process is never touched here: its own run releases it.
   */
  async reconcile(): Promise<void> {
    await this.discovered();
    for (const boxes of this.tenants.values()) {
      for (const box of boxes.values()) {
        if (
          box.holder === 'adopted' &&
          box.taskId !== undefined &&
          !this.options.isTaskLive(box.taskId)
        ) {
          this.free(box);
        }
      }
    }
  }

  /** Rejects every waiting task and refuses new ones. Boxes and claims are left as they are. */
  dispose(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.fail(new Error('the box pool was shut down'));
    }
  }

  /**
   * Boxes for `SetupSnapshots` to build in. A builder is its own sandbox, made from the template for
   * the build and deleted when it is given back: a snapshot of a box a task used would carry that
   * task's files, and the three task boxes of an invite are soon all used. It is guarded first like any
   * box, is outside the pool's slots (it is never handed to a task, put to sleep or counted for them),
   * and there is one at a time per invite. A refusal for the account's limit is a `NoFreeBoxError`.
   */
  builderBoxes(): BuilderBoxes {
    return {
      lease: async ({ tenantId, job }) => {
        this.assertOpen();
        await this.discovered();
        if (this.builders.has(tenantId)) {
          throw new NoFreeBoxError('a setup snapshot is already being built for this invite');
        }
        const leftover = this.leftoverBuilders.get(tenantId);
        if (leftover !== undefined) {
          // The fixed name is still taken by the box an earlier build could not delete.
          try {
            await this.removeBox(leftover);
            this.leftoverBuilders.delete(tenantId);
          } catch (error) {
            throw new NoFreeBoxError(
              `an earlier builder box of this invite could not be deleted yet: ${errorText(error)}`,
            );
          }
        }
        this.assertOpen();
        this.builders.add(tenantId);
        let machineId: string | undefined;
        try {
          const name = builderName(tenantId);
          let machine: InstaboxMachine;
          try {
            const creating = (async () => {
              const operation = await this.api.createMachine(
                {
                  name,
                  ...this.options.source(tenantId),
                  metadata: builderLabels(tenantId, job),
                },
                { idempotencyKey: `maka-box-${name}-${randomUUID()}` },
              );
              machineId = operation.machineId;
              await this.api.waitForOperation(operation.id);
              return await this.api.getMachine(operation.machineId);
            })();
            this.track(creating);
            machine = await creating;
          } catch (error) {
            if (isQuotaExceeded(error)) {
              throw new NoFreeBoxError('the account has no room for a builder box right now');
            }
            throw error;
          }
          machineId = machine.id;
          if (!isBuilderBox(machine, tenantId)) {
            throw new BoxRefusedError(`the builder box ${machine.id} does not carry its labels`);
          }
          await this.options.beforeUse?.(machine.id, 'create');
          const id = machine.id;
          let released = false;
          return {
            machineId: id,
            release: async () => {
              if (released) return;
              released = true;
              try {
                await this.removeBox(id);
              } catch (error) {
                // Removed before the next build of this invite, or at the next start.
                this.leftoverBuilders.set(tenantId, id);
                this.options.onWarning?.(`could not delete builder box ${id}`, error);
              } finally {
                this.builders.delete(tenantId);
              }
            },
          };
        } catch (error) {
          if (machineId !== undefined) {
            const id = machineId;
            await this.removeBox(id).catch((e) => {
              this.leftoverBuilders.set(tenantId, id);
              this.options.onWarning?.(`could not delete builder box ${id}`, e);
            });
          }
          this.builders.delete(tenantId);
          throw error;
        }
      },
    };
  }

  /** How many tasks wait for a box, of one invite or of all. */
  waiting(tenantId?: string): number {
    return this.waiters.filter((w) => tenantId === undefined || w.tenantId === tenantId).length;
  }

  /** What the pool holds, for the operator and tests. */
  state(): {
    tenantId: string;
    slot: number;
    machineId?: string;
    state: string;
    taskId?: string;
  }[] {
    const rows = [];
    for (const [tenantId, boxes] of this.tenants) {
      for (const box of boxes.values()) {
        rows.push({
          tenantId,
          slot: box.slot,
          ...(box.machineId === undefined ? {} : { machineId: box.machineId }),
          state: box.state,
          ...(box.taskId === undefined ? {} : { taskId: box.taskId }),
        });
      }
    }
    return rows;
  }

  // -- taking a box ------------------------------------------------------------------------------

  private async take(tenantId: string, taskId: TaskId, choice?: SetupChoice): Promise<Held> {
    // The pool may have been shut down while this ask awaited the listing or the setup lookup.
    this.assertOpen();
    this.freeEnded(tenantId);
    const plan = this.plan(tenantId, taskId, choice === undefined ? {} : { choice });
    return plan.kind === 'none'
      ? await this.wait(tenantId, taskId, choice)
      : await this.finish(plan);
  }

  /**
   * Decides, in one synchronous step, which box this task gets, and marks it taken. Nothing
   * awaits between the check and the mark.
   */
  private plan(tenantId: string, taskId: TaskId, want: Want = {}): Plan {
    const { snapshotId, choice } = want;
    const boxes = this.boxesOf(tenantId);
    for (const box of boxes.values()) {
      if (box.taskId === taskId && box.state !== 'lost' && box.state !== 'refused') {
        // The same task again (a resume, a repeated call): the same box, with a newer lease. The
        // older call's lease no longer matches the claim, so releasing it frees nothing.
        const holder = Symbol('lease');
        box.holder = holder;
        return { kind: 'have', box, holder, ...(choice === undefined ? {} : { choice }) };
      }
    }
    if (snapshotId === undefined) {
      const conversationId = this.options.conversationOf?.(taskId);
      // A box that is awake first, then one still being put to sleep, then a sleeping one (waking
      // it is cheaper than making a box); within those, the conversation's own, then the lowest slot.
      const rank = (box: Box): number =>
        box.state === 'ready' ? 0 : box.state === 'suspended' ? 2 : 1;
      const free = [...boxes.values()]
        .filter(
          (box) =>
            box.state === 'ready' ||
            box.state === 'suspended' ||
            (box.state === 'suspending' && box.sleepPhase === 'checkpoint'),
        )
        .sort(
          (a, b) =>
            Number(conversationId !== undefined && b.conversationId === conversationId) -
              Number(conversationId !== undefined && a.conversationId === conversationId) ||
            Number(choice !== undefined && b.setup === choice.setupHash) -
              Number(choice !== undefined && a.setup === choice.setupHash) ||
            rank(a) - rank(b) ||
            a.slot - b.slot,
        )[0];
      if (free) {
        const holder = this.claim(free, taskId);
        return { kind: 'have', box: free, holder, ...(choice === undefined ? {} : { choice }) };
      }
    }
    if (this.atAccountLimit()) return { kind: 'none' };
    for (let slot = 0; slot < this.maxPerInvite; slot++) {
      if (boxes.has(slot)) continue;
      const box = this.newBox(tenantId, slot);
      boxes.set(slot, box);
      const holder = this.claim(box, taskId);
      box.state = 'creating';
      return {
        kind: 'create',
        box,
        holder,
        why: snapshotId === undefined ? 'create' : 'restore',
        ...(snapshotId === undefined ? {} : { snapshotId }),
        ...(choice === undefined || snapshotId !== undefined ? {} : { choice }),
      };
    }
    return { kind: 'none' };
  }

  private claim(box: Box, taskId: TaskId): symbol {
    // Taking a box that is going to sleep turns the sleep back; taking a sleeping one wakes it.
    box.state =
      box.machineId === undefined ? 'creating' : box.state === 'suspended' ? 'waking' : 'claimed';
    box.sleepPhase = undefined;
    box.generation++;
    box.taskId = taskId;
    const holder = Symbol('lease');
    box.holder = holder;
    const conversationId = this.options.conversationOf?.(taskId);
    if (conversationId !== undefined) box.conversationId = conversationId;
    return holder;
  }

  /** The async tail of a decision: write the label, or make the box. A failure gives the box back. */
  private async finish(plan: Exclude<Plan, { kind: 'none' }>): Promise<Held> {
    const { box, holder } = plan;
    const taskId = box.taskId as TaskId;
    try {
      if (plan.kind === 'create') {
        box.creation = this.create(plan);
        this.track(box.creation);
        await box.creation;
      } else {
        // A task that asks again while its box is still being made waits for the same creation.
        await box.creation;
        // The labels are read again before a cached box is handed out: whoever changed them, the box
        // is no longer known to be this pool's, and writing our labels over them would hide that.
        if (!(await this.stillOurs(box, holder))) {
          return await this.take(box.tenantId, taskId, plan.choice);
        }
        if (box.state === 'waking') {
          box.waking ??= this.wake(box);
          if (!(await box.waking)) return await this.take(box.tenantId, taskId, plan.choice);
        }
        await this.writeLabels(box);
        // A newer ask of the same task may have refused, lost or dropped the box meanwhile; such a
        // box is never handed out, the task takes another.
        if (!this.isHeldBy(box, taskId)) return await this.take(box.tenantId, taskId, plan.choice);
      }
      if (this.closed) {
        // Shut down while this ask was under way: nothing is handed out, and the claim is given back.
        if (box.holder === holder) this.giveBack(box);
        await box.labels;
        throw new PoolClosedError();
      }
      return { box, holder };
    } catch (error) {
      if (error instanceof PoolClosedError) throw error;
      if (plan.kind === 'create') {
        // A box that was accepted but could not be read back stays, as lost.
        if (box.state !== 'lost') this.forget(box);
        else this.pump(box.tenantId);
      } else if (box.holder === holder) this.free(box);
      // The account has no room for another box but the invite has boxes: wait for one of them.
      if (error instanceof QuotaWait) {
        if (plan.kind === 'create' && plan.why === 'restore') {
          throw new NoFreeBoxError(
            "the account's sandbox limit is reached, so the task cannot be restored into a new box",
          );
        }
        return await this.wait(box.tenantId, taskId, plan.choice);
      }
      throw error;
    } finally {
      if (plan.kind === 'create') box.creation = undefined;
    }
  }

  /**
   * Reads the box again and checks its whole identity (pool label, invite, slot, name, and that no
   * other live task holds it). False when the box was refused or is gone and the caller must take
   * another; true when it is fine, or when a newer ask of the same task took the claim over.
   */
  private async stillOurs(box: Box, holder: symbol): Promise<boolean> {
    const machineId = box.machineId as string;
    let machine: InstaboxMachine;
    try {
      machine = await this.api.getMachine(machineId);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      if (box.holder === holder) this.forget(box);
      return box.holder !== holder;
    }
    if (box.holder !== holder) return true;
    if (machine.state === 'deleted' || machine.state === 'deleting') {
      this.forget(box);
      return false;
    }
    const why = this.identityProblem(box, machine, box.taskId);
    if (why === undefined) return true;
    this.quarantine(box, why);
    return false;
  }

  /**
   * Why a fetched machine is not this box (undefined when it is). A task label that names a live task
   * other than `ownTask` (the task the box is held for, if any) is a problem too.
   */
  private identityProblem(
    box: Box,
    machine: InstaboxMachine,
    ownTask: TaskId | undefined,
  ): string | undefined {
    const checked = checkBox(
      machine,
      { maxPerInvite: this.maxPerInvite },
      { tenantId: box.tenantId, slot: box.slot },
    );
    if (!checked.ok) return checked.reason;
    if (machine.id !== box.machineId) return 'it is not the machine the pool recorded';
    if (
      checked.taskId !== undefined &&
      checked.taskId !== ownTask &&
      this.options.isTaskLive(checked.taskId)
    ) {
      return `task ${checked.taskId} holds it`;
    }
    return undefined;
  }

  /**
   * Takes a box whose identity changed out of use. It keeps its slot (nothing is made over it) and its
   * labels (nothing is written to it), is listed by `refusedBoxes`, and is deleted by no one here.
   */
  private quarantine(box: Box, why: string): void {
    this.refuse(box.machineId as string, why);
    box.state = 'refused';
    box.sleepPhase = undefined;
    box.holder = undefined;
    box.taskId = undefined;
    this.pump(box.tenantId);
  }

  private async create(plan: Extract<Plan, { kind: 'create' }>): Promise<void> {
    const { box } = plan;
    const name = boxName(box.tenantId, box.slot);
    let source =
      plan.snapshotId !== undefined
        ? { snapshotId: plan.snapshotId }
        : plan.choice !== undefined
          ? { snapshotId: plan.choice.snapshotId }
          : this.options.source(box.tenantId);
    if (plan.snapshotId === undefined && plan.choice !== undefined) {
      box.setup = plan.choice.setupHash;
      box.repo = plan.choice.repo;
    }
    let machine: InstaboxMachine;
    let adopted = false;
    // The machine instabox accepted to make, once it has said so: from then on it may exist even if
    // waiting for it or reading it back fails.
    let accepted: string | undefined;
    try {
      const make = async (): Promise<InstaboxMachine> => {
        accepted = undefined;
        const operation = await this.api.createMachine(
          { name, ...source, metadata: this.desiredLabels(box) },
          { idempotencyKey: `maka-box-${name}-${randomUUID()}` },
        );
        accepted = operation.machineId;
        await this.api.waitForOperation(operation.id);
        return await this.api.getMachine(operation.machineId);
      };
      try {
        machine = await make();
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (plan.choice === undefined || plan.snapshotId !== undefined) throw error;
        if (status !== 400 && status !== 404 && status !== 422) throw error;
        // The setup snapshot is gone (expired, deleted): start from the template, without its labels.
        this.options.onWarning?.(`setup snapshot ${plan.choice.snapshotId} cannot be used`, error);
        box.setup = undefined;
        box.repo = undefined;
        source = this.options.source(box.tenantId);
        machine = await make();
      }
    } catch (error) {
      if (isQuotaExceeded(error)) {
        this.learned = { boxes: this.countBoxes() - 1, at: this.now() };
        if (this.hasOtherBox(box)) throw new QuotaWait();
        throw new NoFreeBoxError(
          `the account's sandbox limit is reached and this invite has no box of its own: ${(error as InstaboxApiError).message}`,
        );
      }
      // A box of that name exists (made by an earlier attempt, or by another process): use it if it is ours.
      if ((error as { status?: number }).status !== 409) {
        // An operation that instabox reports as failed left no machine; anything else may have,
        // including one that was still running when the wait ran out.
        const failed = error instanceof InstaboxOperationError && error.outcome === 'failed';
        if (accepted !== undefined && !failed) {
          this.keepAccepted(box, accepted, error);
        }
        throw error;
      }
      const found = await this.findNamed(box, name);
      if (!found) throw error;
      machine = found;
      adopted = true;
    }
    const checked = checkBox(
      machine,
      { maxPerInvite: this.maxPerInvite },
      {
        tenantId: box.tenantId,
        slot: box.slot,
      },
    );
    if (!checked.ok) {
      throw new BoxRefusedError(`the box ${machine.id} was refused: ${checked.reason}`);
    }
    if (machine.state === 'error' || machine.state === 'deleting' || machine.state === 'deleted') {
      throw new BoxRefusedError(`the box ${machine.id} is ${machine.state}`);
    }
    if (checked.taskId !== undefined && checked.taskId !== box.taskId) {
      throw new BoxRefusedError(`the box ${machine.id} already belongs to task ${checked.taskId}`);
    }
    box.machineId = machine.id;
    box.setup = checked.setup;
    box.repo = checked.repo;
    try {
      await this.options.beforeUse?.(machine.id, plan.why);
    } catch (error) {
      box.machineId = undefined;
      // Our own box, made a moment ago and never used: delete it. An older one is left for the operator.
      if (adopted)
        this.options.onWarning?.(`box ${machine.id} failed its guard and was not used`, error);
      else await this.deleteQuietly(machine.id);
      throw error;
    }
    box.state = 'claimed';
    if (adopted) await this.writeLabels(box);
    // A box made from a setup snapshot starts without the programs a running box had: the same as after a wake.
    if (box.repo !== undefined) await this.resume(box);
  }

  /**
   * A create that instabox accepted but whose box could not be waited for or read back: the machine
   * may exist, carrying this task's label. Dropping the slot would make every later create of it meet
   * a box named the same and refuse it, so the slot keeps the machine as lost and the next cleanup
   * run looks at it (woken and guarded, or deleted if it never came to be).
   */
  private keepAccepted(box: Box, machineId: string, error: unknown): void {
    this.options.onWarning?.(
      `box ${machineId} was accepted but could not be read back: ${errorText(error)}`,
    );
    box.machineId = machineId;
    box.state = 'lost';
    box.lostAt = this.now() - this.lostGraceMs;
    box.taskId = undefined;
    box.holder = undefined;
    box.sleepPhase = undefined;
  }

  /**
   * Runs the checked-out repository's `.agents/resume` (if it has one) in a box that was just woken or
   * made from its setup snapshot, as the box's user. A failure is reported and the box is still used.
   */
  private async resume(box: Box): Promise<void> {
    const machineId = box.machineId as string;
    if (box.repo === undefined || !/^[0-9a-f]{8}$/.test(box.repo)) return;
    const timeoutSeconds = this.options.resumeTimeoutSeconds ?? DEFAULT_RESUME_TIMEOUT_SECONDS;
    try {
      const agent = this.options.agent;
      if (agent === undefined) {
        throw new Error(
          'no unprivileged agent account is configured, so no repository script is run',
        );
      }
      await this.checkAgent(machineId, agent);
      const result = await this.api.exec(machineId, {
        cmd: asRepoUser(RESUME_SCRIPT, agent, ['MAKA_REPO_DIR']),
        envs: { MAKA_REPO_DIR: `${REPOS_ROOT}/${box.repo}` },
        timeoutSeconds,
      });
      if (result.timedOut) throw new Error(`it took longer than ${timeoutSeconds} s`);
      if (result.exitCode !== 0) {
        throw new Error(
          `exit ${result.exitCode}: ${`${result.stdout}\n${result.stderr}`.trim().slice(-1000)}`,
        );
      }
    } catch (error) {
      const reason = `.agents/resume failed: ${errorText(error)}`;
      this.options.onWarning?.(`box ${machineId}: ${reason}`);
      this.options.onResumeFailure?.(machineId, reason);
    }
  }

  /** The agent account must be unprivileged on this box before any repository script runs as it. */
  private async checkAgent(machineId: string, agent: AgentChannel): Promise<void> {
    if (this.agentChecked.has(machineId)) return;
    const result = await this.api.exec(machineId, {
      cmd: AGENT_CHECK_SCRIPT,
      envs: { MAKA_AGENT_USER: agent.user },
      timeoutSeconds: 60,
    });
    const problems = agentProblems(result.stdout);
    if (problems.length > 0) {
      throw new Error(`the agent account is not safe for repository code: ${problems.join('; ')}`);
    }
    this.agentChecked.add(machineId);
  }

  private async findNamed(box: Box, name: string): Promise<InstaboxMachine | undefined> {
    const found = await this.api.listMachines({
      metadata: { [LABEL.pool]: '1', [LABEL.invite]: box.tenantId, [LABEL.slot]: String(box.slot) },
    });
    return found.find((machine) => machine.name === name);
  }

  // -- waiting -----------------------------------------------------------------------------------

  private wait(tenantId: string, taskId: TaskId, choice?: SetupChoice): Promise<Held> {
    return new Promise<Held>((resolve, reject) => {
      const waiter: Waiter = {
        tenantId,
        taskId,
        choice,
        timer: undefined,
        settle: (finish) => {
          this.timers.clearTimeout(waiter.timer);
          finish().then(resolve, reject);
        },
        fail: (error) => {
          this.timers.clearTimeout(waiter.timer);
          reject(error);
        },
      };
      waiter.timer = this.timers.setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) return;
        this.waiters.splice(index, 1);
        reject(
          new NoFreeBoxError(
            `no box of this invite came free within ${Math.round(this.waitMs / 1000)} s (the invite may use ${this.maxPerInvite} boxes${this.limited() ? ', and the account allows no more' : ''})`,
          ),
        );
      }, this.waitMs);
      this.waiters.push(waiter);
    });
  }

  /** Gives free boxes (or free slots) of the tenant to the tasks waiting for it, oldest first. */
  private pump(tenantId: string): void {
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index] as Waiter;
      if (waiter.tenantId !== tenantId) {
        index++;
        continue;
      }
      const plan = this.plan(
        tenantId,
        waiter.taskId,
        waiter.choice === undefined ? {} : { choice: waiter.choice },
      );
      if (plan.kind === 'none') return;
      this.waiters.splice(index, 1);
      waiter.settle(() => this.finish(plan));
    }
  }

  // -- leases ------------------------------------------------------------------------------------

  private lease({ box, holder }: Held): SandboxLease {
    return {
      machineId: box.machineId as string,
      release: async () => {
        if (box.holder !== holder) return;
        this.giveBack(box);
        await box.labels;
      },
    };
  }

  /**
   * Ends a run's claim. A run of the task ends, the task may not: while it is live it keeps its box
   * (and its files) for its next run, and the claim passes to the task until it has ended.
   */
  private giveBack(box: Box): void {
    if (box.taskId !== undefined && this.options.isTaskLive(box.taskId)) {
      box.holder = 'adopted';
      return;
    }
    this.free(box);
  }

  /** Whether the box is still this task's, in the registry, and fit to hand out. */
  private isHeldBy(box: Box, taskId: TaskId): boolean {
    return (
      this.tenants.get(box.tenantId)?.get(box.slot) === box &&
      box.taskId === taskId &&
      box.state === 'claimed'
    );
  }

  /** Frees the boxes of the invite that tasks kept across their runs and that have ended since. */
  private freeEnded(tenantId: string): void {
    for (const box of [...this.boxesOf(tenantId).values()]) {
      if (
        box.holder === 'adopted' &&
        box.taskId !== undefined &&
        !this.options.isTaskLive(box.taskId)
      ) {
        this.free(box);
      }
    }
  }

  /** Marks the box free, hands it on to a waiting task if there is one, and rewrites its label. */
  private free(box: Box): void {
    // Giving up a claim does not wake a box: one that is still asleep (found paused after a restart,
    // or claimed but never woken) stays suspended, so the next task wakes and guards it.
    box.state =
      box.state === 'suspended' || (box.state === 'waking' && box.waking === undefined)
        ? 'suspended'
        : 'ready';
    box.taskId = undefined;
    box.holder = undefined;
    box.idleSince = this.now();
    void this.writeLabels(box).catch((error) =>
      this.options.onWarning?.(
        `could not clear the task label of box ${box.machineId ?? ''}`,
        error,
      ),
    );
    this.pump(box.tenantId);
  }

  private writeLabels(box: Box): Promise<void> {
    const write = box.labels.then(async () => {
      // Nothing is written to a box that was refused: its labels are the evidence.
      if (box.machineId === undefined || box.state === 'refused') return;
      await this.api.patchMachineMetadata(box.machineId, this.desiredLabels(box));
    });
    // The chain goes on after a failed write; the caller of this write still sees the failure.
    box.labels = write.catch(() => undefined);
    return write;
  }

  private desiredLabels(box: Box): Record<string, string> {
    return {
      ...boxLabels(box.tenantId, box.slot, {
        ...(box.setup === undefined ? {} : { setup: box.setup }),
        ...(box.repo === undefined ? {} : { repo: box.repo }),
      }),
      ...(box.taskId === undefined ? {} : { [LABEL.task]: box.taskId }),
    };
  }

  // -- registry ----------------------------------------------------------------------------------

  private newBox(tenantId: string, slot: number): Box {
    return {
      tenantId,
      slot,
      machineId: undefined,
      state: 'creating',
      taskId: undefined,
      holder: undefined,
      conversationId: undefined,
      setup: undefined,
      repo: undefined,
      creation: undefined,
      waking: undefined,
      idleSince: this.now(),
      userSeenAt: undefined,
      sleepPhase: undefined,
      generation: 0,
      lostAt: undefined,
      sleepAfter: 0,
      labels: Promise.resolve(),
    };
  }

  private boxesOf(tenantId: string): Map<number, Box> {
    let boxes = this.tenants.get(tenantId);
    if (!boxes) {
      boxes = new Map();
      this.tenants.set(tenantId, boxes);
    }
    return boxes;
  }

  /** Removes a box from the registry (it was never made, or is gone) and lets waiters try again. */
  private forget(box: Box): void {
    const boxes = this.tenants.get(box.tenantId);
    if (boxes?.get(box.slot) === box) boxes.delete(box.slot);
    this.pump(box.tenantId);
    // A box less in the account is room for another invite that waits at the account's limit.
    for (const tenantId of new Set(this.waiters.map((waiter) => waiter.tenantId))) {
      if (tenantId !== box.tenantId) this.pump(tenantId);
    }
  }

  /**
   * The runner asks for a restore after it found the task's box deleted or broken. A box that is
   * gone leaves the registry; one that still exists (broken) stays in its slot as lost, so nothing
   * is made over it.
   */
  private async dropBoxOf(tenantId: string, taskId: TaskId): Promise<void> {
    for (const box of [...this.boxesOf(tenantId).values()]) {
      if (box.taskId !== taskId) continue;
      box.holder = undefined;
      box.taskId = undefined;
      let exists = false;
      if (box.machineId !== undefined) {
        try {
          const machine = await this.api.getMachine(box.machineId);
          exists = machine.state !== 'deleted' && machine.state !== 'deleting';
          const why = exists ? this.identityProblem(box, machine, taskId) : undefined;
          if (why !== undefined) {
            this.quarantine(box, why);
            continue;
          }
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
        }
      }
      if (exists) {
        // Dated, so cleanup looks at it later: retried after the grace, deleted after the long limit.
        box.state = 'lost';
        box.lostAt = this.now();
        box.sleepPhase = undefined;
        this.clearTaskLabel(box);
      } else this.forget(box);
    }
  }

  /** Whether the invite has a box besides this one (which is still being made). */
  private hasOtherBox(box: Box): boolean {
    return [...this.boxesOf(box.tenantId).values()].some((other) => other !== box);
  }

  private countBoxes(): number {
    let count = 0;
    for (const boxes of this.tenants.values()) count += boxes.size;
    return count;
  }

  private limited(): boolean {
    return this.learned !== undefined && this.now() - this.learned.at < this.limitRecheckMs;
  }

  private atAccountLimit(): boolean {
    return this.limited() && this.countBoxes() >= (this.learned as { boxes: number }).boxes;
  }

  private assertOpen(): void {
    if (this.closed) throw new PoolClosedError();
  }

  /** Keeps a create until it settles, so a shutdown can wait for it (`settled`). */
  private track(work: Promise<unknown>): void {
    const done = work.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(done);
    void done.then(() => this.inFlight.delete(done));
  }

  /**
   * Resolves once every create that was under way has ended, with the boxes it made recorded (or
   * given back). For a shutdown, after `dispose`: a process that stops sooner may leave a box made
   * for nothing, or a builder that is deleted by no one.
   */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Deletes a box and waits until instabox says it is gone: its name is free only then. */
  private async removeBox(machineId: string): Promise<void> {
    try {
      const operation = await this.api.deleteMachine(machineId);
      await this.api.waitForOperation(operation.id);
    } catch (error) {
      // Already gone (an earlier delete finished after all, or someone else removed it): its name is free.
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  private async deleteQuietly(machineId: string): Promise<void> {
    try {
      const operation = await this.api.deleteMachine(machineId);
      await this.api.waitForOperation(operation.id);
    } catch (error) {
      this.options.onWarning?.(`could not delete box ${machineId}`, error);
    }
  }

  // -- sleep and wake ----------------------------------------------------------------------------

  /** Records that a person looked at the box just now (a terminal or desktop view), so it stays awake. */
  noteUserActivity(machineId: string): void {
    for (const boxes of this.tenants.values()) {
      for (const box of boxes.values()) {
        if (box.machineId === machineId) box.userSeenAt = this.now();
      }
    }
  }

  /**
   * Puts to sleep the boxes whose agent has done nothing for `idle.agentMs` and which nobody has
   * looked at for `idle.userMs`. Returns the machine ids that went to sleep. One sweep at a time.
   *
   * Per box, Rakazo's order: compare-and-set `ready -> suspending` (a synchronous step), checkpoint
   * (`sync`), re-check every hold (a task that took the box, a person who looked, a write in the last
   * minute), and only then suspend. Any hold that shows up turns the sleep back and nothing is
   * suspended; a task that takes the box before the suspend is issued wins.
   */
  sweepIdle(): Promise<string[]> {
    this.sweeping ??= this.sweep().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweep(): Promise<string[]> {
    await this.discovered();
    const now = this.now();
    const sleepers: Box[] = [];
    for (const boxes of this.tenants.values()) {
      for (const box of boxes.values()) {
        if (
          box.state === 'ready' &&
          box.machineId !== undefined &&
          now >= box.sleepAfter &&
          now - box.idleSince >= this.agentIdleMs &&
          now - (box.userSeenAt ?? Number.NEGATIVE_INFINITY) >= this.userIdleMs
        ) {
          box.state = 'suspending';
          box.sleepPhase = 'checkpoint';
          box.generation++;
          sleepers.push(box);
        }
      }
    }
    const slept = await Promise.all(
      sleepers.map((box) => {
        const generation = box.generation;
        return this.sleep(box, generation);
      }),
    );
    return slept.filter((id): id is string => id !== undefined);
  }

  /** Whether anyone took the box, or marked it otherwise, since this sleep began. */
  private turnedBack(box: Box, generation: number): boolean {
    return box.state !== 'suspending' || box.generation !== generation;
  }

  private revert(box: Box, retryAfterMs: number): void {
    if (box.state !== 'suspending') return;
    box.state = 'ready';
    box.sleepPhase = undefined;
    box.sleepAfter = this.now() + retryAfterMs;
  }

  private async sleep(box: Box, generation: number): Promise<string | undefined> {
    const machineId = box.machineId as string;
    try {
      const machine = await this.api.getMachine(machineId);
      if (this.turnedBack(box, generation)) return undefined;
      const why = this.identityProblem(box, machine, undefined);
      if (why !== undefined) {
        this.quarantine(box, why);
        return undefined;
      }
      if (machine.state !== 'running') {
        // Instabox paused it for idleness first; the next task wakes it through the wake path.
        if (
          machine.state === 'error' ||
          machine.state === 'deleted' ||
          machine.state === 'deleting'
        ) {
          this.markLost(box, `it is ${machine.state}`);
        } else {
          box.state = 'suspended';
          box.sleepPhase = undefined;
          this.pump(box.tenantId);
        }
        return undefined;
      }
      await this.api.exec(machineId, { cmd: 'sync', timeoutSeconds: CHECKPOINT_TIMEOUT_SECONDS });
      if (this.turnedBack(box, generation)) return undefined;
      const written = (await this.options.recentWrite?.(machineId)) ?? false;
      const looked = this.now() - (box.userSeenAt ?? Number.NEGATIVE_INFINITY) < this.userIdleMs;
      // The last look at the holds, with nothing awaited between it and the point of no return.
      if (this.turnedBack(box, generation)) return undefined;
      if (written || looked) {
        this.revert(box, 0);
        return undefined;
      }
      box.sleepPhase = 'suspend';
      const operation = await this.api.suspendMachine(machineId);
      await this.api.waitForOperation(operation.id);
      if (this.turnedBack(box, generation)) return undefined;
      box.state = 'suspended';
      box.sleepPhase = undefined;
      this.pump(box.tenantId);
      return machineId;
    } catch (error) {
      this.options.onWarning?.(`could not put box ${machineId} to sleep`, error);
      await this.settleAfterFailedSleep(box, generation);
      return undefined;
    }
  }

  /** A sleep failed half way: ask instabox what the box is now, and make the registry say the same. */
  private async settleAfterFailedSleep(box: Box, generation: number): Promise<void> {
    if (this.turnedBack(box, generation)) return;
    try {
      const machine = await this.api.getMachine(box.machineId as string);
      // The answer is about the box as it was; a task may have taken it while we asked.
      if (this.turnedBack(box, generation)) return;
      if (machine.state === 'running') this.revert(box, SLEEP_RETRY_MS);
      else if (machine.state === 'suspended') {
        box.state = 'suspended';
        box.sleepPhase = undefined;
        this.pump(box.tenantId);
      } else this.markLost(box, `it is ${machine.state} after a failed sleep`);
    } catch (error) {
      if (this.turnedBack(box, generation)) return;
      this.markLost(box, `its state is unknown after a failed sleep: ${errorText(error)}`);
    }
  }

  /**
   * Wakes the box a task has just taken. A wake that fails or times out is tried once more with a
   * longer limit ("slow, not dead"); only then, or at once if the box is gone, does it count as
   * lost. The egress guard runs after every wake, and a box that fails it is not used.
   */
  private async wake(box: Box): Promise<boolean> {
    const machineId = box.machineId as string;
    try {
      let lastError: unknown;
      for (const limitMs of this.wakeTimeoutsMs) {
        const controller = new AbortController();
        const timer = this.timers.setTimeout(
          () =>
            controller.abort(
              new Error(`waking box ${machineId} took longer than ${Math.round(limitMs / 1000)} s`),
            ),
          limitMs,
        );
        try {
          await this.api.ensureRunning(machineId, { signal: controller.signal });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if ((error as { status?: number }).status === 404) break;
        } finally {
          this.timers.clearTimeout(timer);
        }
      }
      if (lastError !== undefined) {
        this.markLost(box, `it could not be woken: ${errorText(lastError)}`);
        return false;
      }
      try {
        await this.options.beforeUse?.(machineId, 'wake');
      } catch (error) {
        this.markLost(box, `it failed its guard after waking: ${errorText(error)}`);
        return false;
      }
      // The box stays `waking` through its resume, so every ask for it waits on this same wake.
      await this.resume(box);
      if (box.state === 'waking') box.state = 'claimed';
      return true;
    } finally {
      box.waking = undefined;
    }
  }

  /** The box is not used again by this process; the task that held it (if any) must find another. */
  private markLost(box: Box, why: string): void {
    this.options.onWarning?.(`box ${box.machineId ?? ''} is lost: ${why}`);
    box.state = 'lost';
    box.lostAt = this.now();
    box.sleepPhase = undefined;
    box.holder = undefined;
    box.taskId = undefined;
    this.clearTaskLabel(box);
  }

  /**
   * A lost box no longer belongs to the task that lost it, which goes on elsewhere and may stay live
   * for long: its label must not name it, or cleanup would never delete the box and a recovered box
   * would be refused when it is handed out.
   */
  private clearTaskLabel(box: Box): void {
    void this.writeLabels(box).catch((error) =>
      this.options.onWarning?.(
        `could not clear the task label of lost box ${box.machineId ?? ''}`,
        error,
      ),
    );
  }

  // -- cleanup -----------------------------------------------------------------------------------

  /** Boxes the pool found with its label but refused. It deletes none of them: whose they are is for the operator to say. */
  refusedBoxes(): { machineId: string; reason: string }[] {
    return this.refused.map((entry) => ({ ...entry }));
  }

  private refuse(machineId: string, reason: string): void {
    this.refused.push({ machineId, reason });
    this.options.onWarning?.(`refused box ${machineId}: ${reason}`);
  }

  /**
   * Looks after the boxes nobody is using: a lost box that has been lost for `cleanup.lostGraceMs`
   * is tried once more (woken and guarded) and goes back into use if that works; one that has stayed
   * lost for `cleanup.lostDeleteMs` is deleted. With `cleanup.idleDeleteMs` set, a box that has done
   * nothing for that long is deleted too (off by default). Before any delete the box is looked at
   * again, right then: it must still carry this pool's labels for this slot, no live task, no
   * recent write, and nothing may have taken it. One run at a time.
   */
  cleanup(): Promise<CleanupResult> {
    this.cleaning ??= this.runCleanup().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }

  private async runCleanup(): Promise<CleanupResult> {
    await this.discovered();
    const now = this.now();
    const result: CleanupResult = { recovered: [], deleted: [] };
    const work: Promise<void>[] = [];
    for (const boxes of this.tenants.values()) {
      for (const box of [...boxes.values()]) {
        if (box.machineId === undefined || now < box.sleepAfter) continue;
        const machineId = box.machineId;
        if (box.state === 'lost' && box.lostAt !== undefined) {
          const lostFor = now - box.lostAt;
          if (lostFor >= this.lostDeleteMs) {
            work.push(this.delete(box, result));
          } else if (lostFor >= this.lostGraceMs) {
            box.state = 'waking';
            work.push(
              this.recover(box).then((ok) => {
                if (ok) result.recovered.push(machineId);
              }),
            );
          }
        } else if (box.state === 'refused') {
          work.push(this.dropIfGone(box));
        } else if (
          this.idleDeleteMs !== undefined &&
          (box.state === 'ready' || box.state === 'suspended') &&
          now - box.idleSince >= this.idleDeleteMs &&
          now - (box.userSeenAt ?? Number.NEGATIVE_INFINITY) >= this.idleDeleteMs
        ) {
          work.push(this.delete(box, result));
        }
      }
    }
    await Promise.all(work);
    return result;
  }

  /**
   * A refused box is never deleted here, but once it is gone (the operator removed it) its slot is
   * given back, and it is no longer listed by `refusedBoxes`.
   */
  private async dropIfGone(box: Box): Promise<void> {
    const machineId = box.machineId as string;
    try {
      const machine = await this.api.getMachine(machineId);
      if (machine.state !== 'deleted') return;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        this.options.onWarning?.(`could not look at refused box ${machineId}`, error);
        return;
      }
    }
    if (box.state !== 'refused') return;
    for (let index = this.refused.length - 1; index >= 0; index--) {
      if (this.refused[index]?.machineId === machineId) this.refused.splice(index, 1);
    }
    this.forget(box);
  }

  /** A lost box (already marked `waking` by the caller) gets one more try, with the longest limit. */
  private async recover(box: Box): Promise<boolean> {
    const machineId = box.machineId as string;
    const limitMs = this.wakeTimeoutsMs.at(-1) as number;
    const controller = new AbortController();
    const timer = this.timers.setTimeout(
      () => controller.abort(new Error('recovery timed out')),
      limitMs,
    );
    try {
      await this.api.ensureRunning(machineId, { signal: controller.signal });
      await this.options.beforeUse?.(machineId, 'wake');
      box.state = 'ready';
      box.lostAt = undefined;
      box.idleSince = this.now();
      this.pump(box.tenantId);
      return true;
    } catch (error) {
      box.state = 'lost';
      box.sleepAfter = this.now() + CLEANUP_RETRY_MS;
      this.options.onWarning?.(`box ${machineId} is still lost: ${errorText(error)}`);
      return false;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  private async delete(box: Box, result: CleanupResult): Promise<void> {
    const previous = box.state;
    const machineId = box.machineId as string;
    // The compare-and-set: from here nothing can take the box, and a task that comes meanwhile gets another.
    box.state = 'deleting';
    const keep = (why: string): void => {
      this.options.onWarning?.(`box ${machineId} was not deleted: ${why}`);
      box.state = previous;
      box.sleepAfter = this.now() + CLEANUP_RETRY_MS;
    };
    try {
      let machine: InstaboxMachine | undefined;
      try {
        machine = await this.api.getMachine(machineId);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
      if (machine === undefined || machine.state === 'deleted') {
        this.forget(box);
        result.deleted.push(machineId);
        return;
      }
      const checked = checkBox(
        machine,
        { maxPerInvite: this.maxPerInvite },
        {
          tenantId: box.tenantId,
          slot: box.slot,
        },
      );
      if (!checked.ok) return keep(`it is not this pool's box any more (${checked.reason})`);
      if (checked.taskId !== undefined && this.options.isTaskLive(checked.taskId)) {
        return keep(`task ${checked.taskId} holds it`);
      }
      if (machine.state === 'running' && ((await this.options.recentWrite?.(machineId)) ?? false)) {
        return keep('something wrote to it a moment ago');
      }
      const operation = await this.api.deleteMachine(machineId);
      await this.api.waitForOperation(operation.id);
      this.forget(box);
      result.deleted.push(machineId);
    } catch (error) {
      keep(errorText(error));
    }
  }

  // -- finding what is already there -------------------------------------------------------------

  private discovered(): Promise<void> {
    this.discovery ??= this.discover().catch((error) => {
      // A failed listing is tried again by the next caller, not remembered.
      this.discovery = undefined;
      throw error;
    });
    return this.discovery;
  }

  private async discover(): Promise<void> {
    const machines = await this.api.listMachines({ metadata: { [LABEL.pool]: '1' } });
    for (const machine of machines) {
      if (isBuilderBox(machine)) await this.reapBuilder(machine);
      else this.register(machine);
    }
  }

  /**
   * A builder box found at start belongs to a process that is gone and its build with it: nothing
   * is using it. It goes by its exact name and labels; anything else with the pool label is only refused.
   */
  private async reapBuilder(machine: InstaboxMachine): Promise<void> {
    if (machine.state === 'deleting' || machine.state === 'deleted') return;
    try {
      await this.removeBox(machine.id);
      this.options.onWarning?.(`deleted builder box ${machine.id} left by an earlier process`);
    } catch (error) {
      const tenantId = machine.metadata?.[LABEL.invite];
      if (tenantId !== undefined) this.leftoverBuilders.set(tenantId, machine.id);
      this.options.onWarning?.(`could not delete builder box ${machine.id}`, error);
    }
  }

  private register(machine: InstaboxMachine): void {
    if (machine.state === 'deleting' || machine.state === 'deleted') return;
    const checked = checkBox(machine, { maxPerInvite: this.maxPerInvite });
    if (!checked.ok) {
      this.refuse(machine.id, checked.reason);
      return;
    }
    const boxes = this.boxesOf(checked.tenantId);
    if (boxes.has(checked.slot)) {
      this.refuse(
        machine.id,
        `slot ${checked.slot} of that invite is already box ${boxes.get(checked.slot)?.machineId}`,
      );
      return;
    }
    const box = this.newBox(checked.tenantId, checked.slot);
    box.machineId = machine.id;
    box.setup = checked.setup;
    box.repo = checked.repo;
    boxes.set(checked.slot, box);
    if (machine.state === 'error') {
      box.state = 'lost';
      box.lostAt = this.now();
      return;
    }
    // Anything that is not running (paused by us or by instabox, stopped, between states) is taken by waking it.
    box.state = machine.state === 'running' ? 'ready' : 'suspended';
    if (checked.taskId === undefined) return;
    if (this.options.isTaskLive(checked.taskId)) {
      box.state = machine.state === 'running' ? 'claimed' : 'waking';
      box.taskId = checked.taskId;
      box.holder = 'adopted';
    } else {
      box.taskId = checked.taskId;
      this.free(box);
    }
  }
}

/** What a cleanup run did. */
export interface CleanupResult {
  recovered: string[];
  deleted: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A create was refused for the account's limit while the invite has boxes: wait for one instead. */
class QuotaWait extends Error {}

class PoolClosedError extends Error {
  constructor() {
    super('the box pool was shut down');
  }
}
