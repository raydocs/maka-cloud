import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkHistory } from '@maka-cloud/conductor-checks';
import { calls, type ModelRequest, type Reply, text, tool, toolResults } from './fake-model.js';
import { makeHarness } from './harness.js';

function withThinking(reply: Reply, thinking: Reply['thinking']): Reply {
  return { ...reply, thinking };
}

/** One user turn: a tool step or two with signed or redacted thinking, then an answer. */
function turnScript(turn: number) {
  const mode = turn % 3 === 0 ? 'redacted' : 'signed';
  return [
    withThinking(calls(tool('notify', { text: `working on ${turn}` })), mode),
    (request: ModelRequest) => {
      assert.equal(toolResults(request)[0]?.isError, false);
      return withThinking(calls(tool('task_status', { taskId: `missing-${turn}` })), 'signed');
    },
    withThinking(text(`Answer ${turn}.`), turn % 2 === 0 ? 'redacted' : 'signed'),
  ];
}

const conductorRequests = (requests: readonly ModelRequest[]) =>
  requests.filter((request) => request.lane === 'conductor');

test('history stays append-only across turns, tool steps, redacted thinking and a restart', async (t) => {
  const h = await makeHarness(t);
  const turns = 8;
  for (let turn = 1; turn <= turns; turn += 1) {
    h.model.script('conductor', ...turnScript(turn));
    await h.send('cnv_1', `Question ${turn}`);
    await h.conductor.idle();
    if (turn === 4) await h.restart();
  }
  assert.equal(h.outbox.messages.length, turns);
  const requests = conductorRequests(h.model.requests);
  assert.equal(requests.length, turns * 3);

  const report = checkHistory(requests, h.model.emittedThinking, {
    isRequestOnlyBlock: () => false,
  });
  assert.deepEqual(report.contentPrefix.breaks, [], 'no earlier content is rewritten');
  // With no request-only context after the history, Maka adds no message-level
  // cache marker that would move, so every request is a byte-identical prefix
  // of the next; caching rides on the top-level automatic marker.
  assert.deepEqual(report.strictPrefix.breaks, [], 'each request is a byte prefix of the next');
  for (const observation of report.breakpoints.observations) {
    assert.equal(observation.topLevel, true);
    assert.deepEqual(observation.messageBlocks, []);
  }
  assert.deepEqual(report.thinking.failures, [], 'every thinking block comes back unchanged');
  assert.equal(report.thinking.emitted, turns * 3);
  assert.deepEqual(report.systemChanges, []);
  assert.deepEqual(report.toolsChanges, []);
  // Prior-turn thinking reaches later turns (T3 path 6: the session has an llmConnectionId).
  const last = requests.at(-1) as ModelRequest;
  const firstSignature = (h.model.emittedThinking[0]?.block as { signature?: string } | undefined)
    ?.signature;
  assert.ok(firstSignature && last.raw.includes(firstSignature));
});

test('a context overflow ends the run instead of compacting the history', async (t) => {
  const h = await makeHarness(t);
  h.model.script('conductor', text('First answer.'));
  await h.send('cnv_1', 'First.');
  await h.conductor.idle();
  h.model.script('conductor', {
    error: {
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 1000001 tokens > 1000000 maximum',
        },
      },
    },
  });
  await h.send('cnv_1', 'Second.');
  await h.conductor.idle();

  const requests = conductorRequests(h.model.requests);
  assert.equal(requests.length, 2, 'no retry with a compacted history');
  assert.match(h.outbox.notices.at(-1)?.text ?? '', /too long to continue/);
  assert.equal(h.conductor.state.runsInState('failed')[0]?.endReason, 'context_full');
});

test('no orchestrator token or API key is written to disk', async (t) => {
  const tokens: string[] = [];
  const h = await makeHarness(t);
  const access = h.access.bind(h);
  h.access = (conversationId) => {
    const inner = access(conversationId);
    return {
      mcpUrl: inner.mcpUrl,
      rotateToken: () => {
        const token = inner.rotateToken();
        tokens.push(token);
        return token;
      },
    };
  };
  h.model.script('conductor', calls(tool('task_status', { taskId: 'nope' })), text('ok'));
  await h.send('cnv_1', 'Hi.');
  await h.conductor.idle();
  h.model.script('conductor', calls(tool('task_status', { taskId: 'nope' })), text('ok'));
  await h.send('cnv_1', 'Again.');
  await h.conductor.idle();
  assert.equal(tokens.length, 1, 'one token per conversation per process');
  await h.conductor.close();

  const secrets = [...tokens, 'sk-test-not-a-key'];
  const files = await readdir(join(h.dir, 'conductor'), { recursive: true, withFileTypes: true });
  let scanned = 0;
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const bytes = await readFile(join(entry.parentPath, entry.name));
    scanned += 1;
    for (const secret of secrets) {
      assert.equal(
        bytes.includes(secret),
        false,
        `${secret.slice(0, 8)}... found in ${entry.name}`,
      );
    }
  }
  assert.ok(scanned > 0);
});
