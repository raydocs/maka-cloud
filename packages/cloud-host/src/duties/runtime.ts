import {
  type DutyEngine,
  type EngineOptions,
  type RepoInspector,
  Dispatcher,
  DutyEngine as Engine,
  GitHubInspector,
  isCardKind,
  KIND_SPECS,
} from '@maka-cloud/duties';
import type { CloudServer, DutyService } from '@maka-cloud/server';
import type { ProposalOutcome, SupervisorHost } from '@maka-cloud/supervisor';
import type { DutyLink } from '../config.js';
import { serverLauncher } from './launcher.js';
import { type DutyRunView, RunSettler } from './settle.js';

export interface DutiesSetup {
  dbPath: string;
  /** The GitHub App's webhook secret. Read from the environment by the caller; never logged. */
  webhookSecret: string;
  /**
   * The repositories projects may be registered for, each with the installation it lives in and
   * the one invite that owns it. Empty: none may.
   */
  links: readonly DutyLink[];
  /** Replaces the GitHub reader, for tests. */
  inspector?: RepoInspector;
  /** How often schedules are looked at and finished runs settled. Default one minute. */
  tickMs?: number;
  /** Replaces setInterval, so a test can see the timer is released. Returns the function that releases it. */
  every?: (fn: () => void, ms: number) => () => void;
  /** Proposed cards are on: the project routes also show and switch the suggestions. */
  cards?: boolean;
  engine?: Pick<EngineOptions, 'now' | 'proposer' | 'onWorkflowRun'>;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** What the duties need once the server and the conductor exist. */
export interface DutiesParts {
  server: Pick<CloudServer, 'startConversation' | 'startedConversation' | 'createConversation'>;
  runsOf(conversationId: string): DutyRunView[];
  /** Puts a notice in the conversation's feed. Durable once it resolves. */
  postNotice(conversationId: string, text: string): Promise<void>;
  /** The supervisor's way to raise the proposal item. False when it cannot be raised. */
  raiseProposal(input: {
    conversationId: string;
    proposalId: string;
    ask: string;
    sets: Array<{ id: string; label: string; recommended: boolean }>;
  }): boolean;
}

export interface DutiesRuntime {
  /** What the server's routes call. Usable before `start`: nothing starts a run until then. */
  service: DutyService;
  /** The decision route the supervisor delivers `proposal` options to. */
  proposals: NonNullable<SupervisorHost['proposals']>;
  engine: DutyEngine;
  /** Begins starting runs, settling them and watching schedules. Once. */
  start(parts: DutiesParts): void;
  /** One pass of the timer's work, now. For tests and for the first look at start. */
  tick(): void;
  /** Stops the timer and the dispatcher. Waits for the launch in progress. */
  stop(): Promise<void>;
  /** Closes the database. Call after the server stopped answering requests. */
  close(): void;
  backupTo(destination: string): Promise<void>;
}

const PROPOSAL_TITLE_MAX = 120;

export function createDuties(setup: DutiesSetup): DutiesRuntime {
  const engine = new Engine({
    dbPath: setup.dbPath,
    webhookSecret: setup.webhookSecret,
    // Fail closed: a repository is registered only by the invite and under the installation the
    // operator tied it to. Naming a repository is not proof that it is yours.
    allowProject: ({ owner, repo, installationId }) =>
      setup.links.some(
        (link) =>
          link.repo === repo.toLowerCase() &&
          link.installationId === installationId &&
          link.inviteId === owner,
      ),
    ...setup.engine,
    ...(setup.onWarning === undefined ? {} : { onWarning: setup.onWarning }),
  });
  const inspector = setup.inspector ?? new GitHubInspector();
  let parts: DutiesParts | undefined;
  let dispatcher: Dispatcher | undefined;
  let settler: RunSettler | undefined;
  let releaseTimer: (() => void) | undefined;
  let stopped = false;
  const warn = setup.onWarning ?? (() => undefined);

  // Everything a pass does is synchronous (a database read or write, or a kick of the dispatcher),
  // so passes cannot overlap.
  const pass = (): void => {
    if (stopped || !dispatcher || !settler) return;
    try {
      engine.tick();
      dispatcher.kick();
      settler.settle();
      deliverNotices();
    } catch (error) {
      warn('A duties pass failed', error);
    }
  };

  // What the engine owes the owner outside any run (a duty that turned itself off, a chain that
  // needs a person, a proposal that did not fit): one conversation per project, at least once.
  // The one delivery in flight keeps passes from sending a notice twice; a failure leaves the
  // notice pending for the next pass.
  let delivering: Promise<void> | undefined;
  const deliverNotices = (): void => {
    const target = parts;
    if (delivering || stopped || !target) return;
    const pending = engine.pendingNotices();
    if (pending.length === 0) return;
    delivering = (async () => {
      for (const notice of pending) {
        if (stopped) return;
        const place = target.server.createConversation({
          owner: notice.owner,
          key: `duty-notice:${notice.projectId}`,
          title: `Standing duties: ${projectName(engine, notice.owner, notice.projectId)}`.slice(
            0,
            PROPOSAL_TITLE_MAX,
          ),
        });
        // An owner who is gone has nobody to tell; any other refusal is a bug, and one stuck
        // notice must not hold back the rest.
        if (!place.ok && place.reason !== 'owner_inactive') {
          warn(`A duty notice could not be placed (${place.reason})`);
        }
        if (place.ok) await target.postNotice(place.conversationId, notice.text);
        engine.noticeDelivered(notice.noticeKey);
      }
    })()
      .catch((error: unknown) => warn('A duty notice was not delivered', error))
      .finally(() => {
        delivering = undefined;
      });
  };

  const service: DutyService = {
    webhook: (headers, body) => engine.receive(headers, body),
    listProjects: (owner) => engine.listProjects(owner),
    project: (owner, projectId) => engine.project(owner, projectId),
    addProject: (owner, input) => {
      const result = engine.addProject(owner, input);
      return result.ok ? { ok: true, project: result.project } : result;
    },
    removeProject: (owner, projectId) => engine.removeProject(owner, projectId),
    setDutyState: (owner, dutyId, state) => engine.setDutyState(owner, dutyId, state),
    propose: async (owner, projectId) => {
      if (!parts) return { ok: false, reason: 'unavailable' };
      const proposed = await engine.propose(owner, projectId, inspector);
      if (!proposed.ok) return proposed;
      if (proposed.proposal.state === 'open') {
        // Idempotent: the conversation is keyed by the proposal, and so is the item.
        const place = parts.server.createConversation({
          owner,
          key: `proposal:${proposed.proposal.proposalId}`,
          title: `Set up standing duties for ${projectName(engine, owner, projectId)}`.slice(
            0,
            PROPOSAL_TITLE_MAX,
          ),
        });
        const raised =
          place.ok &&
          parts.raiseProposal({
            conversationId: place.conversationId,
            proposalId: proposed.proposal.proposalId,
            ask: `Set up standing duties for ${projectName(engine, owner, projectId)}? Nothing runs until you choose.`,
            sets: proposed.proposal.sets.map((set) => ({
              id: set.id,
              label: set.label,
              recommended: set.recommended,
            })),
          });
        // A proposal nobody can decide is not offered as one.
        if (!raised) return { ok: false, reason: 'unavailable' };
      }
      return { ok: true, proposal: proposed.proposal };
    },
  };

  if (setup.cards) {
    service.suggestions = {
      overview: (owner, projectId) => {
        if (!engine.project(owner, projectId)) return undefined;
        return {
          kinds: engine.cards.stats(owner, projectId).map((stat) => ({
            kind: stat.kind,
            label: KIND_SPECS[stat.kind].label,
            enabled: stat.enabled,
            accepted: stat.accepted,
            dismissed: stat.dismissed,
            ignored: stat.ignored,
            ignoredInARow: stat.ignoredInARow,
            backedOff: stat.backedOff,
            offer: stat.offer,
          })),
          cards: engine.cards.list(owner, projectId, ['open']).map((card) => ({
            cardId: card.cardId,
            kind: card.kind,
            title: card.title,
            detail: card.detail,
            mode: card.mode,
            estimateUsd: card.estimateUsd,
            typical: card.typical,
            external: card.external,
          })),
        };
      },
      setKind: (owner, projectId, kind, enabled) => {
        if (!isCardKind(kind) || KIND_SPECS[kind].gated) return 'invalid_kind';
        return engine.cards.setKindEnabled(owner, projectId, kind, enabled) ? 'ok' : 'not_found';
      },
    };
  }

  const proposals: DutiesRuntime['proposals'] = {
    decide: async (decision): Promise<ProposalOutcome> => {
      const result = engine.decideProposal({
        proposalId: decision.proposalId,
        setId: decision.setId,
        // No caller means nobody who may decide.
        caller: decision.caller ?? '',
      });
      return result.ok
        ? { accepted: true, duplicate: result.duplicate }
        : { accepted: false, reason: result.reason };
    },
  };

  return {
    service,
    proposals,
    engine,
    start(next) {
      if (parts) throw new Error('The duties were started already');
      parts = next;
      dispatcher = new Dispatcher({
        engine,
        launcher: serverLauncher(next.server),
        onWarning: warn,
      });
      settler = new RunSettler({
        engine,
        runsOf: (conversationId) => next.runsOf(conversationId),
        onWarning: warn,
      });
      releaseTimer = (setup.every ?? defaultEvery)(pass, setup.tickMs ?? 60_000);
      // Looks at once: schedules that came due while the server was down catch up, and requests
      // claimed before a restart are launched.
      pass();
    },
    tick: pass,
    async stop() {
      stopped = true;
      releaseTimer?.();
      releaseTimer = undefined;
      await dispatcher?.close();
      await delivering;
    },
    close: () => engine.close(),
    backupTo: (destination) => engine.backupTo(destination),
  };
}

function projectName(engine: DutyEngine, owner: string, projectId: string): string {
  return engine.project(owner, projectId)?.repo ?? 'this project';
}

function defaultEvery(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
}
