import type { RemoteMachine } from './machine.js';
import { assertSafeId, shq } from './shell.js';

/**
 * The Agent SDK talks to the CLI over a channel the SDK trusts: whatever arrives on the CLI's
 * stdin can answer its permission questions. The CLI's tools run as the same user as the CLI, so
 * if that user is also the one who can write the channel, the agent can approve its own denied
 * tool calls. The channel is therefore kept by the sandbox user, in a private directory, and the
 * CLI runs as another user that cannot enter it.
 *
 * The box provides: `user` (an unprivileged account without sudo rights, in `group`), `group`
 * (which also holds the sandbox user), and passwordless `sudo -n` for the sandbox user (the egress
 * guard assumes the same). None of this is known to hold on a real box until a live run has
 * passed `checkAgentIsolation`; until then the SDK path stays off (it needs `agentChannel`) and a
 * box that fails the check is refused.
 */
export interface AgentChannel {
  /** The account the CLI and its tools run as. */
  user: string;
  /** A group of the sandbox user and `user`; a task's workspace belongs to it. */
  group: string;
}

const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/u;

export function assertAgentChannel(channel: AgentChannel): AgentChannel {
  for (const [kind, value] of [
    ['user', channel.user],
    ['group', channel.group],
  ] as const) {
    if (!ACCOUNT_NAME.test(value)) {
      throw new Error(`Unsafe agent channel ${kind}: ${JSON.stringify(value)}`);
    }
  }
  return channel;
}

/**
 * What runs as the agent before its command. The checkout belongs to the sandbox user, so git, run
 * by the agent in it, refuses it as owned by someone else; the exact workspace is named as a safe
 * directory through the environment (`GIT_CONFIG_COUNT`, which git reads as command-line
 * configuration: the only place `safe.directory` is honoured besides the protected files, and not
 * a file the agent can write). The workspace is `MAKA_WORKDIR` for a run, or the one beside
 * `MAKA_DIR` for an exec; nothing else is trusted.
 */
const AGENT_ENTRY = [
  'umask 002; PATH="$1"; shift',
  // `env -i` leaves no account variables: the CLI and its tools read these before the passwd entry.
  'USER=$(id -un 2>/dev/null) && LOGNAME=$USER && export USER LOGNAME',
  'SHELL=/bin/sh; [ -x /bin/bash ] && SHELL=/bin/bash; export SHELL',
  'd="${MAKA_WORKDIR:-${MAKA_DIR:+$MAKA_DIR/workspace}}"',
  'if [ -n "$d" ] && d=$(cd "$d" 2>/dev/null && pwd -P); then',
  '  n=${GIT_CONFIG_COUNT:-0}',
  '  export "GIT_CONFIG_KEY_$n=safe.directory" "GIT_CONFIG_VALUE_$n=$d" "GIT_CONFIG_COUNT=$((n + 1))"',
  'fi',
  'exec "$@"',
].join('\n');

/**
 * What the agent's process may inherit from the sandbox user's exec environment, besides the names
 * a caller passes with the command: where it runs, its locale and temporary files, where its CLI
 * keeps configuration, and the run's own token. Everything else the exec carries (what the
 * provider's exec sets, what a login file or a preamble exports) stays behind.
 */
const AGENT_ENV_BASE = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'MAKA_DIR',
  'MAKA_WORKDIR',
  'MAKA_RUN_TOKEN',
] as const;

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * `commandLine` (already quoted) run as the agent's user. The environment is built, not passed on:
 * `env -i` with `PATH` (sudo replaces it, so it is handed over explicitly) and each of the base
 * names and the caller's `names` that is set in the sandbox user's exec (`${NAME+...}` adds
 * nothing for one that is not). The shared umask lets the sandbox user read and remove what the
 * agent writes in the workspace.
 */
export function asAgent(
  commandLine: string,
  channel: AgentChannel,
  names: readonly string[] = [],
): string {
  return asAgentUser(commandLine, assertAgentChannel(channel).user, names);
}

/** `asAgent` for a caller that knows the account's name only. */
export function asAgentUser(
  commandLine: string,
  user: string,
  names: readonly string[] = [],
): string {
  assertAgentChannel({ user, group: 'x' });
  const kept = [...new Set([...AGENT_ENV_BASE, ...names])].filter((name) => name !== 'PATH');
  for (const name of kept) {
    if (!ENV_NAME.test(name)) throw new Error(`Unsafe variable name: ${name}`);
  }
  const vars = kept.map((name) => `\${${name}+"${name}=$${name}"}`).join(' ');
  return `sudo -n -u ${shq(user)} -- env -i PATH="$PATH" ${vars} sh -c ${shq(AGENT_ENTRY)} sh "$PATH" ${commandLine}`;
}

/** A whole script (any text, quoted here) run under bash as the agent's user, as `asAgent` does a command. */
export function asAgentScript(
  script: string,
  channel: AgentChannel,
  names: readonly string[] = [],
): string {
  return asAgent(`bash -c ${shq(script)}`, channel, names);
}

/**
 * A whole script run as root through the sandbox user's passwordless sudo, for what only root can
 * see of the agent's processes (their namespaces) or end. sudo drops the environment, so the
 * variables the script reads are named and handed over by `env`.
 */
export function asRootScript(script: string, envNames: readonly string[]): string {
  for (const name of envNames) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) throw new Error(`Unsafe variable name: ${name}`);
  }
  const vars = envNames.map((name) => `${name}="$${name}"`).join(' ');
  return `sudo -n env ${vars} bash -c ${shq(script)}`;
}

/**
 * Hands a task's directory to the agent's group: the workspace and `handoff` (the brief it reads,
 * the result it writes) are shared (setgid, group-writable), the task directory and the root can
 * be entered by the group but not listed, and `chan` (made by the channel scripts) stays private to
 * the sandbox user. The agent reaches `handoff` by its path, and nothing else in the task directory.
 * stdin-free; values come in as variables.
 */
export const PREPARE_AGENT_SCRIPT = `set -eu
cd "$MAKA_DIR"
root=$(dirname "$MAKA_DIR")
mkdir -p handoff
chgrp "$MAKA_AGENT_GROUP" "$root" . workspace handoff
chmod 710 "$root" .
chmod 2770 workspace
# Sticky: the agent writes its own files in handoff but cannot remove or replace the runner's.
chmod 3770 handoff
# The CLI's configuration directory (its transcripts): the agent writes it, the sandbox user puts a
# kept conversation back into it.
mkdir -p claude-config
chgrp "$MAKA_AGENT_GROUP" claude-config
chmod 2770 claude-config
`;

/**
 * Part of the probe: the files the control user's login shell reads on every exec. Needs
 * `as_agent`.
 */
export const LOGIN_FILES_PROBE = `# Every exec of the control user runs under a login shell, which reads these files first: whoever
# can write one (or the directory it is in) runs code as the control user. Each must be a regular
# file (a link is followed to its target) the control user or root owns, which the agent cannot write,
# in directories (all the way up) that it cannot write either, apart from sticky ones.
mine=$(id -u)
login_bad=""
dir_safe() {
  local owner
  owner=$(stat -c %u -- "$1" 2>/dev/null) || return 1
  [ "$owner" = "$mine" ] || [ "$owner" = 0 ] || return 1
  if as_agent test -w "$1" >/dev/null 2>&1; then
    # A sticky directory (/tmp) lets the agent add entries but not rename or remove ours.
    case "$(stat -c %a -- "$1" 2>/dev/null)" in 1???|3???|5???|7???) return 0 ;; esac
    return 1
  fi
  return 0
}
# A directory and every one above it: a writable one lets the agent swap what is below.
chain_safe() {
  local d="$1"
  while :; do
    dir_safe "$d" || return 1
    [ "$d" = / ] && return 0
    d=$(dirname -- "$d")
  done
}
login_safe() {
  local target owner
  target=$(readlink -f -- "$1" 2>/dev/null) || return 1
  [ -f "$target" ] || return 1
  owner=$(stat -c %u -- "$target" 2>/dev/null) || return 1
  [ "$owner" = "$mine" ] || [ "$owner" = 0 ] || return 1
  as_agent test -w "$target" >/dev/null 2>&1 && return 1
  chain_safe "$(dirname -- "$target")"
}
login_files=("$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile" "$HOME/.bashrc" /etc/profile /etc/bash.bashrc /etc/profile.d/*)
login_dirs=("$HOME" /etc /etc/profile.d)
# A test names its own files and directories (one per line); nothing else sets these.
if [ -n "\${MAKA_LOGIN_FILES+x}" ]; then mapfile -t login_files <<< "$MAKA_LOGIN_FILES"; mapfile -t login_dirs <<< "\${MAKA_LOGIN_DIRS:-}"; fi
unset MAKA_LOGIN_FILES MAKA_LOGIN_DIRS
for f in "\${login_files[@]}"; do
  [ -n "$f" ] || continue
  { [ -e "$f" ] || [ -L "$f" ]; } || continue
  login_safe "$f" || login_bad="$login_bad $f"
done
for d in "\${login_dirs[@]}"; do
  [ -d "$d" ] || continue
  chain_safe "$(readlink -f -- "$d")" || login_bad="$login_bad $d"
done
if [ -z "$login_bad" ]; then echo "FACT agent_login_files=none"; else echo "FACT agent_login_files=$login_bad"; fi
`;

/**
 * Whether any program the agent can run carries a file capability, or is setuid to anyone but the
 * agent or setgid to a group the agent is not in. The whole tree from `/` is walked (hidden
 * directories, files at the top and every mount below included, the task root too: a privileged
 * program there would be as dangerous as anywhere), except the kernel's own `/proc`, `/sys` and
 * `/dev`. The walk runs as root, so an unreadable directory is read, and any failure of it, of
 * `getcap`, or anything `getcap` says on stderr is `unchecked`, never `none`.
 *
 * File names are never cut back out of text where a name could fake the cut: `getcap` gets the
 * files whose path has no line break in bulk, and prints one line per file with its path first; a
 * line whose path is not one word is `found`. A file whose path has a line break is asked about
 * alone, by its own path. Every capability on a program the agent can execute is `found`, except
 * the few that the stock tools of a distribution carry under their own paths and that cannot reach
 * the firewall or the control user (raw sockets for ping, the id-mapping helpers); likewise for the
 * stock setuid tools (whose rules, like sudo's, are checked on their own), matched on the whole
 * path. Whether the agent can execute a file is asked of the agent account and must be answered: a
 * refusal of the account itself is `unchecked`, not "no". `as_agent`, `root` and `tool_bin` are
 * defined by the probe around it; `MAKA_SCAN_ROOTS` (one directory per line) replaces `/` for a
 * test, and the probe unsets it.
 */
export const FILE_CAPS_PROBE = `nl=$(printf '\\nx'); nl=\${nl%x}
# One walk of every scan root; the find tests and actions given select and write the files (with
# -fprint0 into files made beforehand, so they stay readable here). Prints failed when it did not finish.
scan() {
  roots=()
  while IFS= read -r dir; do roots+=("$dir"); done < <(if [ -n "\${MAKA_SCAN_ROOTS:-}" ]; then printf '%s\\n' "$MAKA_SCAN_ROOTS"; else echo /; fi)
  root find "\${roots[@]}" -ignore_readdir_race '(' -path /proc -o -path /sys -o -path /dev ')' -prune -o -type f '(' "$@" ')' >/dev/null || echo failed
}
# Prints yes for a path the agent can execute, nothing when it cannot, unchecked without an answer.
agent_runs() {
  can=$(as_agent sh -c '[ -x "$1" ] && echo x || echo -' sh "$1" 2>/dev/null) || can=""
  case "$can" in
    x) echo yes ;;
    -) ;;
    *) echo unchecked ;;
  esac
}
verdict() {
  if printf '%s\\n' "$2" | grep -q unchecked; then echo "FACT $1=unchecked"
  elif [ -n "$2" ]; then echo "FACT $1=found"
  else echo "FACT $1=none"; fi
}
tmp=$(mktemp -d) || tmp=""
getcap_bin=$(tool_bin getcap)
if [ -z "$tmp" ] || [ -z "$getcap_bin" ] || ! : > "$tmp/bulk" || ! : > "$tmp/odd" || ! : > "$tmp/errs"; then
  echo "FACT agent_filecaps=unchecked"
elif [ -n "$(scan -perm /111 '(' -path "*$nl*" -fprint0 "$tmp/odd" -o -fprint0 "$tmp/bulk" ')')" ]; then
  echo "FACT agent_filecaps=unchecked"
else
  rc=0
  listing=$(root xargs -0 -r "$getcap_bin" < "$tmp/bulk" 2>>"$tmp/errs") || rc=$?
  if [ "$rc" != 0 ]; then
    echo "FACT agent_filecaps=unchecked"
  else
    found=$(
      # A line break in the path would split getcap's line: each such file alone, by its own path.
      while IFS= read -r -d '' path; do
        rc=0
        one=$(root "$getcap_bin" "$path" 2>>"$tmp/errs") || rc=$?
        if [ "$rc" != 0 ]; then echo unchecked; elif [ -n "$one" ]; then agent_runs "$path"; fi
      done < "$tmp/odd"
      printf '%s\\n' "$listing" | while IFS= read -r line; do
        [ -n "$line" ] || continue
        if printf '%s\\n' "$line" | grep -Eq '^/(usr/)?s?bin/(ping6?|mtr-packet|arping|traceroute6?) (= *)?cap_net_raw[=+][eip]+$'; then continue; fi
        if printf '%s\\n' "$line" | grep -Eq '^/(usr/)?s?bin/new[ug]idmap (= *)?cap_set[ug]id[=+][eip]+$'; then continue; fi
        if printf '%s\\n' "$line" | grep -Eq '^/[^[:space:]]+ (= )?[^[:space:]]+$'; then
          agent_runs "\${line%% *}"
        else
          echo yes
        fi
      done
    )
    if [ -s "$tmp/errs" ]; then echo "FACT agent_filecaps=unchecked"; else verdict agent_filecaps "$found"; fi
  fi
fi
# setuid to another account, or setgid to a group the agent does not already have.
gids=$(as_agent id -G 2>/dev/null) || gids=""
others=()
for gid in $gids; do
  case "$gid" in *[!0-9]*) gids="" ;; *) others+=('!' -group "$gid") ;; esac
done
if [ -z "$tmp" ] || [ -z "$gids" ] || ! : > "$tmp/setid"; then
  echo "FACT agent_setid=unchecked"
elif [ -n "$(scan '(' '(' -perm -4000 ! -user "$MAKA_AGENT_USER" ')' -o '(' -perm -2000 "\${others[@]}" ')' ')' -fprint0 "$tmp/setid")" ]; then
  echo "FACT agent_setid=unchecked"
else
  found=$(while IFS= read -r -d '' path; do
    case "\${path%/*}" in
      (/bin|/sbin|/usr/bin|/usr/sbin)
        case "\${path##*/}" in
          (su|sudo|passwd|chsh|chfn|gpasswd|newgrp|mount|umount|fusermount|fusermount3|chage|expiry|crontab|wall|write|ssh-agent|unix_chkpwd|pam_extrausers_chkpwd) continue ;;
        esac ;;
      (/usr/lib/openssh|/usr/libexec/openssh) [ "\${path##*/}" != ssh-keysign ] || continue ;;
      (/usr/lib/dbus-1.0|/usr/libexec/dbus-1.0) [ "\${path##*/}" != dbus-daemon-launch-helper ] || continue ;;
    esac
    agent_runs "$path"
  done < "$tmp/setid")
  verdict agent_setid "$found"
fi
[ -z "$tmp" ] || rm -rf "$tmp"`;

/**
 * Checks, on a scratch directory laid out like a task's, that the agent's account is not the
 * sandbox user, cannot become root, cannot list, enter, read or write the channel directory or add
 * files to the task directory, can read the brief and write the result in `handoff`, and can write
 * the workspace, in ways the sandbox user can clean up. Prints `FACT <name>=<yes|no|...>`.
 */
export const AGENT_PROBE_SCRIPT = `set -u
umask 077
mkdir -p "$MAKA_ROOT"
scratch=$(mktemp -d "$MAKA_ROOT/.probe.XXXXXX") || { echo "FACT scratch=no"; exit 0; }
made=""
tool_bin() { PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin" command -v "$1" 2>/dev/null || true; }
# Whatever the probe made is taken away again on every way out, a failed probe included.
cleanup() {
  rm -rf "$scratch"
  for entry in $made; do
    bin=\${entry%%:*}; name=\${entry#*:}
    "$bin" -w -X "$name" >/dev/null 2>&1 || sudo -n "$bin" -w -X "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
mkdir -m 700 "$scratch/chan"
: > "$scratch/chan/probe.in"
mkdir "$scratch/workspace" "$scratch/handoff"
: > "$scratch/handoff/brief.md"
chgrp "$MAKA_AGENT_GROUP" "$MAKA_ROOT" "$scratch" "$scratch/workspace" "$scratch/handoff" "$scratch/handoff/brief.md" 2>/dev/null || echo "FACT group=no"
chmod 710 "$MAKA_ROOT" "$scratch"
chmod 2770 "$scratch/workspace"
chmod 3770 "$scratch/handoff"
chmod 640 "$scratch/handoff/brief.md"
as_agent() { sudo -n -u "$MAKA_AGENT_USER" --preserve-env -- "$@"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
echo "FACT dev_uid=$(id -u)"
echo "FACT agent_uid=$(as_agent id -u 2>/dev/null || echo none)"
echo "FACT agent_sudo=$(yes_no as_agent sudo -n true)"
# A sudo rule for one command (iptables) still lets \`sudo -n true\` fail; \`-l\` says whether the account may run anything.
echo "FACT agent_sudo_list=$(yes_no as_agent sudo -n -l)"
# The sudo policy, asked from the trusted side: what the rules say the account may run, not what a
# few commands it tries happen to do (a rule for one binary, or listpw=always, fails \`sudo -n true\`
# and \`sudo -n -l\` alike). Only the sudo answer "not allowed" is a pass; a query that fails is not.
root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
rc=0
policy=$(root sudo -l -U "$MAKA_AGENT_USER" 2>&1) || rc=$?
if printf '%s' "$policy" | grep -Eq 'is not allowed to run sudo'; then
  echo "FACT agent_sudo_policy=none"
elif [ "$rc" = 0 ]; then
  echo "FACT agent_sudo_policy=granted"
else
  echo "FACT agent_sudo_policy=unknown"
fi
# Privileges the process itself holds, and the files that could hand it some.
caps=$(as_agent sh -c 'grep -E "^Cap(Prm|Eff|Amb):" /proc/self/status' 2>/dev/null || true)
if [ -z "$caps" ]; then echo "FACT agent_caps=unknown"
elif printf '%s\n' "$caps" | awk '{ if ($2 !~ /^0+$/) bad = 1 } END { exit bad ? 0 : 1 }'; then echo "FACT agent_caps=held"
else echo "FACT agent_caps=none"; fi
unset MAKA_SCAN_ROOTS
${FILE_CAPS_PROBE}
# Groups that are root by another name, and the sockets that run containers for whoever may write them.
groups=$(as_agent id -Gn 2>/dev/null || true)
if [ -z "$groups" ]; then echo "FACT agent_groups=unknown"; else echo "FACT agent_groups=$groups"; fi
open_sockets=""
for sock in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/podman/podman.sock /var/lib/lxd/unix.socket /var/snap/lxd/common/lxd/unix.socket /run/libvirt/libvirt-sock; do
  if [ -S "$sock" ] && as_agent test -w "$sock" >/dev/null 2>&1; then open_sockets="$open_sockets $sock"; fi
done
if [ -z "$open_sockets" ]; then echo "FACT agent_sockets=none"; else echo "FACT agent_sockets=$open_sockets"; fi
# What the control user runs or keeps its tools in must not be writable by the agent.
writable=""
for path in "$HOME" "$HOME/.maka-cli" "$HOME/.maka-cli/bin" "$MAKA_ROOT" "$(dirname "$MAKA_ROOT")"; do
  if [ -e "$path" ] && as_agent test -w "$path" >/dev/null 2>&1; then writable="$writable $path"; fi
done
if [ -z "$writable" ]; then echo "FACT agent_control_write=none"; else echo "FACT agent_control_write=$writable"; fi
${LOGIN_FILES_PROBE}
# The firewall itself: can this account change network policy (a capability, a setuid tool)? A
# scratch chain is made and taken away again (also on the way out, if this stops half way).
chain="MAKA_PROBE_$$"
for tool in iptables ip6tables; do
  bin=$(tool_bin "$tool")
  if [ -n "$bin" ]; then
    if as_agent "$bin" -w -N "$chain" >/dev/null 2>&1; then
      made="$made $bin:$chain"
      echo "FACT agent_$tool=yes"
    else
      echo "FACT agent_$tool=no"
    fi
  else
    echo "FACT agent_$tool=absent"
  fi
done
echo "FACT chan_enter=$(yes_no as_agent sh -c 'cd "$1"' sh "$scratch/chan")"
echo "FACT chan_list=$(yes_no as_agent ls "$scratch/chan")"
echo "FACT chan_read=$(yes_no as_agent cat "$scratch/chan/probe.in")"
echo "FACT chan_write=$(yes_no as_agent sh -c ': >> "$1/probe.in"' sh "$scratch/chan")"
echo "FACT chan_create=$(yes_no as_agent sh -c ': > "$1/forged"' sh "$scratch/chan")"
echo "FACT task_list=$(yes_no as_agent ls "$scratch")"
echo "FACT brief_read=$(yes_no as_agent cat "$scratch/handoff/brief.md")"
echo "FACT result_write=$(yes_no as_agent sh -c 'umask 002; : > "$1/result.json"' sh "$scratch/handoff")"
echo "FACT result_cleanup=$(yes_no rm "$scratch/handoff/result.json")"
echo "FACT task_file_write=$(yes_no as_agent sh -c ': > "$1/brief.md.forged"' sh "$scratch")"
echo "FACT workspace_write=$(yes_no as_agent sh -c 'umask 002; : > "$1/f"' sh "$scratch/workspace")"
echo "FACT workspace_cleanup=$(yes_no rm "$scratch/workspace/f")"
`;

const POWERFUL_GROUPS = new Set([
  'root',
  'sudo',
  'wheel',
  'admin',
  'docker',
  'lxd',
  'lxc',
  'libvirt',
  'kvm',
  'disk',
  'shadow',
  'adm',
  'systemd-journal',
  'podman',
]);

/** What the probe found, and what is wrong with it; empty when the box keeps the channel private. */
export function agentIsolationProblems(output: string): string[] {
  const facts = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^FACT ([a-z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match) facts.set(match[1] as string, match[2] as string);
  }
  const problems: string[] = [];
  const devUid = facts.get('dev_uid');
  const agentUid = facts.get('agent_uid');
  if (facts.get('scratch') === 'no') return ['a scratch directory could not be made'];
  if (facts.get('group') === 'no') problems.push('the sandbox user cannot give files to the group');
  if (agentUid === undefined || !/^\d+$/u.test(agentUid)) {
    problems.push('the agent account cannot be used through sudo -n');
  } else if (agentUid === devUid) {
    problems.push('the agent account is the sandbox user');
  }
  const mustBe = (fact: string, expected: string, problem: string): void => {
    if (facts.get(fact) !== expected) problems.push(problem);
  };
  mustBe('agent_sudo', 'no', 'the agent account can use sudo');
  mustBe('agent_sudo_list', 'no', 'the agent account may run commands through sudo');
  mustBe(
    'agent_sudo_policy',
    'none',
    'the sudo rules give the agent account commands to run (or could not be read)',
  );
  mustBe(
    'agent_caps',
    'none',
    'the agent account holds Linux capabilities (or they could not be read)',
  );
  mustBe(
    'agent_filecaps',
    'none',
    'a program carries a capability the agent could use (or file capabilities could not be listed)',
  );
  mustBe(
    'agent_login_files',
    'none',
    'the agent account can change a file or directory that the login shell of the control user reads (or one of them is a link to nowhere, or could not be checked)',
  );
  mustBe(
    'agent_setid',
    'none',
    'a program is setuid or setgid to another account and the agent could run it (or they could not be listed)',
  );
  mustBe('agent_sockets', 'none', 'the agent account can reach a container or VM socket');
  mustBe(
    'agent_control_write',
    'none',
    'the agent account can write where the control user keeps its tools or the tasks',
  );
  const groups = facts.get('agent_groups');
  if (groups === undefined || groups === 'unknown') {
    problems.push('the groups of the agent account could not be read');
  } else if (groups.split(/\s+/u).some((name) => POWERFUL_GROUPS.has(name))) {
    problems.push('the agent account is in a group that is as good as root');
  }
  // Absent is fine (no such tool, no such rules); an answer that is missing or "yes" is not.
  for (const tool of ['iptables', 'ip6tables']) {
    if (facts.get(`agent_${tool}`) !== 'no' && facts.get(`agent_${tool}`) !== 'absent') {
      problems.push(`the agent account can change the firewall (${tool})`);
    }
  }
  mustBe('chan_enter', 'no', 'the agent account can enter the channel directory');
  mustBe('chan_list', 'no', 'the agent account can list the channel directory');
  mustBe('chan_read', 'no', 'the agent account can read the channel');
  mustBe('chan_write', 'no', 'the agent account can write the channel');
  mustBe('chan_create', 'no', 'the agent account can create files in the channel directory');
  mustBe('task_list', 'no', 'the agent account can list a task directory');
  mustBe('brief_read', 'yes', 'the agent account cannot read the brief');
  mustBe('result_write', 'yes', 'the agent account cannot write the result');
  mustBe('result_cleanup', 'yes', 'the sandbox user cannot remove the result the agent wrote');
  mustBe('task_file_write', 'no', 'the agent account can create files in the task directory');
  mustBe('workspace_write', 'yes', 'the agent account cannot write a workspace');
  mustBe('workspace_cleanup', 'yes', 'the sandbox user cannot remove what the agent wrote');
  return problems;
}

/** Runs the probe once on a machine. Throws with every finding when the box does not keep the channel private. */
export async function checkAgentIsolation(
  machine: RemoteMachine,
  channel: AgentChannel,
  signal?: AbortSignal,
): Promise<void> {
  assertAgentChannel(channel);
  const out = await machine.execOk(AGENT_PROBE_SCRIPT, {
    envs: {
      MAKA_ROOT: machine.root,
      MAKA_AGENT_USER: channel.user,
      MAKA_AGENT_GROUP: assertSafeId('group', channel.group),
    },
    timeoutSeconds: 60,
    ...(signal ? { signal } : {}),
  });
  const problems = agentIsolationProblems(out);
  if (problems.length > 0) {
    throw new Error(`the sandbox does not keep the agent channel private: ${problems.join('; ')}`);
  }
}
