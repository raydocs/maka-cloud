import { existsSync } from 'node:fs';
import { type SpendAccounts, SqliteSpendJournal } from '@maka-cloud/gateway';
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
  spend: SpendCaps,
  pause: Pick<PauseSwitch, 'isPaused'>,
): SpendAccounts {
  return journal.accountLedger({
    limitsOf: (inviteId) => {
      const set = invites.limits(inviteId);
      return (
        set && {
          dailyUsd: set.dailyUsd ?? spend.inviteDailyUsd,
          monthlyUsd: set.monthlyUsd ?? spend.inviteMonthlyUsd,
        }
      );
    },
    serverDailyUsd: () => spend.serverDailyUsd,
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

/**
 * The running server's ledger, for another process on the same host (the evals): its counters,
 * its caps and its pause switch, read from its data directory. It books spend and nothing else:
 * the per-task journal of the server is never touched, so a restart of the server cannot mistake
 * another process's holds for its own. Fails when the server has never run there.
 */
export function openServerLedger(config: StackConfig): ServerLedger {
  for (const path of [config.invitesPath, config.gatewaySpendPath]) {
    if (!existsSync(path)) throw new Error(`The server has not run here: ${path} does not exist.`);
  }
  const journal = new SqliteSpendJournal(config.gatewaySpendPath);
  let invites: InviteStore;
  try {
    invites = new InviteStore(config.invitesPath);
  } catch (error) {
    journal.close();
    throw error;
  }
  return {
    accounts: accountLedgerOf(journal, invites, config.spend, new PauseSwitch(config.pausePath)),
    hasInvite: (inviteId) => invites.limits(inviteId) !== undefined,
    close: () => {
      invites.close();
      journal.close();
    },
  };
}
