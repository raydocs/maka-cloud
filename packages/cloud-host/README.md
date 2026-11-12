# @maka-cloud/host

Runs the whole cloud stack in one process: the public API and orchestrator
(`@maka-cloud/server`), the conductor (`@maka-cloud/conductor`) with the research, coding and free
playbooks, the sandbox runner fleet (`@maka-cloud/runners`) and the coding runner.

```sh
maka-cloud check   # read the configuration from the environment and print it, without secrets
maka-cloud start   # serve until SIGINT or SIGTERM
```

Configuration comes from the environment only; `maka-cloud` with no command lists the variables.
The required ones are `MAKA_CLOUD_DATA_DIR`, `ANTHROPIC_API_KEY`, `INSTABOX_API_KEY` and
`MAKA_CLOUD_SANDBOXES`. Models are reached with API keys only.

Every invite runs its tasks on a sandbox machine of its own, so one invite's tasks cannot read
another's files, environment or tokens. `MAKA_CLOUD_SANDBOXES` is a JSON object from invite id to
machine, for example `{"inv_0123456789ab": "m_alice"}`; no machine can serve two invites. An invite
with no entry, and a task whose conversation has no owner (a pre-v5 one nobody adopted), cannot
start tasks. After creating an invite and its machine, add the entry and restart. The old
`INSTABOX_MACHINE_ID` is refused, since it would put every invite on one machine.

Starting runs nothing by itself: no model request is made and no task starts until a user posts a
message. At start the server stops sandbox runs whose task its log does not know, and the
conductor retries cancels that a shutdown left undone. A task whose run could not be stopped
(an unreachable sandbox, say) ends but keeps owing the stop: the orchestrator retries it until
the sandbox confirms, across restarts, and the conductor holds the task's reservation until then.

Users need an invite: `cloud-server invite create --invites $MAKA_CLOUD_DATA_DIR/invites.db --label <text>`.

The sandbox reaches the orchestrator's MCP endpoint at `MAKA_CLOUD_MCP_PUBLIC_URL`. Expose
`MAKA_CLOUD_MCP_HOST:MAKA_CLOUD_MCP_PORT` there (for example behind a TLS proxy); without it, tasks
get the local URL.

The fleet gets the bundled `cite-check` tool and `sameConversationInputPolicy`, so a task can take
files of a finished task of the same conversation. Runner sessions are kept in
`runner-sessions.json` under the data directory, so a task can resume after a restart.

Coding tasks go to the `coding` runner, which drives the fleet's Claude and Codex runners. A
verified change becomes a pull request only through `open_pull_request`, which the conductor holds
until the user approves it. The GitHub token comes from `MAKA_GITHUB_TOKEN` only (a fine-grained
`github_pat_` token), is read when a pull request is opened and never enters a sandbox. Deliveries
are kept in `coding-deliveries.json` under the data directory.
