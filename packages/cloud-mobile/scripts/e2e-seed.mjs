// Prepares the fake stack for the Maestro flows (cloud-web/tests/support/serve.ts: the real server with
// a scripted runner and no model). Prints `KEY=value` lines for `maestro test -e`.
//
//   node scripts/e2e-seed.mjs <control url> <api url> fresh      a new invite with nothing in it
//   node scripts/e2e-seed.mjs <control url> <api url> decision   a new invite with a finished task whose
//                                                                 result waits on one decision (also prints
//                                                                 TASK= and ITEM=, for the deep-link flow)
//   node scripts/e2e-seed.mjs <control url> <api url> email      a new invite for a person who signs in by
//                                                                 emailed code and gives it once
//   node scripts/e2e-seed.mjs <control url> <api url> delivery   a new invite with a finished task that
//                                                                 left a picture, a diff and a pull request
import { crc32, deflateSync } from 'node:zlib';

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
  // The inbox raises its item a moment after the task ends.
  let itemId;
  for (let i = 0; i < 50 && itemId === undefined; i++) {
    const listed = await fetch(`${api}/v1/inbox/items?state=open&limit=200`, { headers });
    const { items = [] } = listed.ok ? await listed.json() : {};
    itemId = items.find((item) => item.taskId === taskId)?.itemId;
    if (itemId === undefined) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (itemId === undefined) throw new Error('decision: the inbox raised no item');
  console.log(`TASK=${taskId}`);
  console.log(`ITEM=${itemId}`);
}

if (kind === 'delivery') {
  const created = await fetch(`${api}/v1/conversations`, { method: 'POST', headers, body: '{}' });
  const { conversationId } = await created.json();
  await fetch(`${api}/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Fix the login loop', clientMessageId: 'seed-1' }),
  });
  const { taskId } = await op('delegate', { conversationId, title: 'Fix the login loop' });
  await op('progress', { taskId, note: 'Reading the login code' });
  await op('opened', {
    taskId,
    pages: [
      { url: 'https://docs.example.test/redirects', label: 'docs' },
      { url: 'https://preview.example.test/app', label: 'preview' },
    ],
  });
  await op('artifact', { taskId, ref: 'out/login-page-after-fix.png', base64: gradientPng() });
  await op('artifact', {
    taskId,
    ref: 'out/changes.diff',
    content: '+redirect once\n-redirect forever\n context\n',
  });
  await op('complete', {
    taskId,
    manifest: {
      summary: 'The login page no longer loops. Tests pass and the screenshot shows it.',
      done: ['Redirects once after sign-in', 'Added a test for the loop'],
      artifacts: [
        'out/login-page-after-fix.png',
        'out/changes.diff',
        'https://github.com/example/repo/pull/12',
      ],
    },
  });
}

/** A 480x300 blue-to-green PNG, so the picture on the card is something to look at. */
function gradientPng() {
  const [width, height] = [480, 300];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = 40 + Math.round((90 * y) / height);
      raw[row + 2 + x * 3] = 90 + Math.round((140 * x) / width);
      raw[row + 3 + x * 3] = 210 - Math.round((120 * x) / width);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

console.log(`TOKEN=${invite.token}`);
