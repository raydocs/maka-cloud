#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ConversationStore } from './conversations.js';
import { openDatabase } from './db.js';
import { FeedHub } from './feed.js';
import { InviteStore } from './invites.js';

const USAGE = `Usage:
  cloud-server invite create --invites <file> --label <text>
  cloud-server invite list   --invites <file>
  cloud-server invite revoke --invites <file> <inviteId>
  cloud-server conversation adopt --db <file> --invites <file> <inviteId>

The token printed by "create" is shown once; only its digest is stored.
"conversation adopt" gives every conversation without an owner (those from
before owners existed) to an active invite. Run it with the server stopped.`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { invites: { type: 'string' }, label: { type: 'string' }, db: { type: 'string' } },
  });
  const [group, action, target] = positionals;
  if (group === 'conversation' && values.invites !== undefined) {
    return conversation(action, target, values.db, values.invites);
  }
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

function conversation(
  action: string | undefined,
  inviteId: string | undefined,
  dbPath: string | undefined,
  invitesPath: string,
): number {
  if (action !== 'adopt' || inviteId === undefined || dbPath === undefined) {
    console.error(USAGE);
    return 2;
  }
  const invites = new InviteStore(invitesPath);
  try {
    if (!invites.active(inviteId)) {
      console.error(`No active invite ${inviteId}`);
      return 1;
    }
  } finally {
    invites.close();
  }
  // Fails while a server holds the database.
  const db = openDatabase(dbPath);
  try {
    const store = new ConversationStore(db, new FeedHub(), () => {
      throw new Error('adopt creates no conversation');
    });
    console.log(`adopted: ${store.adoptUnowned(inviteId)}`);
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = main(process.argv.slice(2));
