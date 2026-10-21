import { randomUUID } from 'node:crypto';
import { backup as sqliteBackup, type DatabaseSync } from 'node:sqlite';
import { buildBrief } from './brief.js';
import { openDatabase, transaction } from './db.js';
import { type Classified, type EventFacts, parseEvent, type ProjectView } from './events.js';
import { type DutyProposal, proposeDuties, type RepoFacts, type RepoInspector } from './propose.js';
import {
  AddProjectSchema,
  type Authority,
  type Duty,
  dayOf,
  DutySpecSchema,
  fromMicro,
  MAX_CHAIN_DEPTH,
  MAX_CONSECUTIVE_FAILURES,
  MAX_ENABLED_DUTIES,
  type Project,
  type Proposal,
  type ProposalSet,
  toMicro,
  type Trigger,
} from './types.js';
import { type Headers, MIN_SECRET_LENGTH, readDelivery } from './webhook.js';

export interface EngineOptions {
  /** The duties database; ':memory:' for tests. One process opens it. */
  dbPath: string;
  /** The GitHub App's webhook secret. Required: without it no delivery is accepted. */
  webhookSecret: string;
  /**
   * Whether this owner may register this repository under this installation. Fail closed: the
   * default refuses every project, so registration is a decision the operator makes in code.
   */
  allowProject?: (input: { owner: string; repo: string; installationId: number }) => boolean;
  /** Chooses the duties to propose from what the inspector found. Default: `proposeDuties`. */
  proposer?: (facts: RepoFacts) => DutyProposal;
  now?: () => number;
  onWarning?: (message: string, detail?: unknown) => void;
}

export type ReceiveResult = { status: number; body: Record<string, unknown> };

/** What the launcher starts: one duty run. Everything here was fixed when the request was claimed. */
export interface RunRequest {
  requestId: string;
  dutyId: string;
  dutyName: string;
  projectId: string;
  /** The invite that owns the project; the run's conversation belongs to it. */
  owner: string;
  repo: string;
  brief: string;
  /** The brief carries text from outside the owner: the run starts tainted. */
  external: boolean;
  /** Snapshot of the duty's level at claim time; a later edit cannot raise a request in flight. */
  authority: Authority;
  runBudgetUsd: number;
  attempts: number;
}

export type EndOutcome = 'completed' | 'failed' | 'stopped' | 'abandoned';

export type AddProjectResult =
  | { ok: true; project: Project }
  | { ok: false; reason: 'invalid' | 'not_allowed' | 'exists' };

export type DecideResult =
  | { ok: true; duplicate: boolean; proposal: Proposal }
  | {
      ok: false;
      reason: 'not_found' | 'forbidden' | 'unknown_set' | 'conflict' | 'duty_limit';
    };

export type ProposeResult =
  | { ok: true; proposal: Proposal; created: boolean }
  | { ok: false; reason: 'not_found' | 'already_set_up' | 'inspect_failed' };

export interface DayUsage {
  reservedUsd: number;
  spentUsd: number;
}

interface ProjectRow {
  project_id: string;
  owner: string;
  repo: string;
  installation_id: number;
  default_branch: string;
  self_logins: string;
  removed: number;
  created_at: number;
}

interface DutyRow {
  duty_id: string;
  project_id: string;
  name: string;
  trigger: string;
  instruction: string;
  authority: Authority;
  run_budget_micro: number;
  daily_cap_micro: number;
  state: 'proposed' | 'active' | 'off';
  activated_at: number | null;
  last_slot: number | null;
  consecutive_failures: number;
  off_reason: 'failures' | null;
}

interface RequestRow {
  request_id: string;
  duty_id: string;
  project_id: string;
  state: string;
  brief: string;
  external: number;
  authority: Authority;
  run_budget_micro: number;
  attempts: number;
  conversation_id: string | null;
  reserved_micro: number;
  spent_micro: number | null;
}

type ClaimResult = 'created' | 'duplicate' | 'daily_cap';

const DELIVERY_RETENTION_MS = 30 * 24 * 3_600_000;
const MINUTE_MS = 60_000;
export const MAX_LAUNCH_ATTEMPTS = 5;

const dutyOf = (row: DutyRow): Duty => ({
  dutyId: row.duty_id,
  projectId: row.project_id,
  name: row.name,
  trigger: JSON.parse(row.trigger) as Trigger,
  instruction: row.instruction,
  authority: row.authority,
  runBudgetUsd: fromMicro(row.run_budget_micro),
  dailyCapUsd: fromMicro(row.daily_cap_micro),
  state: row.state,
  activatedAt: row.activated_at,
  offReason: row.off_reason,
  consecutiveFailures: row.consecutive_failures,
});

/**
 * Projects, duties, webhook intake, schedules and the ledger of duty runs, over SQLite.
 *
 * Every check-then-act (a delivery id seen before, an event already claimed, the day's cap, a
 * proposal already decided, a request's state) happens inside one synchronous `BEGIN IMMEDIATE`
 * transaction with no await between the check and the write. Starting a run is slow and happens
 * outside, from rows that were claimed first, so delivery is at least once and a run starts at
 * most once per request.
 */
export class DutyEngine {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly secret: string;
  private readonly allowProject: NonNullable<EngineOptions['allowProject']>;
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: EngineOptions) {
    if (options.webhookSecret.length < MIN_SECRET_LENGTH) {
      throw new Error(`The webhook secret must be at least ${MIN_SECRET_LENGTH} characters.`);
    }
    this.secret = options.webhookSecret;
    this.now = options.now ?? Date.now;
    this.allowProject = options.allowProject ?? (() => false);
    this.db = openDatabase(options.dbPath);
    // A launch a crash cut short: the launcher is idempotent per request, so it runs again.
    this.db.exec("UPDATE run_requests SET state = 'pending' WHERE state = 'launching'");
    this.parkMismatchedProjects();
  }

  /**
   * A project is served only while the operator's policy still names its owner, repository and
   * installation. The policy is read each time, not once at registration: when the operator
   * changes who a repository belongs to, a project stored for the old owner stops receiving its
   * events and runs. A project that is not permitted keeps its rows and comes back if the policy
   * names it again.
   */
  private permitted(project: ProjectRow): boolean {
    return (
      project.removed === 0 &&
      this.allowProject({
        owner: project.owner,
        repo: project.repo,
        installationId: project.installation_id,
      })
    );
  }

  /**
   * At start, runs that were waiting for a project the policy no longer names are ended without
   * a run (their reservations released), and the owner is told once. A run already started is
   * left to settle, and so is a request whose launch was attempted: its run may exist, and the
   * dispatcher decides (finish it if it exists, end it if not).
   */
  private parkMismatchedProjects(): void {
    transaction(this.db, () => {
      const at = this.now();
      const projects = this.db
        .prepare('SELECT * FROM projects WHERE removed = 0')
        .all() as unknown as ProjectRow[];
      for (const project of projects) {
        if (this.permitted(project)) continue;
        this.cancelWhere(
          "project_id = ? AND state IN ('pending', 'launching') AND attempts = 0",
          [project.project_id],
          'project_not_allowed',
          at,
        );
        this.notice(
          project,
          '',
          `parked:${project.project_id}`,
          `Standing duties for ${project.repo} are paused: this server's operator settings no longer name your invite and installation for it. Nothing runs for it until that is put back.`,
          at,
        );
      }
    });
  }

  /** Called after work for the launcher appears. Returns the unsubscribe function. */
  onWork(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.options.onWarning?.('A duties listener threw', error);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.db.close();
  }

  /** A consistent copy of the database, which this process holds exclusively, for the daily backup. */
  async backupTo(destination: string): Promise<void> {
    await sqliteBackup(this.db, destination);
  }

  // ---------------------------------------------------------------- webhook

  /**
   * Handles one webhook request. Rejects, fail closed, a request without a valid signature, with
   * an event type we do not handle, or with a body that is not the event's shape. A delivery id
   * seen before changes nothing; so does a second delivery of the same event under a new id.
   */
  receive(headers: Headers, body: Uint8Array): ReceiveResult {
    if (this.closed) return { status: 503, body: { error: 'closed' } };
    const delivery = readDelivery(this.secret, headers, body);
    if (!delivery.ok) return { status: delivery.status, body: { error: delivery.code } };
    const parsed = parseEvent(delivery.event, delivery.payload);
    if (!parsed) return { status: 400, body: { error: 'invalid_payload' } };
    if (delivery.event === 'ping') return { status: 200, body: { ok: true, pong: true } };

    const result = transaction(this.db, (): ReceiveResult => {
      const project = this.projectByRepo(parsed.repo);
      if (!project) return { status: 200, body: { ok: true, ignored: 'unknown_project' } };
      if (project.installation_id !== parsed.installationId) {
        return { status: 200, body: { ok: true, ignored: 'installation_mismatch' } };
      }
      // Before the delivery is recorded: once the policy names the project again, a redelivery
      // is still new.
      if (!this.permitted(project)) {
        return { status: 200, body: { ok: true, ignored: 'project_not_allowed' } };
      }
      const at = this.now();
      const seen = this.db
        .prepare(
          'INSERT INTO deliveries (delivery_id, event, repo, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        )
        .run(delivery.deliveryId, delivery.event, parsed.repo, at);
      if (Number(seen.changes) === 0) {
        return { status: 200, body: { ok: true, duplicate: true } };
      }
      return this.apply(project, parsed.classify(viewOf(project)), at);
    });
    if (result.body.started !== undefined && Number(result.body.started) > 0) this.notify();
    return result;
  }

  private apply(project: ProjectRow, event: Classified, at: number): ReceiveResult {
    switch (event.kind) {
      case 'ping':
        return { status: 200, body: { ok: true } };
      case 'ignored':
        return { status: 200, body: { ok: true, ignored: event.reason } };
      case 'ci_success': {
        this.db
          .prepare(
            `INSERT INTO ci_state (scope, last_success_seq) VALUES (?, ?)
             ON CONFLICT (scope) DO UPDATE SET last_success_seq = MAX(last_success_seq, excluded.last_success_seq)`,
          )
          .run(event.scope, event.seq);
        // The branch passes again: its chain of runs is over, if this run is newer than the
        // failures that built it. A pass that arrives again later, or an old one, ends nothing.
        this.db
          .prepare('DELETE FROM chains WHERE chain_key = ? AND last_failure_seq < ?')
          .run(event.scope, event.seq);
        // A failure that has not started yet is stale once a later run of the same workflow passed.
        const cancelled = this.cancelWhere(
          "state = 'pending' AND supersede_scope = ? AND supersede_seq < ?",
          [event.scope, event.seq],
          'superseded',
          at,
        );
        return { status: 200, body: { ok: true, started: 0, cancelled } };
      }
      case 'trigger': {
        if (event.staleIf) {
          const latest = this.db
            .prepare('SELECT last_success_seq FROM ci_state WHERE scope = ?')
            .get(event.staleIf.scope) as { last_success_seq: number } | undefined;
          if (latest && latest.last_success_seq > event.staleIf.seq) {
            return { status: 200, body: { ok: true, ignored: 'stale' } };
          }
        }
        // A person acted on the project (a review or a comment on a pull request of ours): runs
        // that woke each other may go on. Only the first time this review or comment is seen
        // counts: a replay of it is not a person acting again.
        if (event.trigger === 'review_comment_own_pr') {
          const first = this.db
            .prepare(
              'INSERT INTO person_events (event_key, seen_at) VALUES (?, ?) ON CONFLICT DO NOTHING',
            )
            .run(event.key, at);
          if (Number(first.changes) > 0) {
            this.db.prepare('DELETE FROM chains WHERE project_id = ?').run(project.project_id);
          }
        }
        const matching = this.activeDuties(project.project_id).filter(
          (duty) => (JSON.parse(duty.trigger) as Trigger).kind === event.trigger,
        );
        if (event.chain && matching.length > 0) {
          const chain = this.db
            .prepare('SELECT depth, started_at FROM chains WHERE chain_key = ?')
            .get(event.chain.key) as { depth: number; started_at: number } | undefined;
          if (chain && chain.depth >= MAX_CHAIN_DEPTH) {
            // Needs a person: nothing starts, and the owner is told once for this chain.
            for (const duty of matching) {
              this.notice(
                project,
                duty.duty_id,
                `chain:${event.chain.key}:${chain.started_at}:${duty.duty_id}`,
                `“${duty.name}” has been woken ${MAX_CHAIN_DEPTH} times in a row by the checks of its own work on ${project.repo}, and stopped. It needs you: look at the branch, or comment on the pull request to let it go on.`,
                at,
              );
            }
            return { status: 200, body: { ok: true, started: 0, ignored: 'chain_limit' } };
          }
        }
        let started = 0;
        let capped = 0;
        for (const duty of matching) {
          const result = this.claim(
            project,
            duty,
            event.key,
            this.briefFor(project, duty, event.facts),
            true,
            at,
            event.supersede,
          );
          if (result === 'created') started += 1;
          else if (result === 'daily_cap') capped += 1;
        }
        if (event.chain && started > 0) {
          this.db
            .prepare(
              `INSERT INTO chains (chain_key, project_id, depth, started_at, last_failure_seq)
               VALUES (?, ?, 1, ?, ?)
               ON CONFLICT (chain_key) DO UPDATE SET depth = depth + 1,
                 last_failure_seq = MAX(last_failure_seq, excluded.last_failure_seq)`,
            )
            .run(event.chain.key, project.project_id, at, event.chain.seq);
        }
        return { status: 200, body: { ok: true, started, capped } };
      }
    }
  }

  private briefFor(project: ProjectRow, duty: DutyRow, facts?: EventFacts, missed?: number) {
    const spec = dutyOf(duty);
    return buildBrief({
      duty: spec,
      repo: project.repo,
      ...(facts ? { facts } : {}),
      ...(missed ? { missedSlots: missed } : {}),
    });
  }

  /**
   * Records one run request for a duty and an event key, reserving the duty's per-run budget
   * against the day's cap in the same transaction. The same key twice is a duplicate; a request
   * that does not fit the cap is recorded as skipped, so it is neither started nor retried.
   */
  private claim(
    project: ProjectRow,
    duty: DutyRow,
    key: string,
    brief: string,
    external: boolean,
    at: number,
    supersede?: { scope: string; seq: number },
  ): ClaimResult {
    const exists = this.db
      .prepare('SELECT 1 FROM run_requests WHERE duty_id = ? AND trigger_key = ?')
      .get(duty.duty_id, key);
    if (exists) return 'duplicate';
    const day = dayOf(at);
    const used = this.usedMicro(duty.duty_id, day);
    const fits = used + duty.run_budget_micro <= duty.daily_cap_micro;
    this.db
      .prepare(
        `INSERT INTO run_requests (request_id, duty_id, project_id, trigger_key, state, reason, brief,
           external, authority, run_budget_micro, day, reserved_micro, spent_micro, supersede_scope,
           supersede_seq, next_attempt_at, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `req_${randomUUID().replaceAll('-', '')}`,
        duty.duty_id,
        project.project_id,
        key,
        fits ? 'pending' : 'skipped',
        fits ? null : 'daily_cap',
        brief,
        external ? 1 : 0,
        duty.authority,
        duty.run_budget_micro,
        day,
        fits ? duty.run_budget_micro : 0,
        fits ? null : 0,
        supersede?.scope ?? null,
        supersede?.seq ?? null,
        at,
        at,
        fits ? null : at,
      );
    return fits ? 'created' : 'daily_cap';
  }

  /** What the duty has used on `day`: what each request spent, or what it still holds reserved. */
  private usedMicro(dutyId: string, day: string, exceptRequest = ''): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(spent_micro, reserved_micro)), 0) AS used
         FROM run_requests WHERE duty_id = ? AND day = ? AND request_id != ?`,
      )
      .get(dutyId, day, exceptRequest) as { used: number };
    return row.used;
  }

  /** The cap view of one duty on one UTC day. */
  dayUsage(dutyId: string, day: string = dayOf(this.now())): DayUsage {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN spent_micro IS NULL THEN reserved_micro END), 0) AS reserved,
                COALESCE(SUM(spent_micro), 0) AS spent
         FROM run_requests WHERE duty_id = ? AND day = ?`,
      )
      .get(dutyId, day) as { reserved: number; spent: number };
    return { reservedUsd: fromMicro(row.reserved), spentUsd: fromMicro(row.spent) };
  }

  // -------------------------------------------------------------- schedules

  /**
   * Starts the scheduled duties that are due. A duty whose slots were missed (the server was down)
   * runs once, for the latest slot, and the older slots are dropped. Nothing runs for a slot
   * before the duty was approved. Safe to call as often as wanted.
   */
  tick(): { started: number; missedSlots: number } {
    if (this.closed) return { started: 0, missedSlots: 0 };
    const at = this.now();
    const result = transaction(this.db, () => {
      let started = 0;
      let missedSlots = 0;
      const rows = this.db
        .prepare(
          `SELECT d.* FROM duties d JOIN projects p ON p.project_id = d.project_id
           WHERE d.state = 'active' AND p.removed = 0 AND d.activated_at IS NOT NULL
             AND json_extract(d.trigger, '$.kind') = 'schedule'`,
        )
        .all() as unknown as DutyRow[];
      for (const duty of rows) {
        const trigger = JSON.parse(duty.trigger) as Trigger;
        if (trigger.kind !== 'schedule' || duty.activated_at === null) continue;
        const every = trigger.everyMinutes * MINUTE_MS;
        if (at < duty.activated_at + every) continue;
        if (!this.permitted(this.projectById(duty.project_id) as ProjectRow)) continue;
        const slot = duty.activated_at + Math.floor((at - duty.activated_at) / every) * every;
        if (duty.last_slot !== null && duty.last_slot >= slot) continue;
        const missed = Math.max(0, (slot - (duty.last_slot ?? duty.activated_at)) / every - 1);
        this.db
          .prepare('UPDATE duties SET last_slot = ? WHERE duty_id = ?')
          .run(slot, duty.duty_id);
        const project = this.projectById(duty.project_id) as ProjectRow;
        const claimed = this.claim(
          project,
          duty,
          `schedule:${duty.duty_id}:${slot}`,
          this.briefFor(project, duty, undefined, missed),
          false,
          at,
        );
        missedSlots += missed;
        if (claimed === 'created') started += 1;
      }
      this.db
        .prepare('DELETE FROM deliveries WHERE received_at < ?')
        .run(at - DELIVERY_RETENTION_MS);
      this.db
        .prepare('DELETE FROM person_events WHERE seen_at < ?')
        .run(at - DELIVERY_RETENTION_MS);
      return { started, missedSlots };
    });
    if (result.started > 0) this.notify();
    return result;
  }

  // --------------------------------------------------------------- projects

  addProject(owner: string, input: unknown): AddProjectResult {
    const parsed = AddProjectSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    const repo = parsed.data.repo.toLowerCase();
    if (!this.allowProject({ owner, repo, installationId: parsed.data.installationId })) {
      return { ok: false, reason: 'not_allowed' };
    }
    return transaction(this.db, (): AddProjectResult => {
      if (this.projectByRepo(repo)) return { ok: false, reason: 'exists' };
      const projectId = `prj_${randomUUID().replaceAll('-', '')}`;
      this.db
        .prepare(
          `INSERT INTO projects (project_id, owner, repo, installation_id, default_branch, self_logins, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          owner,
          repo,
          parsed.data.installationId,
          parsed.data.defaultBranch,
          JSON.stringify(parsed.data.selfLogins.map((login) => login.toLowerCase())),
          this.now(),
        );
      return { ok: true, project: this.projectView(this.projectById(projectId) as ProjectRow) };
    });
  }

  /** The owner's projects. A project of another owner is never shown. */
  listProjects(owner: string): Project[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM projects WHERE owner = ? AND removed = 0 ORDER BY created_at, project_id',
      )
      .all(owner) as unknown as ProjectRow[];
    return rows.map((row) => this.projectView(row));
  }

  project(owner: string, projectId: string): Project | undefined {
    const row = this.projectById(projectId);
    return row && row.owner === owner && row.removed === 0 ? this.projectView(row) : undefined;
  }

  /** Stops the project's duties and cancels the runs not started yet. Runs already started finish. */
  removeProject(owner: string, projectId: string): boolean {
    return transaction(this.db, () => {
      const row = this.projectById(projectId);
      if (!row || row.owner !== owner || row.removed === 1) return false;
      this.db.prepare('UPDATE projects SET removed = 1 WHERE project_id = ?').run(projectId);
      this.db.prepare("UPDATE duties SET state = 'off' WHERE project_id = ?").run(projectId);
      this.cancelWhere(
        "state = 'pending' AND project_id = ?",
        [projectId],
        'project_removed',
        this.now(),
      );
      return true;
    });
  }

  /**
   * Turns an approved duty on or off. A duty the owner never approved cannot be turned on here:
   * only a decided proposal activates a duty.
   */
  setDutyState(
    owner: string,
    dutyId: string,
    state: 'active' | 'off',
  ): 'ok' | 'not_found' | 'not_approved' | 'duty_limit' {
    return transaction(this.db, () => {
      const duty = this.db.prepare('SELECT * FROM duties WHERE duty_id = ?').get(dutyId) as
        | DutyRow
        | undefined;
      const project = duty ? this.projectById(duty.project_id) : undefined;
      if (!duty || !project || project.owner !== owner || project.removed === 1) return 'not_found';
      if (state === 'active' && duty.activated_at === null) return 'not_approved';
      if (state === 'active') {
        if (duty.state !== 'active' && this.enabledCount(owner) + 1 > MAX_ENABLED_DUTIES) {
          return 'duty_limit';
        }
        // Slots while it was off are not owed: a schedule counts from now. A duty the engine
        // turned off for failing starts counting again.
        this.db
          .prepare(
            "UPDATE duties SET state = 'active', last_slot = NULL, activated_at = ?, consecutive_failures = 0, off_reason = NULL WHERE duty_id = ?",
          )
          .run(this.now(), dutyId);
      } else {
        this.db.prepare("UPDATE duties SET state = 'off' WHERE duty_id = ?").run(dutyId);
        this.cancelWhere("state = 'pending' AND duty_id = ?", [dutyId], 'duty_off', this.now());
      }
      return 'ok';
    });
  }

  // -------------------------------------------------------------- proposals

  /**
   * Inspects the repository and stores a proposal of two to four duties for the owner to decide.
   * No duty is active until `decideProposal`. A project with an open proposal gets that one back.
   */
  async propose(
    owner: string,
    projectId: string,
    inspector: RepoInspector,
    signal?: AbortSignal,
  ): Promise<ProposeResult> {
    const project = this.project(owner, projectId);
    if (!project) return { ok: false, reason: 'not_found' };
    const open = this.openProposal(projectId);
    if (open) return { ok: true, proposal: open, created: false };
    if (project.duties.some((duty) => duty.state !== 'proposed' || duty.activatedAt !== null)) {
      return { ok: false, reason: 'already_set_up' };
    }
    let facts: RepoFacts;
    try {
      facts = await inspector.inspect(project.repo, signal);
    } catch (error) {
      this.options.onWarning?.('Inspecting a repository failed', error);
      return { ok: false, reason: 'inspect_failed' };
    }
    return transaction(this.db, (): ProposeResult => {
      const row = this.projectById(projectId);
      if (!row || row.owner !== owner || row.removed === 1)
        return { ok: false, reason: 'not_found' };
      const open = this.openProposal(projectId);
      if (open) return { ok: true, proposal: open, created: false };
      const proposal = (this.options.proposer ?? proposeDuties)(facts);
      // Whatever proposes duties, the limits of a duty (a schedule no faster than every 15
      // minutes, the budget ceilings) hold for every one of them.
      const invalid = proposal.duties.find((spec) => !DutySpecSchema.safeParse(spec).success);
      if (invalid) {
        this.options.onWarning?.('A proposal carried a duty outside the limits', invalid.name);
        return { ok: false, reason: 'inspect_failed' };
      }
      const proposalId = `prp_${randomUUID().replaceAll('-', '')}`;
      const at = this.now();
      const ids = proposal.duties.map(() => `dty_${randomUUID().replaceAll('-', '')}`);
      proposal.duties.forEach((spec, index) => {
        this.db
          .prepare(
            `INSERT INTO duties (duty_id, project_id, proposal_id, name, trigger, instruction, authority,
               run_budget_micro, daily_cap_micro, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
          )
          .run(
            ids[index] as string,
            projectId,
            proposalId,
            spec.name,
            JSON.stringify(spec.trigger),
            spec.instruction,
            spec.authority,
            toMicro(spec.runBudgetUsd),
            toMicro(spec.dailyCapUsd),
            at,
          );
      });
      const sets: ProposalSet[] = proposal.sets.map((set) => ({
        id: set.id,
        label: set.label,
        recommended: set.recommended,
        dutyIds: set.duties.map((index) => ids[index] as string),
      }));
      this.db
        .prepare(
          "INSERT INTO proposals (proposal_id, project_id, sets, state, created_at) VALUES (?, ?, ?, 'open', ?)",
        )
        .run(proposalId, projectId, JSON.stringify(sets), at);
      return { ok: true, proposal: this.proposalView(proposalId) as Proposal, created: true };
    });
  }

  proposal(proposalId: string): Proposal | undefined {
    return this.proposalView(proposalId);
  }

  /**
   * The owner's decision: the chosen set's duties become active, the rest stay off. Idempotent:
   * the same set again is a duplicate that changes nothing, a different one is a conflict. Only
   * the project's owner can decide.
   */
  decideProposal(input: { proposalId: string; setId: string; caller: string }): DecideResult {
    const result = transaction(this.db, (): DecideResult => {
      const row = this.db
        .prepare('SELECT * FROM proposals WHERE proposal_id = ?')
        .get(input.proposalId) as
        | { project_id: string; state: string; decided_set: string | null; sets: string }
        | undefined;
      const project = row ? this.projectById(row.project_id) : undefined;
      if (!row || !project || project.removed === 1) return { ok: false, reason: 'not_found' };
      if (project.owner !== input.caller) return { ok: false, reason: 'forbidden' };
      const sets = JSON.parse(row.sets) as ProposalSet[];
      const chosen = sets.find((set) => set.id === input.setId);
      if (!chosen) return { ok: false, reason: 'unknown_set' };
      const proposal = this.proposalView(input.proposalId) as Proposal;
      if (row.state === 'decided') {
        return row.decided_set === input.setId
          ? { ok: true, duplicate: true, proposal }
          : { ok: false, reason: 'conflict' };
      }
      const at = this.now();
      // The proposal's own duties are replaced by the chosen set; the rest of the invite's
      // enabled duties stay, so the chosen set must fit beside them.
      const others = this.enabledCount(project.owner, input.proposalId);
      if (others + chosen.dutyIds.length > MAX_ENABLED_DUTIES) {
        // The item that carried the choice closes with the refusal, so the owner is told why.
        this.notice(
          project,
          chosen.dutyIds[0] ?? '',
          `limit:${input.proposalId}:${at}`,
          `Standing duties for ${project.repo} were not set up: an invite can have ${MAX_ENABLED_DUTIES} enabled duties and this set would pass that. Switch another duty off in Projects, then ask for the proposal again.`,
          at,
        );
        return { ok: false, reason: 'duty_limit' };
      }
      this.db
        .prepare("UPDATE duties SET state = 'off' WHERE proposal_id = ?")
        .run(input.proposalId);
      for (const dutyId of chosen.dutyIds) {
        this.db
          .prepare(
            "UPDATE duties SET state = 'active', activated_at = ?, last_slot = NULL WHERE duty_id = ?",
          )
          .run(at, dutyId);
      }
      this.db
        .prepare(
          "UPDATE proposals SET state = 'decided', decided_set = ?, decided_by = ?, decided_at = ? WHERE proposal_id = ?",
        )
        .run(input.setId, input.caller, at, input.proposalId);
      return {
        ok: true,
        duplicate: false,
        proposal: this.proposalView(input.proposalId) as Proposal,
      };
    });
    return result;
  }

  // --------------------------------------------------------------- the ledger

  /** The oldest requests whose launch is due, up to `limit`. */
  due(limit = 10): string[] {
    const rows = this.db
      .prepare(
        "SELECT request_id FROM run_requests WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY created_at, request_id LIMIT ?",
      )
      .all(this.now(), limit) as unknown as Array<{ request_id: string }>;
    return rows.map((row) => row.request_id);
  }

  /** When the next pending launch is due (for a retry timer), or undefined. */
  nextDueAt(): number | undefined {
    const row = this.db
      .prepare("SELECT MIN(next_attempt_at) AS at FROM run_requests WHERE state = 'pending'")
      .get() as { at: number | null };
    return row.at ?? undefined;
  }

  /** A request that is waiting to launch, as the launcher sees it. */
  waiting(requestId: string): RunRequest | undefined {
    const row = this.db
      .prepare("SELECT 1 FROM run_requests WHERE request_id = ? AND state = 'pending'")
      .get(requestId);
    return row ? this.requestView(requestId) : undefined;
  }

  /**
   * Claims a pending request for launching: pending -> launching, once. `begun` says an earlier
   * attempt already created the request's run: it keeps the day it was booked on and is not
   * turned away by the cap or by the project's policy, because the run exists and must settle.
   */
  beginLaunch(requestId: string, begun = false): RunRequest | undefined {
    return transaction(this.db, () => {
      if (!begun) {
        const owner = this.db
          .prepare(
            `SELECT p.* FROM run_requests r JOIN projects p ON p.project_id = r.project_id
             WHERE r.request_id = ? AND r.state = 'pending'`,
          )
          .get(requestId) as unknown as ProjectRow | undefined;
        if (!owner) return undefined;
        if (!this.permitted(owner)) {
          this.end(requestId, 'project_not_allowed', 0);
          return undefined;
        }
        if (!this.rebookToToday(requestId)) return undefined;
      }
      const changed = this.db
        .prepare(
          "UPDATE run_requests SET state = 'launching', attempts = attempts + 1 WHERE request_id = ? AND state = 'pending'",
        )
        .run(requestId);
      if (Number(changed.changes) === 0) return undefined;
      return this.requestView(requestId);
    });
  }

  /**
   * A reservation belongs to the UTC day its money is spent. One claimed on an earlier day and
   * launched today moves to today and must fit today's cap beside what is already booked, or it
   * is ended without a run (the cap, not a retry). Inside the caller's transaction. False when
   * the request is not pending or no longer fits.
   */
  private rebookToToday(requestId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT r.duty_id, r.day, r.reserved_micro, d.daily_cap_micro
         FROM run_requests r JOIN duties d ON d.duty_id = r.duty_id
         WHERE r.request_id = ? AND r.state = 'pending'`,
      )
      .get(requestId) as
      | { duty_id: string; day: string; reserved_micro: number; daily_cap_micro: number }
      | undefined;
    if (!row) return false;
    const today = dayOf(this.now());
    if (row.day === today) return true;
    if (this.usedMicro(row.duty_id, today, requestId) + row.reserved_micro > row.daily_cap_micro) {
      this.end(requestId, 'daily_cap', 0);
      return false;
    }
    this.db.prepare('UPDATE run_requests SET day = ? WHERE request_id = ?').run(today, requestId);
    return true;
  }

  /** The launch worked: launching -> started. */
  launched(requestId: string, conversationId: string): boolean {
    const changed = this.db
      .prepare(
        "UPDATE run_requests SET state = 'started', conversation_id = ?, started_at = ? WHERE request_id = ? AND state = 'launching'",
      )
      .run(conversationId, this.now(), requestId);
    return Number(changed.changes) > 0;
  }

  /**
   * The launch failed. A refusal (the owner is gone, the project is not there) or the last
   * allowed attempt ends the request and releases its reservation; any other failure retries
   * later with a growing delay.
   */
  launchFailed(
    requestId: string,
    failure: { permanent: boolean; retryAfterMs: number },
  ): 'retry' | 'cancelled' | 'gone' {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT attempts FROM run_requests WHERE request_id = ? AND state = 'launching'")
        .get(requestId) as { attempts: number } | undefined;
      if (!row) return 'gone';
      if (failure.permanent || row.attempts >= MAX_LAUNCH_ATTEMPTS) {
        this.end(requestId, failure.permanent ? 'launch_refused' : 'launch_failed', 0);
        // A refusal is not the duty's fault (the owner is gone); running out of attempts is.
        if (!failure.permanent) this.countOutcome(requestId, 'failed');
        return 'cancelled';
      }
      this.db
        .prepare(
          "UPDATE run_requests SET state = 'pending', next_attempt_at = ? WHERE request_id = ?",
        )
        .run(this.now() + failure.retryAfterMs, requestId);
      return 'retry';
    });
  }

  /**
   * Ends a request on any exit path and replaces its reservation with what was spent: a run that
   * finished (`completed`, `failed`, `stopped`, spent as measured), one nobody can account for
   * (`abandoned`, spent = the whole reservation, the cautious reading), or a request that never
   * started (spent 0). Ending twice changes nothing. Returns whether this call ended it.
   */
  finish(requestId: string, outcome: EndOutcome, spentUsd?: number): boolean {
    return transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT state, reserved_micro, started_at FROM run_requests WHERE request_id = ?')
        .get(requestId) as
        | { state: string; reserved_micro: number; started_at: number | null }
        | undefined;
      // A launch in progress cannot be ended from outside: its run may already exist. It is
      // ended once it has started (or failed) and the caller asks again.
      if (!row || !['pending', 'started'].includes(row.state)) return false;
      if (row.state === 'pending') return this.end(requestId, 'stopped_before_start', 0);
      const spent =
        outcome === 'abandoned' ||
        spentUsd === undefined ||
        !Number.isFinite(spentUsd) ||
        spentUsd < 0
          ? row.reserved_micro
          : toMicro(spentUsd);
      this.db
        .prepare(
          "UPDATE run_requests SET state = 'done', reason = ?, spent_micro = ?, finished_at = ? WHERE request_id = ? AND state = 'started'",
        )
        .run(outcome, spent, this.now(), requestId);
      this.countOutcome(requestId, outcome);
      return true;
    });
  }

  /** Requests whose run has started and not been accounted for, for the host to reconcile. */
  startedRequests(): Array<{ requestId: string; conversationId: string; startedAt: number }> {
    const rows = this.db
      .prepare(
        "SELECT request_id, conversation_id, started_at FROM run_requests WHERE state = 'started' ORDER BY started_at",
      )
      .all() as unknown as Array<{
      request_id: string;
      conversation_id: string;
      started_at: number;
    }>;
    return rows.map((row) => ({
      requestId: row.request_id,
      conversationId: row.conversation_id,
      startedAt: row.started_at,
    }));
  }

  request(
    requestId: string,
  ):
    | (RunRequest & { state: string; reason: string | null; conversationId: string | null })
    | undefined {
    const view = this.requestView(requestId);
    if (!view) return undefined;
    const row = this.db
      .prepare('SELECT state, reason, conversation_id FROM run_requests WHERE request_id = ?')
      .get(requestId) as { state: string; reason: string | null; conversation_id: string | null };
    return { ...view, state: row.state, reason: row.reason, conversationId: row.conversation_id };
  }

  /** Requests of a duty, newest first: the project page's history and the Home brief's source. */
  requestsOf(
    dutyId: string,
    limit = 50,
  ): Array<{ requestId: string; state: string; reason: string | null; createdAt: number }> {
    const rows = this.db
      .prepare(
        'SELECT request_id, state, reason, created_at FROM run_requests WHERE duty_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(dutyId, limit) as unknown as Array<{
      request_id: string;
      state: string;
      reason: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      requestId: row.request_id,
      state: row.state,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  // ---------------------------------------------------------------- internals

  /** Ends an unfinished request without a run: its reservation becomes `spentMicro`. */
  /** The invite's enabled duties, not counting those of `exceptProposal`. */
  private enabledCount(owner: string, exceptProposal?: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM duties d JOIN projects p ON p.project_id = d.project_id
         WHERE p.owner = ? AND p.removed = 0 AND d.state = 'active'
           AND (? IS NULL OR d.proposal_id IS NOT ?)`,
      )
      .get(owner, exceptProposal ?? null, exceptProposal ?? null) as { n: number };
    return row.n;
  }

  /**
   * Counts how a request ended against its duty: a completed run clears the count, a failed or
   * abandoned one adds to it, a stopped one changes nothing. At the limit the duty turns itself
   * off, its waiting requests are cancelled and the owner is told. Inside the caller's transaction.
   */
  private countOutcome(requestId: string, outcome: EndOutcome): void {
    const row = this.db
      .prepare('SELECT duty_id FROM run_requests WHERE request_id = ?')
      .get(requestId) as { duty_id: string } | undefined;
    const duty = row
      ? (this.db.prepare('SELECT * FROM duties WHERE duty_id = ?').get(row.duty_id) as
          | DutyRow
          | undefined)
      : undefined;
    if (!duty) return;
    if (outcome === 'completed') {
      if (duty.consecutive_failures > 0) {
        this.db
          .prepare('UPDATE duties SET consecutive_failures = 0 WHERE duty_id = ?')
          .run(duty.duty_id);
      }
      return;
    }
    if (outcome === 'stopped') return;
    const failures = duty.consecutive_failures + 1;
    this.db
      .prepare('UPDATE duties SET consecutive_failures = ? WHERE duty_id = ?')
      .run(failures, duty.duty_id);
    if (failures < MAX_CONSECUTIVE_FAILURES || duty.state !== 'active') return;
    const at = this.now();
    this.db
      .prepare("UPDATE duties SET state = 'off', off_reason = 'failures' WHERE duty_id = ?")
      .run(duty.duty_id);
    this.cancelWhere("state = 'pending' AND duty_id = ?", [duty.duty_id], 'duty_off', at);
    const project = this.projectById(duty.project_id);
    if (project) {
      this.notice(
        project,
        duty.duty_id,
        `off:${duty.duty_id}:${duty.activated_at ?? 0}`,
        `“${duty.name}” on ${project.repo} failed ${MAX_CONSECUTIVE_FAILURES} times in a row and has turned itself off. Look at its last runs, then switch it on again when it is fixed.`,
        at,
      );
    }
  }

  /** Writes a notice for the owner once per key. Inside the caller's transaction. */
  private notice(project: ProjectRow, dutyId: string, key: string, text: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO notices (notice_key, owner, project_id, duty_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(key, project.owner, project.project_id, dutyId, text, at);
  }

  /** Notices not yet delivered, oldest first. The host delivers them at least once. */
  pendingNotices(
    limit = 20,
  ): Array<{ noticeKey: string; owner: string; projectId: string; dutyId: string; text: string }> {
    const rows = this.db
      .prepare(
        'SELECT notice_key, owner, project_id, duty_id, text FROM notices WHERE delivered_at IS NULL ORDER BY created_at, notice_key LIMIT ?',
      )
      .all(limit) as unknown as Array<{
      notice_key: string;
      owner: string;
      project_id: string;
      duty_id: string;
      text: string;
    }>;
    return rows.map((row) => ({
      noticeKey: row.notice_key,
      owner: row.owner,
      projectId: row.project_id,
      dutyId: row.duty_id,
      text: row.text,
    }));
  }

  /** The host told the owner. Marking twice changes nothing. */
  noticeDelivered(noticeKey: string): void {
    this.db
      .prepare('UPDATE notices SET delivered_at = ? WHERE notice_key = ? AND delivered_at IS NULL')
      .run(this.now(), noticeKey);
  }

  private end(requestId: string, reason: string, spentMicro: number): boolean {
    const changed = this.db
      .prepare(
        "UPDATE run_requests SET state = 'cancelled', reason = ?, spent_micro = ?, finished_at = ? WHERE request_id = ? AND state IN ('pending', 'launching')",
      )
      .run(reason, spentMicro, this.now(), requestId);
    return Number(changed.changes) > 0;
  }

  private cancelWhere(
    where: string,
    params: Array<string | number>,
    reason: string,
    at: number,
  ): number {
    const changed = this.db
      .prepare(
        `UPDATE run_requests SET state = 'cancelled', reason = ?, spent_micro = 0, finished_at = ? WHERE ${where}`,
      )
      .run(reason, at, ...params);
    return Number(changed.changes);
  }

  private activeDuties(projectId: string): DutyRow[] {
    return this.db
      .prepare(
        "SELECT * FROM duties WHERE project_id = ? AND state = 'active' ORDER BY created_at, duty_id",
      )
      .all(projectId) as unknown as DutyRow[];
  }

  private projectByRepo(repo: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE repo = ?').get(repo) as
      | ProjectRow
      | undefined;
    return row && row.removed === 0 ? row : undefined;
  }

  private projectById(projectId: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
      | ProjectRow
      | undefined;
  }

  private projectView(row: ProjectRow): Project {
    const duties = this.db
      .prepare('SELECT * FROM duties WHERE project_id = ? ORDER BY created_at, duty_id')
      .all(row.project_id) as unknown as DutyRow[];
    return {
      projectId: row.project_id,
      owner: row.owner,
      repo: row.repo,
      installationId: row.installation_id,
      defaultBranch: row.default_branch,
      selfLogins: JSON.parse(row.self_logins) as string[],
      createdAt: row.created_at,
      duties: duties.map(dutyOf),
    };
  }

  private openProposal(projectId: string): Proposal | undefined {
    const row = this.db
      .prepare("SELECT proposal_id FROM proposals WHERE project_id = ? AND state = 'open'")
      .get(projectId) as { proposal_id: string } | undefined;
    return row ? this.proposalView(row.proposal_id) : undefined;
  }

  private proposalView(proposalId: string): Proposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId) as
      | {
          proposal_id: string;
          project_id: string;
          sets: string;
          state: 'open' | 'decided';
          decided_set: string | null;
        }
      | undefined;
    return row
      ? {
          proposalId: row.proposal_id,
          projectId: row.project_id,
          state: row.state,
          sets: JSON.parse(row.sets) as ProposalSet[],
          decidedSet: row.decided_set,
        }
      : undefined;
  }

  private requestView(requestId: string): RunRequest | undefined {
    const row = this.db.prepare('SELECT * FROM run_requests WHERE request_id = ?').get(requestId) as
      | RequestRow
      | undefined;
    if (!row) return undefined;
    const duty = this.db.prepare('SELECT name FROM duties WHERE duty_id = ?').get(row.duty_id) as {
      name: string;
    };
    const project = this.projectById(row.project_id) as ProjectRow;
    return {
      requestId: row.request_id,
      dutyId: row.duty_id,
      dutyName: duty.name,
      projectId: row.project_id,
      owner: project.owner,
      repo: project.repo,
      brief: row.brief,
      external: row.external === 1,
      authority: row.authority,
      runBudgetUsd: fromMicro(row.run_budget_micro),
      attempts: row.attempts,
    };
  }
}

function viewOf(project: ProjectRow): ProjectView {
  return {
    repo: project.repo,
    installationId: project.installation_id,
    defaultBranch: project.default_branch,
    selfLogins: JSON.parse(project.self_logins) as string[],
  };
}
