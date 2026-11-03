import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Delivery, type Headers, readDelivery } from '@maka-cloud/duties';
import type { InstaboxClient } from '@maka-cloud/instabox';
import type { DutyService } from '@maka-cloud/server';
import type { StuckChoice } from '@maka-cloud/supervisor';
import {
  formatStuckAsk,
  type IngestInput,
  type IngestResult,
  type SandboxPort,
  type StuckCard,
  Superagent,
  type SuperagentOptions,
  SqliteSuperagentStore,
  type SuperagentStore,
  type WatchdogFinding,
} from '@maka-cloud/superagent';
import type { DutyLink } from './config.js';

const STUCK_TITLE_MAX = 120;

export interface SuperagentInbox {
  createConversation(input: {
    owner: string;
    key: string;
    title: string;
  }): { ok: true; conversationId: string } | { ok: false; reason: string };
  raiseStuck(input: StuckChoice): boolean;
  postNotice(conversationId: string, text: string): Promise<void>;
}

export interface HostSuperagent {
  agent: Superagent;
  cards: StuckCard[];
  ingest(input: IngestInput): Promise<IngestResult>;
  tick(): Promise<WatchdogFinding[]>;
  flushed(): Promise<void>;
  bindInbox(inbox: SuperagentInbox): void;
  enqueue(work: () => Promise<unknown>): void;
  close(): void;
  backupTo(destination: string): Promise<void>;
}

export function startHostSuperagent(
  store: SuperagentStore,
  options: Omit<SuperagentOptions, 'store' | 'onEscalate'> = {},
): HostSuperagent {
  const cards: StuckCard[] = [];
  let inbox: SuperagentInbox | undefined;
  let lastFeed: Promise<void> = Promise.resolve();

  const deliverStuck = (card: StuckCard): void => {
    if (!inbox) return;
    const ask = formatStuckAsk(card);
    const place = inbox.createConversation({
      owner: card.tenantId,
      key: `superagent-stuck:${card.workerId}`,
      title: `Stuck: ${card.subjectKey}`.slice(0, STUCK_TITLE_MAX),
    });
    if (!place.ok) return;
    inbox.raiseStuck({
      conversationId: place.conversationId,
      workerId: card.workerId,
      ask,
      options: card.options.map((option) => ({
        id: option.id,
        label: option.label,
        recommended: option.recommended,
      })),
    });
    void inbox.postNotice(place.conversationId, ask);
  };

  const agent = new Superagent({
    ...options,
    store,
    onEscalate: (card) => {
      cards.push(card);
      deliverStuck(card);
    },
  });

  return {
    agent,
    cards,
    ingest: (input) => agent.ingest(input),
    tick: () => agent.tick(),
    flushed: () => lastFeed,
    bindInbox(next) {
      inbox = next;
      for (const card of cards) deliverStuck(card);
    },
    enqueue(work) {
      lastFeed = lastFeed
        .then(
          () => work(),
          () => undefined,
        )
        .then(
          () => undefined,
          () => undefined,
        );
    },
    close: () => agent.close(),
    backupTo: (destination) => store.backupTo?.(destination) ?? Promise.resolve(),
  };
}

/** Structural wrap so InstaboxClient's extra snapshot signature does not leak. */
export function instaboxSandboxPort(client: InstaboxClient): SandboxPort {
  return {
    ensureRunning: (machineId) => client.ensureRunning(machineId),
    exec: async (machineId, request) => {
      const result = await client.exec(machineId, request);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    getMachine: async (machineId) => {
      const machine = await client.getMachine(machineId);
      return { id: machine.id, state: machine.state };
    },
    createSnapshot: async (machineId, name) => {
      const snapshot = await client.createSnapshot(machineId, { name });
      return { id: snapshot.id };
    },
    deleteSnapshot: (snapshotId) => client.deleteSnapshot(snapshotId),
    waitForSnapshot: async (snapshotId) => {
      await client.waitForSnapshot(snapshotId);
    },
    putActivityLease: (machineId, holder) => client.putActivityLease(machineId, holder, 60),
    deleteActivityLease: (machineId, holder) => client.deleteActivityLease(machineId, holder),
    suspend: async (machineId) => {
      await client.suspendMachine(machineId);
    },
  };
}

export async function openHostSuperagent(
  dbPath: string,
  options: Omit<SuperagentOptions, 'store' | 'onEscalate'> = {},
): Promise<HostSuperagent> {
  await mkdir(dirname(dbPath), { recursive: true });
  return startHostSuperagent(SqliteSuperagentStore.open(dbPath), options);
}

export function tenantIdOfRepo(links: readonly DutyLink[], payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('repository' in payload)) {
    return undefined;
  }
  const repository = (payload as { repository?: { full_name?: unknown } }).repository;
  const name = typeof repository?.full_name === 'string' ? repository.full_name.toLowerCase() : '';
  if (name === '') return undefined;
  return links.find((link) => link.repo === name)?.inviteId;
}

export function attachDutySource(
  service: DutyService,
  secret: string,
  links: readonly DutyLink[],
  runtime: HostSuperagent,
): void {
  const inner = service.webhook.bind(service);
  service.webhook = (headers: Headers, body: Uint8Array) => {
    const result = inner(headers, body);
    if (result.status !== 200) return result;
    const delivery = readDelivery(secret, headers, body);
    if (delivery.ok) {
      runtime.enqueue(() => feedVerifiedDelivery(runtime, links, delivery));
    }
    return result;
  };
}

export async function feedVerifiedDelivery(
  runtime: HostSuperagent,
  links: readonly DutyLink[],
  delivery: Delivery,
): Promise<IngestResult | undefined> {
  if (delivery.event === 'ping') return undefined;
  const tenantId = tenantIdOfRepo(links, delivery.payload);
  if (tenantId === undefined) return undefined;
  return runtime.ingest({
    source: 'github',
    tenantId,
    deliveryId: delivery.deliveryId,
    event: delivery.event,
    payload: delivery.payload,
  });
}
