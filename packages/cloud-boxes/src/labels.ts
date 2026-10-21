import { createHash } from 'node:crypto';
import type { InstaboxMachine } from '@maka-cloud/instabox';

/**
 * Every box the pool owns carries these labels (instabox metadata). A box is found by them and
 * used only when they all match what the pool expects of it: a box with another invite's label, no
 * pool label, or a slot out of range is refused, never used (OpenMuse's rule).
 */
export const LABEL = {
  pool: 'maka.pool',
  invite: 'maka.invite',
  slot: 'maka.slot',
  /** Set while a task holds the box. */
  task: 'maka.task',
  /** The hash of the setup the box was made from (a setup snapshot), when it was. */
  setup: 'maka.setup',
  /** Which repository's checkout the box holds (`repoKey`), when it was made from a setup snapshot. */
  repo: 'maka.repo',
} as const;

export const POOL_LABEL_VALUE = '1';

/**
 * The box's name, unique among the org's live sandboxes, so a create that is sent twice finds the
 * first box instead of making a second. Opaque on purpose: the invite is in the labels.
 */
export function boxName(tenantId: string, slot: number): string {
  return `mk-${inviteDigest(tenantId)}-${slot}`;
}

const inviteDigest = (tenantId: string): string =>
  createHash('sha256').update(tenantId).digest('hex').slice(0, 12);

export function boxLabels(
  tenantId: string,
  slot: number,
  extra: { setup?: string; repo?: string } = {},
): Record<string, string> {
  return {
    [LABEL.pool]: POOL_LABEL_VALUE,
    [LABEL.invite]: tenantId,
    [LABEL.slot]: String(slot),
    ...(extra.setup === undefined ? {} : { [LABEL.setup]: extra.setup }),
    ...(extra.repo === undefined ? {} : { [LABEL.repo]: extra.repo }),
  };
}

export type BoxCheck =
  | { ok: true; tenantId: string; slot: number; taskId?: string; setup?: string; repo?: string }
  | { ok: false; reason: string };

/**
 * Reads a listed or fetched machine as a pool box. `expect` narrows it to one invite and slot; a
 * box that does not match is `ok: false` with the reason, so the caller logs it and goes on.
 */
export function checkBox(
  machine: InstaboxMachine,
  limits: { maxPerInvite: number },
  expect: { tenantId?: string; slot?: number } = {},
): BoxCheck {
  const labels = machine.metadata ?? {};
  if (labels[LABEL.pool] !== POOL_LABEL_VALUE) return { ok: false, reason: 'not a pool box' };
  const tenantId = labels[LABEL.invite];
  if (!tenantId) return { ok: false, reason: 'no invite label' };
  const slotText = labels[LABEL.slot];
  const slot = slotText !== undefined && /^\d{1,3}$/.test(slotText) ? Number(slotText) : -1;
  if (slot < 0 || slot >= limits.maxPerInvite) {
    return {
      ok: false,
      reason: `slot "${slotText ?? ''}" is outside 0..${limits.maxPerInvite - 1}`,
    };
  }
  if (machine.name !== boxName(tenantId, slot)) {
    return {
      ok: false,
      reason: `name "${machine.name ?? ''}" is not the name of that invite's slot`,
    };
  }
  if (expect.tenantId !== undefined && tenantId !== expect.tenantId) {
    return { ok: false, reason: 'it belongs to another invite' };
  }
  if (expect.slot !== undefined && slot !== expect.slot) {
    return { ok: false, reason: `it is slot ${slot}, not ${expect.slot}` };
  }
  const taskId = labels[LABEL.task];
  const setup = labels[LABEL.setup];
  const repo = labels[LABEL.repo];
  return {
    ok: true,
    tenantId,
    slot,
    ...(taskId ? { taskId } : {}),
    ...(setup ? { setup } : {}),
    ...(repo ? { repo } : {}),
  };
}

/** The slot label of a builder box, which is outside the slots of the pool. */
export const BUILDER_SLOT = 'builder';

/** A builder box's name; one per invite at a time. */
export function builderName(tenantId: string): string {
  return `mk-${inviteDigest(tenantId)}-b`;
}

export function builderLabels(tenantId: string, job: string): Record<string, string> {
  return {
    [LABEL.pool]: POOL_LABEL_VALUE,
    [LABEL.invite]: tenantId,
    [LABEL.slot]: BUILDER_SLOT,
    [LABEL.task]: job,
  };
}

/** True for a machine with the exact name and labels of a builder box (of this invite, when given). */
export function isBuilderBox(machine: InstaboxMachine, tenantId?: string): boolean {
  const labels = machine.metadata ?? {};
  const invite = labels[LABEL.invite];
  return (
    labels[LABEL.pool] === POOL_LABEL_VALUE &&
    labels[LABEL.slot] === BUILDER_SLOT &&
    invite !== undefined &&
    (tenantId === undefined || invite === tenantId) &&
    machine.name === builderName(invite)
  );
}
