// The stand-ins the go-live rehearsal runs against: no real model, no real sandbox, no keys.
//
//   - a sandbox API (the instabox API as the server calls it); a command the server runs "in the
//     sandbox" runs for real in this process's container, with the scripted `claude` below on its PATH
//   - a model API (Anthropic Messages) that answers the conductor from a fixed script
//   - a small control API the flow uses to steer the scripted `claude` and to see what it did
//
// It runs from the server image (`node rehearsal/stubs.mjs`, the directory mounted at /app/rehearsal)
// and uses the test doubles the workspaces already ship, so the rehearsal exercises the server's own
// sandbox and model code paths. See deploy/rehearsal/README.md.

import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeInstabox } from '@maka-cloud/instabox/testing';
import {
  calls,
  lastUserText,
  startFakeModel,
  text,
  tool,
  toolResults,
} from '@maka-cloud/conductor/testing/fake-model';
import { SDK_CLI } from '../packages/cloud-runners/dist/__tests__/fake-sdk-cli.js';

const env = process.env;
const apiKey = env.INSTABOX_API_KEY ?? 'ibk_rehearsal';
const machineId = env.REHEARSAL_MACHINE_ID ?? 'm_rehearsal0000000000000000';
const home = env.REHEARSAL_HOME ?? '/tmp/sandbox-home';
const workRoot = env.REHEARSAL_WORK_ROOT ?? '/data/work';
const claudeVersion = env.REHEARSAL_CLAUDE_VERSION ?? '2.1.303';
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
writeFileSync(join(home, '.maka-cli', 'bin', 'claude'), SDK_CLI, { mode: 0o755 });
mkdirSync(join(workRoot, '.setup'), { recursive: true });
writeFileSync(join(workRoot, '.setup', `claude-${claudeVersion}.ok`), '');
mkdirSync(ctl, { recursive: true });

const sandbox = await new FakeInstabox({ host, port: ports.sandbox, apiKey, machineId, home }).start();

// What the conductor says, by what it was last told. The user's message names the scenario; the
// model never sees anything else, so the same script answers any number of rounds.
const model = await startFakeModel({ host, port: ports.model });

function lastToolName(request) {
  const assistant = [...request.body.messages].reverse().find((m) => m.role === 'assistant');
  const blocks = Array.isArray(assistant?.content) ? assistant.content : [];
  return [...blocks].reverse().find((b) => b.type === 'tool_use')?.name;
}

function conductor(request) {
  const results = toolResults(request);
  if (results.length > 0) {
    switch (lastToolName(request)) {
      case 'start_playbook':
        return calls(
          tool('delegate_task', {
            runner: 'claude-agent-sdk',
            brief: 'Write the rehearsal note.',
            title: 'Rehearsal task',
            mode: 'wait',
            timeoutMs: 120_000,
            budgetUsd: 1,
          }),
        );
      case 'delegate_task': {
        const task = results[0]?.json?.task;
        return text(`The rehearsal task ${task?.state ?? 'ended'}: ${task?.manifest?.summary ?? 'no summary'}.`);
      }
      default:
        return text('Done.');
    }
  }
  const said = lastUserText(request);
  if (said.includes('rehearsal: run')) {
    return calls(tool('start_playbook', { playbook: 'free', goal: 'Write the rehearsal note.' }));
  }
  if (said.includes('rehearsal: ask')) {
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
  const answer = /Answer to question \S+ \(.*\): (.+)\./u.exec(said);
  if (answer) return text(`Noted: ${answer[1]}.`);
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
