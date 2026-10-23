// The go-live flow: what a first user and the first operator do, run against a server with no real
// model and no real sandbox behind it (the stand-ins in stubs.mjs).
//
//   1. health         the health check passes through the proxy, over TLS
//   2. sign-in        an invite's token opens the API; no token and a wrong one do not
//   3. task           a message starts a task; the result card and the closing message arrive
//   4. approval       a held action gets an approval card; one answer, sent twice, lets it run once
//   5. restart        the server restarts in the middle of a task; the task resumes and finishes once
//   6. backup-restore a backup is taken, the state changes, the restore puts the backup back
//
// It talks to the server over HTTP only, steers the scripted claude through the control API, and
// stops, starts and backs up the server through one script (MAKA_REHEARSAL_OPS), so the same flow
// runs against the Compose stack in CI and, later, against the owner's host after every merge and
// once a day. It never reads a key and spends nothing: the target runs on stand-ins.
//
//   MAKA_REHEARSAL_URL           https://app.example.com            the app name of the stack
//   MAKA_REHEARSAL_TOKEN_FILE    a file holding an invite's token (or MAKA_REHEARSAL_TOKEN)
//   MAKA_REHEARSAL_CA            a PEM file to trust besides the system's (Caddy's own authority)
//   MAKA_REHEARSAL_RESOLVE       an address to connect to whatever the name is (127.0.0.1)
//   MAKA_REHEARSAL_CONTROL_URL   http://127.0.0.1:9102              the stand-ins' control API
//   MAKA_REHEARSAL_OPS           a script: stop | start | restart | backup | backups | restore NAME
//   MAKA_REHEARSAL_XFAIL         steps that are expected to fail (default: none)
//
// A step in MAKA_REHEARSAL_XFAIL that fails is reported as an expected failure and does not fail the
// run; the same step passing fails the run, so the mark is taken off when the fix lands. A name
// followed by `?` (`restart-reply?`) is a step that depends on an expected failure before it: it
// is reported as an expected failure when it fails and as a pass when it does not.
//
// Exit code 0: every step passed or failed as expected. 1: a step failed, or an expected failure
// passed. 2: the flow was not given what it needs.

import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const env = process.env;
const base = env.MAKA_REHEARSAL_URL;
const token = (
  env.MAKA_REHEARSAL_TOKEN ??
  readOptional(env.MAKA_REHEARSAL_TOKEN_FILE) ??
  ''
).trim();
const controlUrl = env.MAKA_REHEARSAL_CONTROL_URL;
const ops = env.MAKA_REHEARSAL_OPS;
const resolveTo = env.MAKA_REHEARSAL_RESOLVE;
const ca = env.MAKA_REHEARSAL_CA ? readFileSync(env.MAKA_REHEARSAL_CA) : undefined;
const marked = (env.MAKA_REHEARSAL_XFAIL ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const xfail = new Set(marked.map((name) => name.replace(/\?$/u, '')));
const mayPass = new Set(
  marked.filter((name) => name.endsWith('?')).map((name) => name.slice(0, -1)),
);

if (!base || !token || !controlUrl || !ops) {
  console.error(
    'the flow needs MAKA_REHEARSAL_URL, a token (MAKA_REHEARSAL_TOKEN_FILE), MAKA_REHEARSAL_CONTROL_URL and MAKA_REHEARSAL_OPS',
  );
  process.exit(2);
}

function readOptional(path) {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// -- HTTP ----------------------------------------------------------------------------------------

/** Connects to `resolveTo` whatever the name is, when one is set (no DNS for .localhost). */
function lookup(hostname, options, callback) {
  const address = resolveTo ?? undefined;
  if (address === undefined) return dnsLookup(hostname, options, callback);
  if (options?.all) return callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
  return callback(null, address, address.includes(':') ? 6 : 4);
}

function open(method, url, { body, auth = true, headers = {} } = {}) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request(
      target,
      {
        method,
        headers: {
          ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...headers,
        },
        ...(secure ? { ca, lookup } : {}),
      },
      resolve,
    );
    request.on('error', reject);
    request.setTimeout(30_000, () =>
      request.destroy(new Error(`${method} ${target.pathname} timed out`)),
    );
    request.end(payload);
  });
}

async function api(method, path, body, options) {
  const response = await open(method, `${base}${path}`, { body, ...options });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.statusCode ?? 0, json, text };
}

async function control(method, path) {
  const response = await open(method, `${controlUrl}${path}`, { auth: false });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if ((response.statusCode ?? 0) >= 300)
    throw new Error(`control ${path} answered ${response.statusCode}`);
  return JSON.parse(text);
}

/** The conversation's feed from the start, read until `done(events)` or the time is up. */
async function feed(conversationId, done, timeoutMs = 60_000) {
  const response = await open('GET', `${base}/v1/events?conversation=${conversationId}&after=0`, {
    headers: { accept: 'text/event-stream' },
  });
  if (response.statusCode !== 200)
    throw new Error(`the event stream answered ${response.statusCode}`);
  const events = [];
  let buffer = '';
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting; the feed so far: ${summary(events)}`)),
      timeoutMs,
    );
  });
  const read = (async () => {
    response.setEncoding('utf8');
    for await (const chunk of response) {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length === 0) continue;
        events.push({ event, data: JSON.parse(data.join('\n')) });
      }
      if (done(events)) return events;
    }
    return events;
  })();
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
    response.destroy();
  }
}

const summary = (events) =>
  events
    .map(
      (e) =>
        `${e.event}${e.data?.event?.type ? `:${e.data.event.type}` : ''}${e.data?.kind ? `:${e.data.kind}` : ''}${
          // Why a task failed is the first thing anyone reading a red run needs.
          e.data?.event?.type === 'task_failed'
            ? ` (${String(e.data.event.reason).slice(0, 400)})`
            : ''
        }`,
    )
    .join(', ');

// -- Helpers -------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 60_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
    }
    await sleep(everyMs);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${command} ${args.join(' ')} failed: ${String(stderr || error.message).slice(-400)}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

const operate = (...args) => run(ops, args);

const healthy = async () => {
  try {
    const { status, json } = await api('GET', '/healthz', undefined, { auth: false });
    return status === 200 && json?.status === 'ok';
  } catch {
    return false;
  }
};

async function startConversation(text) {
  const created = await api('POST', '/v1/conversations', {});
  assert(
    created.status === 201 || created.status === 200,
    `creating a conversation answered ${created.status}`,
  );
  const conversationId = created.json?.conversationId;
  assert(typeof conversationId === 'string', 'no conversation id came back');
  await say(conversationId, text);
  return conversationId;
}

async function say(conversationId, text) {
  const posted = await api('POST', `/v1/conversations/${conversationId}/messages`, { text });
  assert(
    posted.status === 202 || posted.status === 200,
    `posting a message answered ${posted.status}`,
  );
}

const taskEvents = (events, type) =>
  events.filter((e) => e.event === 'task.event' && e.data.event?.type === type);
const assistantTexts = (events) =>
  events
    .filter((e) => e.event === 'message.posted' && e.data.role === 'assistant')
    .map((e) => e.data.text);
const itemsOf = (events, kind) =>
  events.filter((e) => e.event === 'inbox.item' && e.data.kind === kind);

async function inbox(state) {
  const { status, json } = await api('GET', `/v1/inbox/items?state=${state}&limit=200`);
  assert(status === 200, `the inbox answered ${status}`);
  return json.items;
}

/**
 * What the conversation's feed shows now, read for `ms`. A conversation that has read outside
 * content (any after the first, through the invite's memory) holds each delegation for the user's
 * approval, so a step that waits for work answers the approval cards it meets: `answers` counts
 * them, and each is answered once.
 */
async function snapshot(conversationId, ms = 1_500) {
  const events = [];
  try {
    await feed(
      conversationId,
      (seen) => {
        events.splice(0, events.length, ...seen);
        return false;
      },
      ms,
    );
  } catch {
    // The time is up; what arrived is what there is.
  }
  return events;
}

const answers = { given: 0, ids: new Set() };

async function answerApprovals(conversationId, { repeatFirst = false } = {}) {
  const open = (await inbox('open')).filter(
    (item) => item.conversationId === conversationId && item.kind === 'approval',
  );
  for (const item of open) {
    assert(
      item.options.some((option) => option.id === 'approve'),
      'an approval card has no approve option',
    );
    const answer = {
      answerId: `rehearsal-${Date.now()}-${answers.given}`,
      optionId: 'approve',
      preconditionHash: item.preconditionHash,
    };
    const first = await api('POST', `/v1/inbox/items/${item.itemId}/answer`, answer);
    assert(
      first.status === 200 || first.status === 202,
      `the answer got ${first.status}: ${first.text.slice(0, 200)}`,
    );
    assert(first.json?.duplicate === false, 'the first answer was taken for a repeat');
    if (repeatFirst || answers.given === 0) {
      const again = await api('POST', `/v1/inbox/items/${item.itemId}/answer`, answer);
      assert(
        again.json?.duplicate === true,
        `the same answer sent again was not a duplicate: ${again.text.slice(0, 200)}`,
      );
    }
    answers.given += 1;
    answers.ids.add(item.itemId);
  }
  return open.length;
}

/** Waits until `condition(events)` holds, answering approval cards on the way. */
async function settle(conversationId, condition, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let events = [];
  for (;;) {
    await answerApprovals(conversationId);
    events = await snapshot(conversationId);
    if (await condition(events)) return events;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting; the feed so far: ${summary(events)}`);
    }
  }
}

// -- The steps -----------------------------------------------------------------------------------

const memory = {};

const steps = [
  [
    'health',
    async () => {
      await until('the health check', healthy, 120_000);
    },
  ],
  [
    'sign-in',
    async () => {
      const without = await api('GET', '/v1/conversations', undefined, { auth: false });
      assert(without.status === 401, `no token answered ${without.status}, not 401`);
      const wrong = await api('GET', '/v1/conversations', undefined, {
        auth: false,
        headers: { authorization: 'Bearer mki_inv_000000000000.not-the-token' },
      });
      assert(wrong.status === 401, `a wrong token answered ${wrong.status}, not 401`);
      const signedIn = await api('GET', '/v1/conversations');
      assert(
        signedIn.status === 200 && Array.isArray(signedIn.json?.conversations),
        `the invite's token answered ${signedIn.status}`,
      );
      // A new invite reads Simplified Chinese. This flow reads the server's English words, so it
      // chooses English, as a person does in Settings.
      const settings = await api('GET', '/v1/settings');
      assert(
        settings.status === 200 && settings.json?.language === 'zh-Hans',
        `the settings answered ${settings.status} ${JSON.stringify(settings.json)}`,
      );
      const chosen = await api('PATCH', '/v1/settings', { language: 'en' });
      assert(
        chosen.status === 200 && chosen.json?.language === 'en',
        `choosing English answered ${chosen.status} ${JSON.stringify(chosen.json)}`,
      );
    },
  ],
  [
    'task',
    async () => {
      await control('POST', '/mode?mode=ok');
      const id = await startConversation('rehearsal: run one task');
      const events = await settle(id, (seen) => assistantTexts(seen).length > 0);
      assert(
        taskEvents(events, 'task_succeeded').length === 1,
        `expected one finished task: ${summary(events)}`,
      );
      const [card] = itemsOf(events, 'finished');
      assert(card, `no result card: ${summary(events)}`);
      assert(/finished/u.test(card.data.ask), `the result card says: ${card.data.ask}`);
      assert(
        assistantTexts(events).some((text) => /succeeded: fake run complete/u.test(text)),
        `the closing message is ${JSON.stringify(assistantTexts(events))}`,
      );
      const open = await inbox('open');
      assert(
        open.some((item) => item.itemId === card.data.itemId),
        'the result card is not in the inbox',
      );
    },
  ],
  [
    'checkout',
    async () => {
      // The gate for the first live run: a coding task clones a repository (the real clone script),
      // and the agent account edits a file of the checkout and writes the repro.json its brief names.
      // The scripted claude does that as the account it runs as and records what each write did.
      await control('POST', '/mode?mode=code');
      const id = await startConversation('rehearsal: code a change');
      let ended = '';
      let notes = [];
      try {
        const events = await settle(
          id,
          (seen) =>
            ['task_succeeded', 'task_failed', 'task_cancelled'].some(
              (kind) => taskEvents(seen, kind).length > 0,
            ),
          240_000,
        );
        ended = summary(events);
        // What the runner said on the way and what it found wrong, for whoever reads a failure.
        notes = taskEvents(events, 'task_progress').map((e) => e.data.event.note);
        const problems = itemsOf(events, 'verification_failed').map((e) => e.data.ask);
        console.log(`  the coding task's progress: ${notes.join(' | ').slice(0, 1500)}`);
        console.log(`  not verified: ${problems.join(' | ').slice(0, 1500) || 'nothing'}`);
      } catch (error) {
        ended = String(error.message);
      }
      const { code } = await control('GET', '/state');
      assert(code, `the scripted claude never ran as a coding agent: ${ended}`);
      const wrong = ['brief', 'edit', 'git', 'repro'].filter((what) => code[what] !== 'ok');
      assert(
        wrong.length === 0,
        `the agent account could not ${wrong.map((what) => `${what} (${code[what]})`).join(', ')}: ${ended}`,
      );
      // The runner read the repro.json the agent wrote, and the reproduction test ran in its own user
      // and PID namespace and exited 0 (only then does it say it runs the task's own test command),
      // so a box that refuses those namespaces, or a repro.json that was not written, fails here.
      assert(
        notes.some((note) => note === 'running sh check.sh'),
        `the runner never got past the reproduction test to the task's own tests: ${notes.join(' | ').slice(0, 600)}; the task ended: ${ended.slice(-900)}`,
      );
      console.log(`  the coding task: ${ended.slice(0, 300)}`);
    },
  ],
  [
    'approval',
    async () => {
      await control('POST', '/mode?mode=ok');
      const before = answers.given;
      const id = await startConversation('rehearsal: approve both');
      // Two delegations in one conversation: the second always waits for the user.
      const events = await settle(
        id,
        (seen) => taskEvents(seen, 'task_succeeded').length >= 2 && assistantTexts(seen).length > 0,
      );
      assert(
        taskEvents(events, 'task_succeeded').length === 2,
        `expected exactly two tasks: ${summary(events)}`,
      );
      const given = answers.given - before;
      assert(given >= 1, 'no approval card was asked for');
      const answered = events.filter((e) => e.event === 'conductor.answered');
      assert(
        answered.length === given && answered.every((e) => e.data.optionId === 'approve'),
        `${given} answers given, ${answered.length} recorded`,
      );
      assert(
        (await inbox('open')).every(
          (entry) => entry.kind !== 'approval' || entry.conversationId !== id,
        ),
        'an approval card is still open',
      );
    },
  ],
  [
    'restart',
    async () => {
      await control('POST', '/mode?mode=waitinit');
      const id = await startConversation('rehearsal: run through a restart');
      memory.restartConversation = id;
      await settle(id, async () => (await control('GET', '/state')).waiting);
      await operate('restart');
      await until('the server to be healthy again', healthy, 120_000);
      await control('POST', '/release');
      const events = await settle(
        id,
        (seen) => taskEvents(seen, 'task_succeeded').length > 0,
        120_000,
      );
      memory.restartTask = taskEvents(events, 'task_succeeded')[0].data.event.taskId;
      assert(taskEvents(events, 'task_succeeded').length === 1, 'the task finished more than once');
      assert(
        taskEvents(events, 'task_progress').some((e) =>
          /resuming after a restart/u.test(e.data.event.note),
        ),
        `the task did not say it resumed: ${summary(events)}`,
      );
      assert(taskEvents(events, 'task_failed').length === 0, `the task failed: ${summary(events)}`);
      assert(
        itemsOf(events, 'finished').length === 1,
        `expected one result card: ${summary(events)}`,
      );
      await control('POST', '/mode?mode=ok');
    },
  ],
  [
    // The conductor's own turn was cut by the restart. It follows the resumed task and, when that
    // ends, tells the user (no model call: the task's own summary in fixed wording).
    'restart-reply',
    async () => {
      assert(memory.restartConversation, 'the restart step did not run');
      await feed(memory.restartConversation, (seen) => assistantTexts(seen).length > 0, 45_000);
    },
  ],
  [
    'backup-restore',
    async () => {
      const before = (await api('GET', '/v1/conversations')).json.conversations
        .map((c) => c.conversationId)
        .sort();
      assert(before.length > 0, 'there is nothing to back up');
      const openBefore = (await inbox('open')).map((item) => item.itemId).sort();
      await operate('stop');
      const wrote = await operate('backup');
      const name = /wrote (\S+):/u.exec(wrote)?.[1];
      assert(name, `the backup command printed: ${wrote.slice(0, 200)}`);
      assert((await operate('backups')).includes(name), 'the backup is not listed');
      await operate('start');
      await until('the server after the backup', healthy, 120_000);

      // Something happens after the backup: a conversation the restore has to take away again.
      const extra = await startConversation('rehearsal: ask after the backup');
      await feed(extra, (seen) => itemsOf(seen, 'decision').length > 0, 30_000);
      assert(
        (await api('GET', '/v1/conversations')).json.conversations.length === before.length + 1,
        'the new conversation is not there',
      );

      await operate('stop');
      await operate('restore', name);
      await operate('start');
      await until('the server after the restore', healthy, 120_000);
      const after = (await api('GET', '/v1/conversations')).json.conversations
        .map((c) => c.conversationId)
        .sort();
      assert(
        JSON.stringify(after) === JSON.stringify(before),
        `the conversations after the restore are ${after.length}, not ${before.length}`,
      );
      const openAfter = (await inbox('open')).map((item) => item.itemId).sort();
      assert(
        JSON.stringify(openAfter) === JSON.stringify(openBefore),
        'the inbox is not as it was at the backup',
      );
      // The restored server still works: a new task runs to its card.
      await control('POST', '/mode?mode=ok');
      const id = await startConversation('rehearsal: run after the restore');
      const events = await settle(id, (seen) => assistantTexts(seen).length > 0);
      assert(
        taskEvents(events, 'task_succeeded').length === 1,
        `no task after the restore: ${summary(events)}`,
      );
    },
  ],
];

// -- Run -----------------------------------------------------------------------------------------

let failed = 0;
const lines = [];
for (const [name, body] of steps) {
  const started = Date.now();
  let outcome;
  let detail = '';
  try {
    await body();
    outcome = 'pass';
  } catch (error) {
    outcome = 'fail';
    detail = error instanceof Error ? error.message : String(error);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  let line;
  if (outcome === 'pass' && xfail.has(name) && !mayPass.has(name)) {
    failed += 1;
    line = `UNEXPECTED PASS ${name} (${seconds}s): it was expected to fail; take it off MAKA_REHEARSAL_XFAIL`;
  } else if (outcome === 'pass') {
    line = `pass ${name} (${seconds}s)`;
  } else if (xfail.has(name)) {
    line = `expected failure ${name} (${seconds}s): ${detail}`;
  } else {
    failed += 1;
    line = `FAIL ${name} (${seconds}s): ${detail}`;
  }
  lines.push(line);
  console.log(line);
}
console.log(failed === 0 ? 'the flow passed' : `the flow failed: ${failed} step(s)`);
process.exit(failed === 0 ? 0 : 1);
