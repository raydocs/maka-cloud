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
good='{"summary":"fake run complete","done":["the brief"],"notDone":[],"confidence":"high","knownIssues":[]}'
if [ "$mode" = "leakfail" ]; then echo "key is $ANTHROPIC_API_KEY$OPENAI_API_KEY"; exit 1; fi
write_result() {
  case "$mode" in
    ok) printf '%s' "$good" > "$result" ;;
    badthengood) if [ "$resumed" = 1 ]; then printf '%s' "$good" > "$result"; else printf '%s' '{"summary":""}' > "$result"; fi ;;
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
  hang) sleep 300; exit 0 ;;
  fail) echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model said no","session_id":"'"$sid"'"}'; exit 1 ;;
esac
write_result
echo '{"type":"result","subtype":"success","is_error":false,"result":"all done","session_id":"'"$sid"'"}'
`;

export const CODEX_CLI = `#!/usr/bin/env bash
${COMMON.replaceAll('RUNNER', 'codex')}
sid="thr-1"
prev=""
for a in "$@"; do [ "$prev" = "resume" ] && sid="$a"; prev="$a"; done
echo '{"type":"thread.started","thread_id":"'"$sid"'"}'
echo '{"type":"item.started","item":{"type":"command_execution","command":"ls"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"working on it"}}'
case "$mode" in
  hang) sleep 300; exit 0 ;;
  fail) echo '{"type":"turn.failed","error":{"message":"model said no"}}'; exit 1 ;;
esac
write_result
echo '{"type":"turn.completed","usage":{}}'
`;
