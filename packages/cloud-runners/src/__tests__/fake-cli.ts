/**
 * Stand-ins for the vendor CLIs. They run for real inside the fake sandbox (bash), record how they
 * were called under `$HOME/fake-cli`, and behave as `$HOME/fake-cli/mode` says:
 *
 *   ok            write a valid result.json, report success
 *   noresult      report success without writing result.json
 *   badthengood   write an invalid result.json, a valid one when resumed
 *   fail          report an error and exit 1
 *   hang          report progress, then run until killed
 *   symlink       make result.json a symlink to $HOME/fake-cli/secret.txt
 *   big           write a result.json larger than 1 MiB
 *   leakfail      print the API key it was given, then exit 1
 *   leakout       print the API key and MCP token to stdout and stderr, then behave like ok
 *   flood         print 3 MB without a newline first, then behave like ok
 *   floodfail     print 3 MB without a newline, then exit 1
 *   longfail      print a 100 kB line, then exit 1
 *   todos         report a todo list, a page fetched, one that failed and one that is still waiting; then ok
 *   spend         report token usage for each model call and, for claude, the total cost; then ok
 *   spendhang     report the same usage, then run until killed
 *   custom        write `$HOME/fake-cli/manifest.json` as result.json (`manifest2.json` when resumed, if there is one)
 *   wait          like ok, but first run until `$HOME/fake-cli/go` exists (`waiting` says it is running)
 *   leakedge-plain  print the API key right where a 300-character quote would cut it, then exit 1
 *   leakedge-guard  the same, after a MAKA_GUARD: prefix
 *   leakedge-json   the same where a 200-character note or result text would cut it, as events
 *
 * When `$HOME/fake-cli/orphan` exists, the CLI also leaves a child behind in its process group
 * that ignores TERM; its pid is appended to `$HOME/fake-cli/children`.
 */

const COMMON = String.raw`
if [ "$1" = "--version" ]; then echo "fake 9.9.9"; exit 0; fi
ctl="$HOME/fake-cli"
mkdir -p "$ctl"
n=$(ls "$ctl"/RUNNER-*.argv 2>/dev/null | wc -l); n=$((n + 1))
printf '%s\0' "$@" > "$ctl/RUNNER-$n.argv"
env > "$ctl/RUNNER-$n.env"
echo $$ > "$ctl/pid"
mode=$(cat "$ctl/mode" 2>/dev/null || echo ok)
prompt=""
for a in "$@"; do case "$a" in *result.json*) prompt="$a" ;; esac; done
result=$(printf '%s' "$prompt" | grep -o '/[^ ]*result\.json' | head -1)
resumed=0
for a in "$@"; do [ "$a" = "--resume" ] || [ "$a" = "resume" ] && resumed=1; done
cost=""
[ "$mode" = "spend" ] && cost=',"total_cost_usd":0.5'
good='{"summary":"fake run complete","done":["the brief"],"notDone":[],"confidence":"high","knownIssues":[]}'
if [ "$mode" = "leakfail" ]; then echo "key is $ANTHROPIC_API_KEY$OPENAI_API_KEY"; exit 1; fi
pad=$(head -c 285 /dev/zero | tr '\0' x)
jpad=$(head -c 190 /dev/zero | tr '\0' x)
if [ "$mode" = "leakedge-plain" ]; then echo "$pad$ANTHROPIC_API_KEY$OPENAI_API_KEY"; exit 1; fi
if [ "$mode" = "leakedge-guard" ]; then echo "MAKA_GUARD: $pad$ANTHROPIC_API_KEY$OPENAI_API_KEY"; exit 1; fi
if [ -e "$ctl/orphan" ]; then
  bash -c 'trap "" TERM; while :; do sleep 1; done' > /dev/null 2>&1 &
  echo $! >> "$ctl/children"
fi
if [ "$mode" = "leakout" ]; then
  echo "key=$ANTHROPIC_API_KEY$OPENAI_API_KEY token=$MAKA_MCP_TOKEN"
  echo "stderr key=$ANTHROPIC_API_KEY$OPENAI_API_KEY token=$MAKA_MCP_TOKEN" >&2
fi
if [ "$mode" = "wait" ]; then : > "$ctl/waiting"; while [ ! -e "$ctl/go" ]; do sleep 0.05; done; fi
if [ "$mode" = "flood" ]; then head -c 3000000 /dev/zero | tr '\0' x; echo; fi
if [ "$mode" = "floodfail" ]; then head -c 3000000 /dev/zero | tr '\0' x; exit 1; fi
if [ "$mode" = "longfail" ]; then head -c 100000 /dev/zero | tr '\0' y; echo; exit 1; fi
write_result() {
  case "$mode" in
    ok|leakout|flood|spend|wait|todos) printf '%s' "$good" > "$result" ;;
    badthengood) if [ "$resumed" = 1 ]; then printf '%s' "$good" > "$result"; else printf '%s' '{"summary":""}' > "$result"; fi ;;
    custom) if [ "$resumed" = 1 ] && [ -e "$ctl/manifest2.json" ]; then cp "$ctl/manifest2.json" "$result"; else cp "$ctl/manifest.json" "$result"; fi ;;
    symlink) rm -f "$result"; ln -s "$ctl/secret.txt" "$result" ;;
    big) head -c 1100000 /dev/zero | tr '\0' 'a' > "$result" ;;
  esac
}
`;

export const CLAUDE_CLI = `#!/usr/bin/env bash
${COMMON.replaceAll('RUNNER', 'claude')}
sid="sess-1"
prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && sid="$a"; prev="$a"; done
echo '{"type":"system","subtype":"init","session_id":"'"$sid"'"}'
echo 'not json, some stderr-ish noise'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"},{"type":"tool_use","name":"Bash","input":{}}]}}'
case "$mode" in
  todos)
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"content":"Read the docs","status":"completed","activeForm":"Reading the docs"},{"content":"Fix the login loop","status":"in_progress","activeForm":"Fixing the login loop"},{"content":"Run the tests","status":"pending","activeForm":"Running the tests"}]}}]}}'
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"f1","name":"WebFetch","input":{"url":"https://docs.example/login"}},{"type":"tool_use","id":"f2","name":"WebFetch","input":{"url":"https://gone.example/page"}},{"type":"tool_use","id":"f3","name":"WebFetch","input":{"url":"https://slow.example/page"}}]}}'
    echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"f1","content":"page text"},{"type":"tool_result","tool_use_id":"f2","is_error":true,"content":"404"}]}}'
    ;;
  spend|spendhang)
    # One model call can come as several events with the same message id and usage.
    echo '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":100000,"output_tokens":50000},"content":[{"type":"text","text":"step one"}]}}'
    echo '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":100000,"output_tokens":50000},"content":[{"type":"tool_use","name":"Bash","input":{}}]}}'
    echo '{"type":"assistant","message":{"id":"m2","usage":{"input_tokens":200000,"output_tokens":0},"content":[{"type":"text","text":"step two"}]}}'
    ;;
esac
case "$mode" in
  hang|spendhang) sleep 300; exit 0 ;;
  leakedge-json)
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$jpad$ANTHROPIC_API_KEY"'"}]}}'
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"'"$jpad$ANTHROPIC_API_KEY"'","session_id":"'"$sid"'"}'
    exit 1 ;;
  fail) echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model said no","session_id":"'"$sid"'"}'; exit 1 ;;
esac
write_result
echo '{"type":"result","subtype":"success","is_error":false,"result":"all done","session_id":"'"$sid"'"'"$cost"'}'
`;

export const CODEX_CLI = `#!/usr/bin/env bash
${COMMON.replaceAll('RUNNER', 'codex')}
sid="thr-1"
prev=""
for a in "$@"; do [ "$prev" = "resume" ] && sid="$a"; prev="$a"; done
echo '{"type":"thread.started","thread_id":"'"$sid"'"}'
echo '{"type":"item.started","item":{"type":"command_execution","command":"ls"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"working on it"}}'
usage='{}'
if [ "$mode" = "todos" ]; then
  echo '{"type":"item.started","item":{"type":"todo_list","items":[{"text":"Read the docs","completed":true},{"text":"Fix the login loop","completed":false},{"text":"Run the tests","completed":false}]}}'
  echo '{"type":"item.updated","item":{"type":"todo_list","items":[{"text":"Read the docs","completed":true},{"text":"Fix the login loop","completed":true},{"text":"Run the tests","completed":false}]}}'
fi
case "$mode" in
  spend|spendhang) usage='{"input_tokens":300000,"cached_input_tokens":100000,"output_tokens":50000}' ;;
esac
case "$mode" in
  hang) sleep 300; exit 0 ;;
  spendhang) echo '{"type":"turn.completed","usage":'"$usage"'}'; sleep 300; exit 0 ;;
  leakedge-json)
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"'"$jpad$OPENAI_API_KEY"'"}}'
    echo '{"type":"turn.failed","error":{"message":"'"$jpad$OPENAI_API_KEY"'"}}'
    exit 1 ;;
  fail) echo '{"type":"turn.failed","error":{"message":"model said no"}}'; exit 1 ;;
esac
write_result
echo '{"type":"turn.completed","usage":'"$usage"'}'
`;
