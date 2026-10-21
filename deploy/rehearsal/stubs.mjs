// The stand-ins the go-live rehearsal runs against: no real model, no real sandbox, no keys.
//
//   - a sandbox API (the instabox API as the server calls it); a command the server runs "in the
//     sandbox" runs for real in this process's container, with the scripted `claude` below on its PATH
//   - a model API (Anthropic Messages) that answers the conductor from a fixed script
//   - a small control API the flow uses to steer the scripted `claude` and to see what it did
//
// It runs from the server image (`node deploy/rehearsal/stubs.mjs`, the directory mounted at /app/deploy/rehearsal)
// and uses the test doubles the workspaces already ship, so the rehearsal exercises the server's own
// sandbox and model code paths. See deploy/rehearsal/README.md.

import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeInstabox } from '@maka-cloud/instabox/testing';
import {
  calls,
  startFakeModel,
  text,
  tool,
  toolResults,
} from '@maka-cloud/conductor/testing/fake-model';
import { CLAUDE_CLI } from '../../packages/cloud-runners/dist/__tests__/fake-cli.js';
import { claudeAdapter } from '../../packages/cloud-runners/dist/vendors.js';

const env = process.env;
const apiKey = env.INSTABOX_API_KEY ?? 'ibk_rehearsal';
const machineId = env.REHEARSAL_MACHINE_ID ?? 'm_rehearsal0000000000000000';
const home = env.REHEARSAL_HOME ?? '/tmp/sandbox-home';
const workRoot = env.REHEARSAL_WORK_ROOT ?? '/data/work';
// The version the server pins; its install check runs `claude --version` and looks for it.
const claudeVersion = env.REHEARSAL_CLAUDE_VERSION ?? claudeAdapter.defaultVersion;
const ports = {
  sandbox: Number(env.REHEARSAL_SANDBOX_PORT ?? 9100),
  model: Number(env.REHEARSAL_MODEL_PORT ?? 9101),
  control: Number(env.REHEARSAL_CONTROL_PORT ?? 9102),
};
const host = env.REHEARSAL_HOST ?? '0.0.0.0';
const ctl = join(home, 'fake-cli');

// The sandbox as a fresh machine would be after the server's one-time setup: the scripted `claude`
// installed, and the marker the server looks for so it does not run `npm install`.
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, '.maka-cli', 'bin'), { recursive: true });
writeFileSync(
  join(home, '.maka-cli', 'bin', 'claude'),
  CLAUDE_CLI.replace('fake 9.9.9', `scripted claude ${claudeVersion}`),
  { mode: 0o755 },
);
mkdirSync(join(workRoot, '.setup'), { recursive: true });
writeFileSync(join(workRoot, '.setup', `claude-${claudeVersion}.ok`), '');
mkdirSync(ctl, { recursive: true });

const sandbox = await new FakeInstabox({
  host,
  port: ports.sandbox,
  apiKey,
  machineId,
  home,
}).start();

// What the conductor says, by what it was last told. The user's message names the scenario; the
// model never sees anything else, so the same script answers any number of rounds.
const model = await startFakeModel({ host, port: ports.model });

const BRIEFS = ['Write the first rehearsal note.', 'Write the second rehearsal note.'];

const delegate = (n, actionRef) =>
  calls(
    tool('delegate_task', {
      runner: 'claude-agent-sdk',
      brief: BRIEFS[n],
      title: `Rehearsal task ${n + 1}`,
      mode: 'wait',
      timeoutMs: 120_000,
      budgetUsd: 1,
      ...(actionRef === undefined ? {} : { actionRef }),
    }),
  );

const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? [])
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('\n');

/**
 * The conductor's side of every scenario, worked out from the conversation so far, so a restart in
 * the middle and any number of rounds are answered the same way. The user's first message names
 * the scenario: `rehearsal: run` delegates one task; `rehearsal: approve` delegates two, and the
 * second needs the user's approval (a conversation that delegated once has read outside content);
 * `rehearsal: ask` asks a question of taste.
 */
function conductor(request) {
  const messages = request.body.messages;
  const scenario = /rehearsal: (\w+)/u.exec(textOf(messages[0]))?.[1];
  const uses = new Map();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) if (block.type === 'tool_use') uses.set(block.id, block);
  }
  const delegations = [...uses.values()].filter((use) => use.name === 'delegate_task');
  let succeeded = 0;
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type === 'tool_result' &&
        !block.is_error &&
        uses.get(block.tool_use_id)?.name === 'delegate_task'
      ) {
        succeeded += 1;
      }
    }
  }

  // An answer to a question comes in the user message that follows the question's own tool result.
  const [result] = toolResults(request).filter((r) => uses.get(r.toolUseId)?.name !== 'ask_user');
  if (result) {
    const used = uses.get(result.toolUseId);
    if (result.isError) {
      // A refused tool call is the first thing to look at when a scenario goes wrong.
      console.log(`conductor tool refused: ${result.text.slice(0, 300)}`);
      const held = /actionRef "(act_\w+)"/u.exec(result.text)?.[1];
      if (held && /needs_approval/u.test(result.text)) {
        return calls(
          tool('ask_user', {
            reason: 'irreversible',
            question: 'Run the rehearsal task?',
            recommended: 'approve',
            actionRef: held,
          }),
        );
      }
      return text(`The rehearsal step ${used?.name ?? ''} was refused.`);
    }
    if (used?.name === 'start_playbook') return delegate(0);
    if (used?.name === 'delegate_task') {
      if (scenario === 'approve' && succeeded === 1) return delegate(1);
      const task = result.json?.task;
      return text(
        `The rehearsal task ${task?.state ?? 'ended'}: ${task?.manifest?.summary ?? 'no summary'}.`,
      );
    }
    return text('Done.');
  }

  const said = textOf(messages.at(-1));
  const approved = /actionRef "(act_\w+)"/u.exec(said)?.[1];
  if (approved && delegations.length > 0) {
    const held = delegations.at(-1);
    return calls(tool('delegate_task', { ...held.input, actionRef: approved }));
  }
  if (/Answer to question/u.test(said)) return text('Noted.');
  if (scenario === 'ask') {
    return calls(
      tool('ask_user', {
        reason: 'taste',
        question: 'Which tone for the note?',
        options: [
          { id: 'formal', label: 'Formal' },
          { id: 'casual', label: 'Casual' },
        ],
        recommended: 'casual',
      }),
    );
  }
  if (scenario === 'run' || scenario === 'approve') {
    return calls(tool('start_playbook', { playbook: 'free', goal: 'Write the rehearsal note.' }));
  }
  return text('Rehearsal conductor: nothing scripted for this message.');
}

// A step runs once; the dispatcher puts itself back first, so any number of requests are answered.
function dispatch(lane) {
  return (request) => {
    model.script(lane, dispatch(lane));
    return lane === 'planner' ? text('1. Write the note.') : conductor(request);
  };
}
model.script('conductor', dispatch('conductor'));
model.script('planner', dispatch('planner'));

// The control API: set what the scripted `claude` does next, let a waiting one go, ask what it did.
const control = createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? '/', 'http://stubs');
  if (req.method === 'GET' && url.pathname === '/healthz') return reply(200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/state') {
    return reply(200, {
      mode: existsSync(join(ctl, 'mode')) ? readFileSync(join(ctl, 'mode'), 'utf8').trim() : 'ok',
      waiting: existsSync(join(ctl, 'waiting')),
      released: existsSync(join(ctl, 'go')),
      cliRuns: sandbox.execRequests.length,
      modelRequests: model.requests.length,
    });
  }
  if (req.method === 'POST' && url.pathname === '/mode') {
    const mode = url.searchParams.get('mode') ?? 'ok';
    if (!/^[a-z]+$/u.test(mode)) return reply(400, { error: 'bad mode' });
    writeFileSync(join(ctl, 'mode'), mode);
    rmSync(join(ctl, 'waiting'), { force: true });
    rmSync(join(ctl, 'go'), { force: true });
    return reply(200, { mode });
  }
  if (req.method === 'POST' && url.pathname === '/release') {
    writeFileSync(join(ctl, 'go'), '');
    return reply(200, { released: true });
  }
  return reply(404, { error: 'not found' });
});
await new Promise((resolve) => control.listen(ports.control, host, resolve));

console.log(
  `rehearsal stubs: sandbox :${ports.sandbox}, model :${ports.model}, control :${ports.control}`,
);
const stop = () => {
  control.close();
  void model.close();
  void sandbox.close();
  setTimeout(() => process.exit(0), 200).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
