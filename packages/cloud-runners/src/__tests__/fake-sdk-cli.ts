/**
 * A stand-in for `claude` that speaks the stream-json protocol the Agent SDK uses, so tests can run
 * the real SDK against it. It runs for real inside the fake sandbox (node) and records how it was
 * called under `$HOME/fake-cli` (`claude-<n>.argv`, `claude-<n>.env`), like the bash stand-in does.
 *
 * What it does is set by `$HOME/fake-cli/mode`:
 *
 *   ok       report the session, write result.json, report success
 *   tools    first make the tool calls listed in `$HOME/fake-cli/tools.json` ([{id, name, input,
 *            fail?}]): ask the SDK's hooks before each one and after it, run it (append its id to
 *            `ran.log`) unless the pre hook denied it, then behave like ok
 *   spend    report token usage and a total cost, then like ok
 *   spendhang report the token usage of one model call, then run until killed
 *   fail     report an error result and exit 1
 *   exit3    exit 3 without a result
 *   noise    print lines that are not messages around the messages, then like ok
 *   hang     report progress, then run until killed
 *   slowexit like ok, but leave 600 ms after its input ended
 *
 * The hook answers it received are appended to `$HOME/fake-cli/hooks.log` as JSON lines.
 */
export const SDK_CLI = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv[2] === '--version') {
  console.log('fake 9.9.9');
  process.exit(0);
}
const ctl = path.join(process.env.HOME, 'fake-cli');
fs.mkdirSync(ctl, { recursive: true });
const n = fs.readdirSync(ctl).filter((f) => /^claude-\\d+\\.argv$/.test(f)).length + 1;
fs.writeFileSync(path.join(ctl, 'claude-' + n + '.argv'), process.argv.slice(2).map((a) => a + '\\0').join(''));
fs.writeFileSync(path.join(ctl, 'claude-' + n + '.env'), Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n') + '\\n');
fs.writeFileSync(path.join(ctl, 'pid'), String(process.pid));
const mode = (() => { try { return fs.readFileSync(path.join(ctl, 'mode'), 'utf8').trim(); } catch { return 'ok'; } })();
const resumeArg = process.argv.slice(2).find((a) => a.startsWith('--resume='));
const sid = resumeArg ? resumeArg.slice('--resume='.length) : 'sess-1';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const hooks = {};
const pending = new Map();
let requests = 0;
let inputEnded = false;
let onInputEnd = null;

function ask(request) {
  const id = 'r' + ++requests;
  send({ type: 'control_request', request_id: id, request });
  return new Promise((resolve) => pending.set(id, resolve));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') {
      for (const [event, matchers] of Object.entries(message.request.hooks || {})) hooks[event] = matchers[0].hookCallbackIds[0];
    }
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  } else if (message.type === 'control_response') {
    const resolve = pending.get(message.response.request_id);
    pending.delete(message.response.request_id);
    if (resolve) resolve(message.response.response);
  } else if (message.type === 'user') {
    const content = message.message.content;
    const text = typeof content === 'string' ? content : content.map((block) => block.text || '').join('');
    fs.appendFileSync(path.join(ctl, 'prompts.log'), JSON.stringify(text) + '\\n');
    run(text).catch((error) => { console.error('fake claude failed: ' + error.stack); process.exit(9); });
  }
});
rl.on('close', () => {
  inputEnded = true;
  if (onInputEnd) onInputEnd();
});

function toolInput(event, tool, extra) {
  return { hook_event_name: event, session_id: sid, transcript_path: '', cwd: process.cwd(), tool_name: tool.name, tool_input: tool.input, tool_use_id: tool.id, ...extra };
}

async function callHook(event, tool, extra) {
  if (!hooks[event]) return undefined;
  const answer = await ask({ subtype: 'hook_callback', callback_id: hooks[event], input: toolInput(event, tool, extra), tool_use_id: tool.id });
  fs.appendFileSync(path.join(ctl, 'hooks.log'), JSON.stringify({ event, id: tool.id, answer }) + '\\n');
  return answer;
}

async function run(prompt) {
  send({ type: 'system', subtype: 'init', session_id: sid });
  if (mode === 'noise') { console.log('some warning text'); console.error('stderr text'); console.log('{"level":"warn"}'); }
  send({ type: 'assistant', message: { id: 'm0', content: [{ type: 'text', text: 'working on it' }] } });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'exit3') process.exit(3);
  if (mode === 'fail') {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'model said no', session_id: sid });
    process.exit(1);
  }
  if (mode === 'tools') {
    const tools = JSON.parse(fs.readFileSync(path.join(ctl, 'tools.json'), 'utf8'));
    for (const tool of tools) {
      const before = await callHook('PreToolUse', tool);
      const denied = before && before.hookSpecificOutput && before.hookSpecificOutput.permissionDecision === 'deny';
      if (denied) continue;
      fs.appendFileSync(path.join(ctl, 'ran.log'), tool.id + '\\n');
      send({ type: 'assistant', message: { id: 'm-' + tool.id, content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] } });
      if (tool.hang) { setInterval(() => {}, 1000); return; }
      if (tool.fail) await callHook('PostToolUseFailure', tool, { error: 'boom' });
      else await callHook('PostToolUse', tool, { tool_response: 'fine' });
    }
  }
  if (mode === 'spend' || mode === 'spendhang') {
    send({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100000, output_tokens: 50000 }, content: [{ type: 'text', text: 'step one' }] } });
  }
  if (mode === 'spendhang') { setInterval(() => {}, 1000); return; }
  const result = (prompt.match(/\\/[^ ]*result\\.json/) || [])[0];
  if (result) {
    fs.writeFileSync(result, JSON.stringify({ summary: 'fake run complete', done: ['the brief'], notDone: [], confidence: 'high', knownIssues: [] }));
  }
  send({ type: 'result', subtype: 'success', is_error: false, result: 'all done', session_id: sid, ...(mode === 'spend' ? { total_cost_usd: 0.5 } : {}) });
  const leave = () => setTimeout(() => process.exit(0), mode === 'slowexit' ? 600 : 0);
  if (inputEnded) leave(); else onInputEnd = leave;
}
`;
