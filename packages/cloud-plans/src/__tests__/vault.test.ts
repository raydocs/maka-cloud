import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import {
  CLAUDE_TOKEN_LIFE_MS,
  EXPIRY_WARNING_MS,
  PlanKeyError,
  PlanLinkError,
  PlanVault,
  parsePlanKey,
} from '../index.js';

const A = 'inv_aaaaaaaaaaaa';
const B = 'inv_bbbbbbbbbbbb';
const KEY = randomBytes(32).toString('base64');
const TOKEN = `sk-ant-oat01-${'Qx7_-'.repeat(12)}`;
const DAY = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(key = KEY) {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-plans-'));
  dirs.push(dir);
  const path = join(dir, 'plans.db');
  const clock = { now: 1_800_000_000_000 };
  const vault = PlanVault.open({ path, key, now: () => clock.now });
  return { vault, clock, dir, path };
}

/** Every byte of every file the vault wrote. */
async function everythingOnDisk(dir: string): Promise<Buffer> {
  const files = await readdir(dir);
  return Buffer.concat(await Promise.all(files.map((name) => readFile(join(dir, name)))));
}

describe('plan vault', () => {
  it('links a Claude setup token and shows when, without showing the token', async () => {
    const { vault, clock } = await start();
    assert.deepEqual(vault.status(A, 'claude'), { vendor: 'claude', state: 'unlinked' });
    const status = vault.linkClaudeToken(A, `  ${TOKEN}\n`);
    assert.equal(status.state, 'linked');
    assert.equal(status.linkedAt, clock.now);
    assert.equal(status.expiresAt, clock.now + CLAUDE_TOKEN_LIFE_MS);
    assert.equal(status.expiresSoon, false);
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    assert.deepEqual(vault.claudeProcessEnv(A), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    vault.close();
  });

  it('keeps the token out of the file: it is sealed, and the sealed copy is overwritten by unlink', async () => {
    const { vault, dir, path } = await start();
    vault.linkClaudeToken(A, TOKEN);
    assert.ok(!(await everythingOnDisk(dir)).includes(TOKEN), 'sealed at rest');
    const raw = new DatabaseSync(path);
    const sealed = Buffer.from(
      (raw.prepare('SELECT sealed FROM plan_connections').get() as { sealed: Uint8Array }).sealed,
    );
    raw.close();
    assert.ok((await everythingOnDisk(dir)).includes(sealed), 'the sealed copy is in the file');
    assert.equal(vault.unlink(A, 'claude'), true);
    assert.ok(!(await everythingOnDisk(dir)).includes(sealed), 'and is overwritten by the unlink');
    assert.equal(vault.unlink(A, 'claude'), false, 'a second unlink finds nothing');
    assert.deepEqual(vault.status(A, 'claude'), { vendor: 'claude', state: 'unlinked' });
    assert.equal(vault.claudeProcessEnv(A), undefined, 'new tasks stop getting it at once');
    vault.close();
  });

  it('never hands one invite another invite’s token, even from a copied row', async () => {
    const { vault, path } = await start();
    vault.linkClaudeToken(A, TOKEN);
    assert.equal(vault.claudeProcessEnv(B), undefined);
    // Someone with the file copies A's sealed value into B's row: it does not open.
    const raw = new DatabaseSync(path);
    raw.exec(
      `INSERT INTO plan_connections (invite_id, vendor, sealed, linked_at, expires_at)
       SELECT '${B}', vendor, sealed, linked_at, expires_at FROM plan_connections WHERE invite_id = '${A}'`,
    );
    raw.close();
    assert.equal(vault.claudeProcessEnv(B), undefined);
    assert.equal(vault.status(B, 'claude').state, 'broken');
    assert.deepEqual(vault.claudeProcessEnv(A), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    vault.close();
  });

  it('does not open with another key, and says the link is broken instead of failing', async () => {
    const { vault, path, clock } = await start();
    vault.linkClaudeToken(A, TOKEN);
    vault.close();
    const other = PlanVault.open({
      path,
      key: randomBytes(32).toString('hex'),
      now: () => clock.now,
    });
    assert.equal(other.claudeProcessEnv(A), undefined);
    assert.equal(other.status(A, 'claude').state, 'broken');
    other.close();
  });

  it('warns in the last 30 days and refuses an expired token', async () => {
    const { vault, clock } = await start();
    vault.linkClaudeToken(A, TOKEN);
    clock.now += CLAUDE_TOKEN_LIFE_MS - EXPIRY_WARNING_MS - DAY;
    assert.equal(vault.status(A, 'claude').expiresSoon, false);
    clock.now += DAY;
    assert.equal(vault.status(A, 'claude').expiresSoon, true);
    assert.ok(vault.claudeProcessEnv(A));
    clock.now += EXPIRY_WARNING_MS;
    assert.equal(vault.status(A, 'claude').state, 'expired');
    assert.equal(vault.claudeProcessEnv(A), undefined);
    vault.linkClaudeToken(A, TOKEN);
    assert.equal(vault.status(A, 'claude').state, 'linked', 'linking again renews it');
    vault.close();
  });

  it('marks a refused token broken, drops it from the file and never retries; linking again repairs it', async () => {
    const { vault, dir, clock } = await start();
    vault.linkClaudeToken(A, TOKEN);
    vault.linkClaudeToken(B, `${TOKEN}b`);
    clock.now += 1000;
    vault.markBroken(A, 'claude');
    const status = vault.status(A, 'claude');
    assert.equal(status.state, 'broken');
    assert.equal(status.brokenAt, clock.now);
    assert.equal(vault.claudeProcessEnv(A), undefined);
    assert.ok(!(await everythingOnDisk(dir)).includes(TOKEN));
    assert.deepEqual(
      vault.claudeProcessEnv(B),
      { CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN}b` },
      'B is untouched',
    );
    vault.linkClaudeToken(A, TOKEN);
    assert.equal(vault.status(A, 'claude').state, 'linked');
    vault.close();
  });

  it('refuses an API key or anything else, without repeating it', async () => {
    const { vault } = await start();
    const apiKey = `sk-ant-api03-${'z'.repeat(40)}`;
    for (const pasted of [apiKey, 'not a token', '', `${TOKEN} extra`]) {
      assert.throws(
        () => vault.linkClaudeToken(A, pasted),
        (error) => {
          assert.ok(error instanceof PlanLinkError);
          assert.ok(pasted === '' || !error.message.includes(pasted.trim().slice(0, 12)));
          return true;
        },
      );
    }
    assert.equal(vault.status(A, 'claude').state, 'unlinked');
    vault.close();
  });

  it('refuses a key that is not 32 bytes, without repeating it', () => {
    for (const bad of [
      undefined,
      '',
      'short',
      'g'.repeat(64),
      randomBytes(16).toString('base64'),
    ]) {
      assert.throws(
        () => parsePlanKey(bad),
        (error) =>
          error instanceof PlanKeyError &&
          (bad === undefined || bad === '' || !error.message.includes(bad)),
      );
    }
    assert.equal(parsePlanKey(randomBytes(32).toString('hex')).length, 32);
    assert.equal(parsePlanKey(KEY).length, 32);
  });
});
