import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { transaction } from './db.js';
import type { SignalManifest } from './events.js';
import {
  DEFAULT_SETTINGS,
  type OwnerSettingsPatch,
  OwnerSettingsPatchSchema,
  type Settings,
  SettingsSchema,
} from './settings.js';
import {
  type CloseReason,
  type EvidenceLink,
  type ItemContext,
  type ItemKind,
  type ItemOption,
  type ItemState,
  type PushState,
  interrupts,
} from './types.js';

type Row = Record<string, unknown>;

export interface TaskRecord {
  taskId: string;
  conversationId: string;
  parentTaskId: string | null;
  runner: string | null;
  title: string | null;
  stepKey: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  paused: boolean;
  createdAt: number;
  lastActivityAt: number;
  stallRaised: boolean;
  finishedAt: number | null;
  manifest: SignalManifest | null;
}

export interface QuestionRecord {
  questionId: string;
  conversationId: string;
  state: 'open' | 'answered' | 'dismissed';
  askedFeedId: number;
}

export interface ItemRecord {
  itemId: string;
  n: number;
  kind: ItemKind;
  conversationId: string;
  taskId: string | null;
  dedupeKey: string;
  ask: string;
  options: ItemOption[];
  allowText: boolean;
  evidence: EvidenceLink[];
  context: ItemContext;
  precondition: string;
  state: ItemState;
  closeReason: CloseReason | null;
  version: number;
  interrupt: boolean;
  pushState: PushState;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface ItemSpec {
  kind: ItemKind;
  conversationId: string;
  taskId: string | null;
  dedupeKey: string;
  ask: string;
  options: ItemOption[];
  allowText: boolean;
  evidence: EvidenceLink[];
  context: ItemContext;
  precondition: string;
}

export interface AnswerRecord {
  answerId: string;
  itemId: string;
  optionId: string;
  text: string | null;
  delivery: 'pending' | 'delivered' | 'closed_without_delivery';
  inFlight: boolean;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  /** Who answered, as the host named them; null for an answer from before schema 3. */
  caller: string | null;
}

export type VerificationState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'could_not_check'
  | 'skipped';

export interface VerificationRecord {
  verificationId: string;
  taskId: string;
  conversationId: string;
  kind: 'coding' | 'research' | 'none';
  state: VerificationState;
  /** Attempts started since the last time it was queued by a person. */
  attempt: number;
  /** Counts the times a person asked to check again; part of every spend key. */
  epoch: number;
  reason: string | null;
  result: { mismatches?: Array<{ claim: string; found: string }>; code?: string } | null;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Where a spend reservation is: held against the day's cap, or armed (the conversation budget accepted it and a model may be running). */
export type SpendStage = 'reserve' | 'armed' | 'settle' | 'release';

const str = (value: unknown): string => String(value);
const optional = (value: unknown): string | null => (value === null ? null : String(value));

/** All SQL of the supervisor. Methods are synchronous; callers group them with `tx`. */
export class Store {
  constructor(readonly db: DatabaseSync) {}

  tx<T>(work: () => T): T {
    return transaction(this.db, work);
  }

  /**
   * Runs `work` inside the open transaction so that a throw undoes only its own
   * writes. A feed entry the rules cannot handle is skipped, not allowed to
   * wedge the supervisor on it forever.
   */
  scope<T>(work: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
    this.db.exec('SAVEPOINT entry');
    try {
      const value = work();
      this.db.exec('RELEASE entry');
      return { ok: true, value };
    } catch (error) {
      this.db.exec('ROLLBACK TO entry');
      this.db.exec('RELEASE entry');
      return { ok: false, error };
    }
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes), id: Number(result.lastInsertRowid) };
  }

  // cursor

  cursor(): number {
    const row = this.get("SELECT value FROM meta WHERE key = 'cursor'");
    return row ? Number(row.value) : 0;
  }

  setCursor(id: number): void {
    this.run(
      "INSERT INTO meta (key, value) VALUES ('cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(id),
    );
  }

  /** When the supervisor first started; earlier feed entries are history and raise no items. */
  firstStart(now: number): number {
    this.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('first_start_at', ?)", String(now));
    return Number((this.get("SELECT value FROM meta WHERE key = 'first_start_at'") as Row).value);
  }

  // settings

  settings(initial: Partial<Settings> = {}): Settings {
    const row = this.get("SELECT value FROM settings WHERE key = 'settings'");
    const stored = row ? (JSON.parse(str(row.value)) as unknown) : {};
    return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...initial, ...(stored as object) });
  }

  putSettings(settings: Settings): void {
    this.run(
      "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      JSON.stringify(settings),
    );
  }

  /** What this owner chose for themselves; nothing for an owner who chose nothing. */
  ownerSettings(owner: string): OwnerSettingsPatch {
    const row = this.get('SELECT value FROM owner_settings WHERE owner = ?', owner);
    return row ? OwnerSettingsPatchSchema.parse(JSON.parse(str(row.value))) : {};
  }

  putOwnerSettings(owner: string, settings: OwnerSettingsPatch): void {
    this.run(
      'INSERT INTO owner_settings (owner, value) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET value = excluded.value',
      owner,
      JSON.stringify(settings),
    );
  }

  // tasks

  task(taskId: string): TaskRecord | undefined {
    const row = this.get('SELECT * FROM tasks WHERE task_id = ?', taskId);
    return row ? toTask(row) : undefined;
  }

  insertTask(task: TaskRecord): void {
    this.run(
      `INSERT OR IGNORE INTO tasks (task_id, conversation_id, parent_task_id, runner, title, step_key, state, paused,
         created_at, last_activity_at, stall_raised, finished_at, manifest)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NULL, NULL)`,
      task.taskId,
      task.conversationId,
      task.parentTaskId,
      task.runner,
      task.title,
      task.stepKey,
      task.state,
      task.createdAt,
      task.lastActivityAt,
    );
  }

  setTaskState(
    taskId: string,
    state: TaskRecord['state'],
    at: number,
    manifest?: SignalManifest,
  ): void {
    const ended = state === 'succeeded' || state === 'failed' || state === 'cancelled';
    this.run(
      'UPDATE tasks SET state = ?, finished_at = ?, manifest = COALESCE(?, manifest) WHERE task_id = ?',
      state,
      ended ? at : null,
      manifest ? JSON.stringify(manifest) : null,
      taskId,
    );
  }

  setPaused(taskId: string, paused: boolean): void {
    this.run('UPDATE tasks SET paused = ? WHERE task_id = ?', paused ? 1 : 0, taskId);
  }

  setStallRaised(taskId: string): void {
    this.run('UPDATE tasks SET stall_raised = 1 WHERE task_id = ?', taskId);
  }

  /**
   * Records activity for a task and every ancestor, so a parent waiting on a
   * busy child is not stalled. Returns the tasks whose stall episode ended.
   */
  bumpActivity(taskId: string, at: number): string[] {
    const cleared: string[] = [];
    let current: string | null = taskId;
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      const row: Row | undefined = this.get(
        'SELECT parent_task_id, stall_raised, last_activity_at FROM tasks WHERE task_id = ?',
        current,
      );
      if (!row) break;
      if (Number(row.stall_raised) === 1) cleared.push(current);
      this.run(
        'UPDATE tasks SET last_activity_at = MAX(last_activity_at, ?), stall_raised = 0 WHERE task_id = ?',
        at,
        current,
      );
      current = optional(row.parent_task_id);
    }
    return cleared;
  }

  idleTasks(runningBefore: number, queuedBefore: number): TaskRecord[] {
    return this.all(
      `SELECT * FROM tasks WHERE paused = 0 AND stall_raised = 0 AND (
         (state = 'running' AND last_activity_at < ?) OR (state = 'queued' AND last_activity_at < ?))
       ORDER BY last_activity_at, task_id`,
      runningBefore,
      queuedBefore,
    ).map(toTask);
  }

  activeTaskCount(): number {
    return Number(
      (this.get("SELECT COUNT(*) AS c FROM tasks WHERE state IN ('queued', 'running')") as Row).c,
    );
  }

  // step failures

  recordFailure(stepKey: string, taskId: string, at: number): void {
    this.run(
      'INSERT OR IGNORE INTO step_failures (step_key, task_id, at) VALUES (?, ?, ?)',
      stepKey,
      taskId,
      at,
    );
  }

  failedTasks(stepKey: string): string[] {
    return this.all(
      'SELECT task_id FROM step_failures WHERE step_key = ? ORDER BY at, task_id',
      stepKey,
    ).map((row) => str(row.task_id));
  }

  /** Forgets the failures of a step, including the per-reason keys of an untitled one. */
  clearFailures(stepKey: string): void {
    this.run(
      "DELETE FROM step_failures WHERE step_key = ? OR step_key LIKE ? ESCAPE '\\'",
      stepKey,
      `${stepKey.replace(/[\\%_]/gu, '\\$&')}:%`,
    );
  }

  // questions

  question(questionId: string): QuestionRecord | undefined {
    const row = this.get('SELECT * FROM questions WHERE question_id = ?', questionId);
    return row ? toQuestion(row) : undefined;
  }

  insertQuestion(question: QuestionRecord): void {
    this.run(
      'INSERT OR IGNORE INTO questions (question_id, conversation_id, state, asked_feed_id) VALUES (?, ?, ?, ?)',
      question.questionId,
      question.conversationId,
      question.state,
      question.askedFeedId,
    );
  }

  setQuestionState(questionId: string, state: QuestionRecord['state']): void {
    this.run('UPDATE questions SET state = ? WHERE question_id = ?', state, questionId);
  }

  openQuestions(conversationId: string): QuestionRecord[] {
    return this.all(
      "SELECT * FROM questions WHERE conversation_id = ? AND state = 'open' ORDER BY asked_feed_id",
      conversationId,
    ).map(toQuestion);
  }

  // items

  item(itemId: string): ItemRecord | undefined {
    const row = this.get('SELECT * FROM items WHERE item_id = ?', itemId);
    return row ? toItem(row) : undefined;
  }

  openItemByDedupe(dedupeKey: string): ItemRecord | undefined {
    const row = this.get(
      "SELECT * FROM items WHERE dedupe_key = ? AND state != 'closed'",
      dedupeKey,
    );
    return row ? toItem(row) : undefined;
  }

  /** Whether an item with this dedupe key was ever raised, open or closed. */
  itemEverRaised(dedupeKey: string): boolean {
    return (
      this.get('SELECT 1 AS found FROM items WHERE dedupe_key = ? LIMIT 1', dedupeKey) !== undefined
    );
  }

  /** Active items of a task, or of a question, by dedupe-key prefix. */
  activeItemsByKeyPrefix(prefix: string): ItemRecord[] {
    return this.all(
      "SELECT * FROM items WHERE state != 'closed' AND dedupe_key LIKE ? ESCAPE '\\' ORDER BY n",
      `${prefix.replace(/[\\%_]/gu, '\\$&')}%`,
    ).map(toItem);
  }

  activeItemsOfConversation(conversationId: string): ItemRecord[] {
    return this.all(
      "SELECT * FROM items WHERE conversation_id = ? AND state != 'closed' ORDER BY n",
      conversationId,
    ).map(toItem);
  }

  insertItem(spec: ItemSpec, at: number): ItemRecord {
    const itemId = `itm_${randomUUID().replaceAll('-', '')}`;
    const n = Number((this.get('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM items') as Row).n);
    const push: PushState = interrupts(spec.kind) ? 'pending' : 'none';
    this.run(
      `INSERT INTO items (item_id, n, kind, conversation_id, task_id, dedupe_key, ask, options, allow_text,
         evidence, context, precondition, state, close_reason, version, interrupt, push_state,
         created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 1, ?, ?, ?, ?, NULL)`,
      itemId,
      n,
      spec.kind,
      spec.conversationId,
      spec.taskId,
      spec.dedupeKey,
      spec.ask,
      JSON.stringify(spec.options),
      spec.allowText ? 1 : 0,
      JSON.stringify(spec.evidence),
      JSON.stringify(spec.context),
      spec.precondition,
      interrupts(spec.kind) ? 1 : 0,
      push,
      at,
      at,
    );
    this.logItem(itemId, 'created', at);
    this.markDirty(itemId, 1);
    return this.item(itemId) as ItemRecord;
  }

  /** Rewrites what an open item shows after its state moved; the version counts the rewrite. */
  refreshItem(
    itemId: string,
    spec: Pick<ItemSpec, 'ask' | 'options' | 'evidence' | 'context' | 'precondition'>,
    at: number,
  ): void {
    this.run(
      `UPDATE items SET ask = ?, options = ?, evidence = ?, context = ?, precondition = ?,
         version = version + 1, updated_at = ? WHERE item_id = ?`,
      spec.ask,
      JSON.stringify(spec.options),
      JSON.stringify(spec.evidence),
      JSON.stringify(spec.context),
      spec.precondition,
      at,
      itemId,
    );
    this.logItem(itemId, 'refreshed', at);
    this.markDirty(itemId, this.itemVersion(itemId));
  }

  setItemState(itemId: string, state: ItemState, at: number): void {
    this.run(
      'UPDATE items SET state = ?, version = version + 1, updated_at = ? WHERE item_id = ?',
      state,
      at,
      itemId,
    );
    this.logItem(itemId, state, at);
    this.markDirty(itemId, this.itemVersion(itemId));
  }

  /** Closes an item that is not closed yet. Returns false when it already was. */
  closeItem(itemId: string, reason: CloseReason, at: number): boolean {
    const result = this.run(
      `UPDATE items SET state = 'closed', close_reason = ?, closed_at = ?, version = version + 1, updated_at = ?
       WHERE item_id = ? AND state != 'closed'`,
      reason,
      at,
      at,
      itemId,
    );
    if (result.changes === 0) return false;
    this.logItem(itemId, `closed:${reason}`, at);
    this.markDirty(itemId, this.itemVersion(itemId));
    return true;
  }

  setPushState(itemId: string, pushState: PushState): void {
    this.run('UPDATE items SET push_state = ? WHERE item_id = ?', pushState, itemId);
  }

  pendingPushes(): ItemRecord[] {
    return this.all(
      "SELECT * FROM items WHERE push_state = 'pending' AND state != 'closed' ORDER BY n",
    ).map(toItem);
  }

  heldPushes(): ItemRecord[] {
    return this.all(
      "SELECT * FROM items WHERE push_state = 'held' AND state != 'closed' ORDER BY n",
    ).map(toItem);
  }

  /** `conversations`, when given, keeps only the items of those conversations. */
  listItems(filter: {
    states: ItemState[];
    afterN: number;
    limit: number;
    conversations?: readonly string[];
  }): ItemRecord[] {
    const marks = filter.states.map(() => '?').join(', ');
    const scope = filter.conversations === undefined ? null : JSON.stringify(filter.conversations);
    return this.all(
      `SELECT * FROM items WHERE state IN (${marks}) AND n > ?
         AND (? IS NULL OR conversation_id IN (SELECT value FROM json_each(?)))
       ORDER BY n LIMIT ?`,
      ...filter.states,
      filter.afterN,
      scope,
      scope,
      filter.limit,
    ).map(toItem);
  }

  itemsClosedSince(since: number): ItemRecord[] {
    return this.all(
      "SELECT * FROM items WHERE state = 'closed' AND closed_at >= ? ORDER BY n",
      since,
    ).map(toItem);
  }

  itemsCreatedSince(since: number): ItemRecord[] {
    return this.all('SELECT * FROM items WHERE created_at >= ? ORDER BY n', since).map(toItem);
  }

  private itemVersion(itemId: string): number {
    return Number((this.get('SELECT version FROM items WHERE item_id = ?', itemId) as Row).version);
  }

  logItem(itemId: string, kind: string, at: number, detail?: string): void {
    this.run(
      'INSERT INTO item_events (item_id, kind, at, detail) VALUES (?, ?, ?, ?)',
      itemId,
      kind,
      at,
      detail ?? null,
    );
  }

  itemEvents(itemId: string): Array<{ kind: string; at: number; detail: string | null }> {
    return this.all(
      'SELECT kind, at, detail FROM item_events WHERE item_id = ? ORDER BY id',
      itemId,
    ).map((row) => ({ kind: str(row.kind), at: Number(row.at), detail: optional(row.detail) }));
  }

  // feed outbox

  markDirty(itemId: string, version: number): void {
    this.run(
      `INSERT INTO feed_outbox (item_id, version) VALUES (?, ?)
       ON CONFLICT (item_id) DO UPDATE SET version = excluded.version`,
      itemId,
      version,
    );
  }

  dirtyItems(limit: number): Array<{ itemId: string; version: number }> {
    return this.all('SELECT item_id, version FROM feed_outbox ORDER BY rowid LIMIT ?', limit).map(
      (row) => ({ itemId: str(row.item_id), version: Number(row.version) }),
    );
  }

  /** Clears the marker only if the item did not change since it was published. */
  clearDirty(itemId: string, version: number): void {
    this.run('DELETE FROM feed_outbox WHERE item_id = ? AND version = ?', itemId, version);
  }

  // deliveries (the hourly cap)

  deliveriesSince(since: number): number {
    return Number((this.get('SELECT COUNT(*) AS c FROM deliveries WHERE at > ?', since) as Row).c);
  }

  recordDelivery(at: number, kind: 'interrupt' | 'batch', count: number): void {
    this.run('INSERT INTO deliveries (at, kind, count) VALUES (?, ?, ?)', at, kind, count);
  }

  // answers

  answer(answerId: string): AnswerRecord | undefined {
    const row = this.get('SELECT * FROM answers WHERE answer_id = ?', answerId);
    return row ? toAnswer(row) : undefined;
  }

  answerOfItem(itemId: string): AnswerRecord | undefined {
    const row = this.get('SELECT * FROM answers WHERE item_id = ?', itemId);
    return row ? toAnswer(row) : undefined;
  }

  insertAnswer(answer: {
    answerId: string;
    itemId: string;
    optionId: string;
    text: string | null;
    delivery: AnswerRecord['delivery'];
    caller: string | null;
    at: number;
  }): void {
    this.run(
      `INSERT INTO answers (answer_id, item_id, option_id, text, delivery, in_flight, attempts, next_attempt_at, created_at, caller)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      answer.answerId,
      answer.itemId,
      answer.optionId,
      answer.text,
      answer.delivery,
      answer.at,
      answer.at,
      answer.caller,
    );
    this.logAnswer(answer.answerId, `claimed:${answer.delivery}`, answer.at);
  }

  /** Takes the right to attempt a delivery. Only one attempt runs at a time per answer. */
  beginAttempt(answerId: string): boolean {
    const result = this.run(
      "UPDATE answers SET in_flight = 1, attempts = attempts + 1 WHERE answer_id = ? AND delivery = 'pending' AND in_flight = 0",
      answerId,
    );
    return result.changes === 1;
  }

  endAttempt(answerId: string, nextAttemptAt: number): void {
    this.run(
      'UPDATE answers SET in_flight = 0, next_attempt_at = ? WHERE answer_id = ?',
      nextAttemptAt,
      answerId,
    );
  }

  finishAnswer(
    answerId: string,
    delivery: 'delivered' | 'closed_without_delivery',
    at: number,
  ): void {
    this.run(
      'UPDATE answers SET in_flight = 0, delivery = ? WHERE answer_id = ?',
      delivery,
      answerId,
    );
    this.logAnswer(answerId, delivery, at);
  }

  resetInFlight(): void {
    this.run('UPDATE answers SET in_flight = 0 WHERE in_flight = 1');
  }

  dueAnswers(at: number): AnswerRecord[] {
    return this.all(
      "SELECT * FROM answers WHERE delivery = 'pending' AND in_flight = 0 AND next_attempt_at <= ? ORDER BY created_at",
      at,
    ).map(toAnswer);
  }

  logAnswer(answerId: string, outcome: string, at: number): void {
    this.run(
      'INSERT INTO answer_log (answer_id, outcome, at) VALUES (?, ?, ?)',
      answerId,
      outcome,
      at,
    );
  }

  // digests

  /** Claims a scheduled slot once. Returns false when it was claimed before. */
  claimDigestSlot(digestId: string, slot: string, at: number, owner?: string): boolean {
    const result = this.run(
      "INSERT OR IGNORE INTO digests (digest_id, slot, at, body, published, owner) VALUES (?, ?, ?, '', 0, ?)",
      digestId,
      slot,
      at,
      owner ?? null,
    );
    return result.changes === 1;
  }

  insertDigest(digestId: string, body: unknown, at: number, owner?: string): void {
    this.run(
      'INSERT INTO digests (digest_id, slot, at, body, published, owner) VALUES (?, NULL, ?, ?, 0, ?)',
      digestId,
      at,
      JSON.stringify(body),
      owner ?? null,
    );
  }

  setDigestBody(digestId: string, body: unknown): void {
    this.run('UPDATE digests SET body = ? WHERE digest_id = ?', JSON.stringify(body), digestId);
  }

  setDigestPublished(digestId: string): void {
    this.run('UPDATE digests SET published = 1 WHERE digest_id = ?', digestId);
  }

  unpublishedDigests(): Array<{ digestId: string; body: unknown }> {
    return this.all(
      "SELECT digest_id, body FROM digests WHERE published = 0 AND body != '' ORDER BY at",
    ).map((row) => ({ digestId: str(row.digest_id), body: JSON.parse(str(row.body)) as unknown }));
  }

  /** When the owner's last digest was built (`undefined`: the digest of items nobody owns). */
  lastDigestAt(owner?: string): number {
    const row = this.get(
      "SELECT MAX(at) AS at FROM digests WHERE body != '' AND owner IS ?",
      owner ?? null,
    );
    return row && row.at !== null ? Number(row.at) : 0;
  }

  // verifications

  verification(taskId: string): VerificationRecord | undefined {
    const row = this.get('SELECT * FROM verifications WHERE task_id = ?', taskId);
    return row ? toVerification(row) : undefined;
  }

  /** Claims the task's one verification. A repeated event or a restart finds the row and does nothing. */
  enqueueVerification(
    task: Pick<TaskRecord, 'taskId' | 'conversationId'>,
    kind: VerificationRecord['kind'],
    at: number,
  ): boolean {
    const verificationId = `ver_${randomUUID().replaceAll('-', '')}`;
    const result = this.run(
      `INSERT OR IGNORE INTO verifications
         (verification_id, task_id, conversation_id, kind, state, attempt, epoch, reason, result,
          next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL, ?, ?, ?)`,
      verificationId,
      task.taskId,
      task.conversationId,
      kind,
      kind === 'none' ? 'skipped' : 'queued',
      kind === 'none' ? 'nothing to check against' : null,
      at,
      at,
      at,
    );
    return result.changes === 1;
  }

  /** Running work left by a process that stopped goes back to the queue. */
  requeueRunning(): void {
    this.run("UPDATE verifications SET state = 'queued' WHERE state = 'running'");
  }

  /** Starts up to `limit` due verifications: each is marked running and counts an attempt. */
  claimDueVerifications(at: number, limit: number): VerificationRecord[] {
    if (limit <= 0) return [];
    const due = this.all(
      "SELECT * FROM verifications WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY created_at, verification_id LIMIT ?",
      at,
      limit,
    ).map(toVerification);
    for (const row of due) {
      this.run(
        "UPDATE verifications SET state = 'running', attempt = attempt + 1, updated_at = ? WHERE verification_id = ?",
        at,
        row.verificationId,
      );
    }
    return due.map((row) => ({
      ...row,
      state: 'running',
      attempt: row.attempt + 1,
      updatedAt: at,
    }));
  }

  finishVerification(
    verificationId: string,
    state: Exclude<VerificationState, 'queued' | 'running'>,
    reason: string | null,
    result: VerificationRecord['result'],
    at: number,
  ): void {
    this.run(
      'UPDATE verifications SET state = ?, reason = ?, result = ?, updated_at = ? WHERE verification_id = ?',
      state,
      reason,
      result === null ? null : JSON.stringify(result),
      at,
      verificationId,
    );
  }

  retryVerificationLater(
    verificationId: string,
    reason: string,
    nextAttemptAt: number,
    at: number,
  ): void {
    this.run(
      "UPDATE verifications SET state = 'queued', reason = ?, next_attempt_at = ?, updated_at = ? WHERE verification_id = ?",
      reason,
      nextAttemptAt,
      at,
      verificationId,
    );
  }

  /** A person asked to check again: a fresh set of attempts and a new epoch, so no spend key repeats. */
  requeueVerification(taskId: string, at: number): boolean {
    return (
      this.run(
        `UPDATE verifications SET state = 'queued', attempt = 0, epoch = epoch + 1, reason = NULL, result = NULL,
           next_attempt_at = ?, updated_at = ?
         WHERE task_id = ? AND state IN ('could_not_check', 'failed')`,
        at,
        at,
        taskId,
      ).changes === 1
    );
  }

  activeVerificationCount(): number {
    return Number(
      (
        this.get(
          "SELECT COUNT(*) AS n FROM verifications WHERE state IN ('queued', 'running')",
        ) as Row
      ).n,
    );
  }

  // verifier spend

  /** What the day has charged: the latest row of each key, so a settlement replaces its reservation. */
  spentOn(day: string): number {
    const row = this.get(
      `SELECT COALESCE(SUM(s.usd), 0) AS usd FROM verifier_spend s
       WHERE s.day = ? AND s.id = (SELECT MAX(id) FROM verifier_spend WHERE key = s.key)`,
      day,
    ) as Row;
    return Number(row.usd);
  }

  /** The day's cap check and the reservation are one write: two at the cap cannot both pass. */
  reserveVerifierSpend(key: string, day: string, usd: number, capUsd: number, at: number): boolean {
    if (this.spentOn(day) + usd > capUsd + 1e-9) return false;
    this.recordSpend(key, day, 'reserve', usd, at);
    return true;
  }

  recordSpend(key: string, day: string, stage: SpendStage, usd: number, at: number): void {
    this.run(
      'INSERT INTO verifier_spend (key, day, stage, usd, at) VALUES (?, ?, ?, ?, ?)',
      key,
      day,
      stage,
      usd,
      at,
    );
  }

  spendOf(key: string): { day: string; stage: SpendStage; usd: number } | undefined {
    const row = this.get(
      'SELECT day, stage, usd FROM verifier_spend WHERE key = ? ORDER BY id DESC LIMIT 1',
      key,
    );
    return row
      ? { day: str(row.day), stage: row.stage as SpendStage, usd: Number(row.usd) }
      : undefined;
  }

  /** Reservations that never settled: a process stopped between reserving and settling. */
  openSpends(): Array<{ key: string; day: string; stage: 'reserve' | 'armed'; usd: number }> {
    return this.all(
      `SELECT key, day, stage, usd FROM verifier_spend s
       WHERE id = (SELECT MAX(id) FROM verifier_spend WHERE key = s.key) AND stage IN ('reserve', 'armed')
       ORDER BY id`,
    ).map((row) => ({
      key: str(row.key),
      day: str(row.day),
      stage: row.stage as 'reserve' | 'armed',
      usd: Number(row.usd),
    }));
  }

  /** Slots claimed whose digest was never built (a crash in between). */
  emptySlots(): Array<{ digestId: string; owner: string | undefined }> {
    return this.all("SELECT digest_id, owner FROM digests WHERE body = '' ORDER BY at").map(
      (row) => ({
        digestId: str(row.digest_id),
        owner: row.owner === null ? undefined : str(row.owner),
      }),
    );
  }
}

function toTask(row: Row): TaskRecord {
  return {
    taskId: str(row.task_id),
    conversationId: str(row.conversation_id),
    parentTaskId: optional(row.parent_task_id),
    runner: optional(row.runner),
    title: optional(row.title),
    stepKey: str(row.step_key),
    state: row.state as TaskRecord['state'],
    paused: Number(row.paused) === 1,
    createdAt: Number(row.created_at),
    lastActivityAt: Number(row.last_activity_at),
    stallRaised: Number(row.stall_raised) === 1,
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    manifest: row.manifest === null ? null : (JSON.parse(str(row.manifest)) as SignalManifest),
  };
}

function toVerification(row: Row): VerificationRecord {
  return {
    verificationId: str(row.verification_id),
    taskId: str(row.task_id),
    conversationId: str(row.conversation_id),
    kind: row.kind as VerificationRecord['kind'],
    state: row.state as VerificationState,
    attempt: Number(row.attempt),
    epoch: Number(row.epoch),
    reason: optional(row.reason),
    result:
      row.result === null ? null : (JSON.parse(str(row.result)) as VerificationRecord['result']),
    nextAttemptAt: Number(row.next_attempt_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toQuestion(row: Row): QuestionRecord {
  return {
    questionId: str(row.question_id),
    conversationId: str(row.conversation_id),
    state: row.state as QuestionRecord['state'],
    askedFeedId: Number(row.asked_feed_id),
  };
}

function toItem(row: Row): ItemRecord {
  return {
    itemId: str(row.item_id),
    n: Number(row.n),
    kind: row.kind as ItemKind,
    conversationId: str(row.conversation_id),
    taskId: optional(row.task_id),
    dedupeKey: str(row.dedupe_key),
    ask: str(row.ask),
    options: JSON.parse(str(row.options)) as ItemOption[],
    allowText: Number(row.allow_text) === 1,
    evidence: JSON.parse(str(row.evidence)) as EvidenceLink[],
    context: JSON.parse(str(row.context)) as ItemContext,
    precondition: str(row.precondition),
    state: row.state as ItemState,
    closeReason: row.close_reason === null ? null : (row.close_reason as CloseReason),
    version: Number(row.version),
    interrupt: Number(row.interrupt) === 1,
    pushState: row.push_state as PushState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
  };
}

function toAnswer(row: Row): AnswerRecord {
  return {
    answerId: str(row.answer_id),
    itemId: str(row.item_id),
    optionId: str(row.option_id),
    text: optional(row.text),
    delivery: row.delivery as AnswerRecord['delivery'],
    inFlight: Number(row.in_flight) === 1,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    createdAt: Number(row.created_at),
    caller: optional(row.caller),
  };
}
