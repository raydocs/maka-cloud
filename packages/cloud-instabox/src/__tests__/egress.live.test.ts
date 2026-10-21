import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InstaboxClient } from '../client.js';
import { applyEgressGuard } from '../egress.js';

/**
 * The probe for what the guard assumes about a real sandbox: that its user may change firewall
 * rules, that the metadata address is then unreachable, and that the box can still reach the
 * public internet and its own name servers. Run it by hand on a throwaway machine, and again when
 * instabox changes. It runs only with MAKA_CLOUD_LIVE=1, an INSTABOX_API_KEY and an
 * INSTABOX_MACHINE_ID; CI leaves them unset.
 */
const live =
  process.env.MAKA_CLOUD_LIVE === '1' &&
  Boolean(process.env.INSTABOX_API_KEY) &&
  Boolean(process.env.INSTABOX_MACHINE_ID);

test('live probe: the egress guard holds in a real sandbox', {
  skip: !live,
  timeout: 120_000,
}, async () => {
  const client = new InstaboxClient({ apiKey: process.env.INSTABOX_API_KEY ?? '' });
  const machine = process.env.INSTABOX_MACHINE_ID ?? '';
  const curl = async (url: string) =>
    await client.exec(machine, {
      cmd: `curl -sS -m 8 -o /dev/null -w '%{http_code}' ${url}`,
      timeoutSeconds: 30,
    });

  await applyEgressGuard(client, machine);

  const metadata = await curl('http://169.254.169.254/');
  assert.notEqual(metadata.exitCode, 0, 'the metadata address must not answer');
  const open = await curl('https://api.github.com/');
  assert.equal(open.exitCode, 0, `the public internet must still answer: ${open.stderr}`);
  assert.match(open.stdout, /^[23]\d\d$/u);
});
