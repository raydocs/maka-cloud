import { existsSync } from 'node:fs';
import { type SpendAccounts, type SpendPolicy, SqliteSpendJournal } from '@maka-cloud/gateway';
import { InviteStore } from '@maka-cloud/server';
import type { SpendCaps, StackConfig } from './config.js';
import { PauseSwitch } from './pause.js';

/**
 * The account ledger over the journal: every reservation is checked against the invite's daily
 * and monthly caps (read from the invites file each time, so the command line changes them at
 * once) and the server's, and is refused while spending is paused.
 */
export function accountLedgerOf(
  journal: SqliteSpendJournal,
  invites: Pick<InviteStore, 'limits'>,
  /** The caps, or a function that reads them at each booking (another process's view of the server's). */
  spend: SpendCaps | (() => SpendCaps | undefined),
  pause: Pick<PauseSwitch, 'isPaused'>,
): SpendAccounts {
  const caps = typeof spend === 'function' ? spend : () => spend;
  return journal.accountLedger({
    limitsOf: (inviteId) => {
      const set = invites.limits(inviteId);
      const policy = caps();
      return (
        set &&
        policy && {
          dailyUsd: set.dailyUsd ?? policy.inviteDailyUsd,
          monthlyUsd: set.monthlyUsd ?? policy.inviteMonthlyUsd,
        }
      );
    },
    // A cap that cannot be read is NaN, which the ledger refuses.
    serverDailyUsd: () => caps()?.serverDailyUsd ?? Number.NaN,
    // While paused every reservation is refused, whoever asks.
    paused: () => pause.isPaused(),
  });
}

export interface ServerLedger {
  accounts: SpendAccounts;
  /** Whether the invite exists and is not revoked, so it may be booked to. */
  hasInvite(inviteId: string): boolean;
  close(): void;
}

/** The settings of another process disagree with the caps the running server wrote down. */
export class SpendPolicyMismatch extends Error {
  override name = 'SpendPolicyMismatch';
  readonly safeToLog = true;
}

const POLICY_ENV: ReadonlyArray<readonly [keyof SpendPolicy, string]> = [
  ['inviteDailyUsd', 'MAKA_CLOUD_INVITE_DAILY_USD'],
  ['inviteMonthlyUsd', 'MAKA_CLOUD_INVITE_MONTHLY_USD'],
  ['serverDailyUsd', 'MAKA_CLOUD_SERVER_DAILY_USD'],
];

export interface OpenServerLedgerOptions {
  /**
   * Caps this process was told to run under (`explicitSpendCaps(env)`). A cap it names that is not
   * the one the server runs under refuses the open: two processes must not book under two policies.
   */
  expected?: Partial<SpendCaps>;
}

/**
 * The running server's ledger, for another process on the same host (the evals): its counters,
 * its pause switch and its caps. The caps are the ones the server wrote down in the journal at its
 * last start, read at each booking, and never this process's own settings; an invite's own caps
 * come from the invites file, as for the server. It books spend and nothing else: the per-task
 * journal of the server is never touched, so a restart of the server cannot mistake another
 * process's holds for its own. Fails when the server has never run here, has never written its
 * caps down, or when `expected` names a cap the server does not run under.
 */
export function openServerLedger(
  config: StackConfig,
  options: OpenServerLedgerOptions = {},
): ServerLedger {
  for (const path of [config.invitesPath, config.gatewaySpendPath]) {
    if (!existsSync(path)) throw new Error(`The server has not run here: ${path} does not exist.`);
  }
  const journal = new SqliteSpendJournal(config.gatewaySpendPath);
  let invites: InviteStore | undefined;
  try {
    const policy = journal.spendPolicy();
    if (policy === undefined) {
      throw new Error(
        `The server has not written its spending limits down in ${config.gatewaySpendPath}: start it once with this version, so every process books under the same caps.`,
      );
    }
    for (const [field, name] of POLICY_ENV) {
      const wanted = options.expected?.[field];
      if (wanted !== undefined && Math.abs(wanted - policy[field]) > 1e-9) {
        throw new SpendPolicyMismatch(
          `${name} is $${wanted} here but the running server runs under $${policy[field]}: unset it, or set what the server has, so both book under one policy.`,
        );
      }
    }
    invites = new InviteStore(config.invitesPath);
  } catch (error) {
    invites?.close();
    journal.close();
    throw error;
  }
  const store = invites;
  return {
    accounts: accountLedgerOf(
      journal,
      store,
      () => journal.spendPolicy(),
      new PauseSwitch(config.pausePath),
    ),
    hasInvite: (inviteId) => store.limits(inviteId) !== undefined,
    close: () => {
      store.close();
      journal.close();
    },
  };
}
