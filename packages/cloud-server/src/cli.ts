#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { InviteStore } from './invites.js';

const USAGE = `Usage:
  cloud-server invite create --invites <file> --label <text>
  cloud-server invite list   --invites <file>
  cloud-server invite revoke --invites <file> <inviteId>

The token printed by "create" is shown once; only its digest is stored.`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { invites: { type: 'string' }, label: { type: 'string' } },
  });
  const [group, action, target] = positionals;
  if (group !== 'invite' || values.invites === undefined) {
    console.error(USAGE);
    return 2;
  }
  const store = new InviteStore(values.invites);
  try {
    if (action === 'create' && values.label !== undefined) {
      const invite = store.create(values.label);
      console.log(`inviteId: ${invite.inviteId}`);
      console.log(`token:    ${invite.token}`);
      return 0;
    }
    if (action === 'list') {
      for (const invite of store.list()) {
        const state = invite.revokedAt === null ? 'active' : 'revoked';
        console.log(`${invite.inviteId}\t${state}\t${invite.label}`);
      }
      return 0;
    }
    if (action === 'revoke' && target !== undefined) {
      if (!store.revoke(target)) {
        console.error(`No active invite ${target}`);
        return 1;
      }
      return 0;
    }
    console.error(USAGE);
    return 2;
  } finally {
    store.close();
  }
}

process.exitCode = main(process.argv.slice(2));
