// Prepares the fake stack for the Maestro flows (cloud-web/tests/support/serve.ts: the real server with
// a scripted runner and no model). Prints `KEY=value` lines for `maestro test -e`.
//
//   node scripts/e2e-seed.mjs <control url> <api url> fresh      a new invite with nothing in it
//   node scripts/e2e-seed.mjs <control url> <api url> decision   a new invite with a finished task whose
//                                                                 result waits on one decision
const [control, api, kind = 'fresh'] = process.argv.slice(2);

async function op(name, body = {}) {
  const response = await fetch(control, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: name, ...body }),
  });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  return response.json();
}

const invite = await op('invite');
const headers = { authorization: `Bearer ${invite.token}`, 'content-type': 'application/json' };

if (kind === 'decision') {
  const created = await fetch(`${api}/v1/conversations`, { method: 'POST', headers, body: '{}' });
  const { conversationId } = await created.json();
  await fetch(`${api}/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Write the weekly report', clientMessageId: 'seed-1' }),
  });
  const { taskId } = await op('delegate', { conversationId, title: 'Weekly report' });
  await op('progress', { taskId, note: 'Working' });
  await op('complete', { taskId, manifest: { summary: 'The weekly report is ready.' } });
}

console.log(`TOKEN=${invite.token}`);
