/**
 * A stand-in for `claude` that speaks the stream-json protocol the Agent SDK uses, so tests can run
 * the real SDK against it. It runs for real inside the fake sandbox (node) and records how it was
 * called under `$HOME/fake-cli` (`claude-<n>.argv`, `claude-<n>.env`), like the bash stand-in does.
 *
 * What it does is set by `$HOME/fake-cli/mode`:
 *
 *   ok       report the session, write result.json, report success
 *   tools    first make the tool calls listed in `$HOME/fake-cli/tools.json` ([{id, name, input,
 *            fail?, hang?, spawn?}]): ask the SDK's hooks before each one and after it, run it
 *            (append its id to `ran.log`) unless the pre hook denied it, then behave like ok. A
 *            tool with `spawn` starts that shell command as a child in a process group and
 *            session of its own, which is not the CLI's (its pid goes to `child.pid`): a stop of
 *            the run's group does not reach it. `hang` leaves the CLI running inside the tool.
 *   spend    report token usage and a total cost, then like ok
 *   spendhang report the token usage of one model call, then run until killed
 *   fail     report an error result and exit 1
 *   exit3    exit 3 without a result
 *   noise    print lines that are not messages around the messages, then like ok
 *   hang     report progress, then run until killed
 *   slowexit like ok, but leave 600 ms after its input ended
 *   wait     like ok, but first run until `$HOME/fake-cli/go` exists (`waiting` says it is running)
 *   waitinit like wait, but only after it reported its session, so a restart can resume it
 *   code     do what a coding brief asks of an agent, as whatever account runs it: read the brief the
 *            prompt names, append a line to README.md in the workspace the prompt names, write the
 *            repro.json the brief names, run `git status` in the checkout, and record what each of those did (`ok` or the error code)
 *            in `$HOME/fake-cli/code-result.json`; then like ok
 *   leak     like ok, but its transcript also holds the run's API key and MCP token
 *   shape    like ok, but its transcript also holds a key the run was never given
 *
 * With `--session-mirror` it keeps a transcript like the real CLI: lines in
 * `$CLAUDE_CONFIG_DIR/projects/<cwd with non-letters as dashes>/<session>.jsonl`, each also sent as
 * a `transcript_mirror` frame. A session id given to `--resume` must have such a file, or it exits 1
 * ("No conversation found"); what it read is copied to `$HOME/fake-cli/resumed-<n>.jsonl`.
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
const mirrored = process.argv.slice(2).includes('--session-mirror');
const sid = resumeArg ? resumeArg.slice('--resume='.length) : mirrored ? '11111111-2222-4333-8444-555555555555' : 'sess-1';
const transcriptFile = mirrored
  ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl')
  : undefined;
if (mirrored && resumeArg) {
  let kept;
  try { kept = fs.readFileSync(transcriptFile, 'utf8'); } catch { kept = undefined; }
  if (kept === undefined) { console.error('No conversation found with session ID: ' + sid); process.exit(1); }
  fs.writeFileSync(path.join(ctl, 'resumed-' + n + '.jsonl'), kept);
}

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
function keep(type, message) {
  if (!transcriptFile) return;
  const entry = { type, uuid: require('node:crypto').randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, message };
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  fs.appendFileSync(transcriptFile, JSON.stringify(entry) + '\\n');
  send({ type: 'transcript_mirror', filePath: transcriptFile, entries: [entry] });
}
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
  // Like the real CLI, what a hook adds to the conversation is a line of its transcript.
  const added = answer && answer.hookSpecificOutput && answer.hookSpecificOutput.additionalContext;
  if (added) keep('attachment', { content: added });
  return answer;
}

async function hold() {
  fs.writeFileSync(path.join(ctl, 'waiting'), '');
  while (!fs.existsSync(path.join(ctl, 'go'))) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function run(prompt) {
  if (mode === 'wait') await hold();
  send({ type: 'system', subtype: 'init', session_id: sid });
  keep('user', { content: prompt });
  if (mode === 'leak') keep('assistant', { content: 'key ' + process.env.ANTHROPIC_API_KEY + ' token ' + process.env.MAKA_MCP_TOKEN });
  if (mode === 'shape') keep('assistant', { content: 'the user pasted sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh and ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' });
  if (mode === 'noise') { console.log('some warning text'); console.error('stderr text'); console.log('{"level":"warn"}'); }
  send({ type: 'assistant', message: { id: 'm0', content: [{ type: 'text', text: 'working on it' }] } });
  keep('assistant', { content: 'working on it' });
  if (mode === 'waitinit') await hold();
  // A later prompt (a repair or a resume) names no brief: only the first, which does, is recorded.
  if (mode === 'code' && /handoff\\/brief\\.md/.test(prompt)) {
    const seen = {};
    const attempt = (name, fn) => { try { fn(); seen[name] = 'ok'; } catch (error) { seen[name] = String(error.code || error.message); } };
    const briefPath = (prompt.match(/(\\S+\\/handoff\\/brief\\.md)/) || [])[1];
    const workspace = ((prompt.match(/Work in (\\S+)/) || [])[1] || '').replace(/\\.$/, '');
    let brief = '';
    attempt('brief', () => { brief = fs.readFileSync(briefPath, 'utf8'); });
    const reproPath = (brief.match(/\`([^\`\\n]*repro\\.json)\`/) || [])[1];
    attempt('edit', () => fs.appendFileSync(path.join(workspace, 'README.md'), 'rehearsal-fixed\\n'));
    // A real agent runs git in the checkout it was given.
    attempt('git', () => require('node:child_process').execFileSync('git', ['status', '--porcelain'], { cwd: workspace, stdio: 'pipe' }));
    attempt('repro', () => fs.writeFileSync(reproPath, JSON.stringify({ command: 'sh check.sh', files: ['check.sh'] })));
    fs.writeFileSync(path.join(ctl, 'code-result.json'), JSON.stringify(seen));
  }
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
      if (tool.spawn) {
        const child = require('node:child_process').spawn('sh', ['-c', tool.spawn], { detached: true, stdio: 'ignore' });
        child.unref();
        fs.writeFileSync(path.join(ctl, 'child.pid'), String(child.pid));
      }
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
  keep('assistant', { content: 'all done' });
  send({ type: 'result', subtype: 'success', is_error: false, result: 'all done', session_id: sid, ...(mode === 'spend' ? { total_cost_usd: 0.5 } : {}) });
  const leave = () => setTimeout(() => process.exit(0), mode === 'slowexit' ? 600 : 0);
  if (inputEnded) leave(); else onInputEnd = leave;
}
`;
