# PRs merged without an outside review

Codex, the outside reviewer, hit its usage limit at 17:25Z on 2026-10-21. Its first refused review was on #229 at 17:25:13Z, and every Codex review after that failed with "You have reached your Codex usage limits for code reviews." Each PR below merged after that without a completed Codex review. Recheck them once Codex is back by commenting `@codex review` on each PR, or hold any further change to the same code until then.

Where a different outside reviewer ran instead, the line says so. Such a PR still needs the Codex recheck when Codex returns.

## How this was checked

- The list is every PR merged since 17:00Z, from a GitHub search: 79 PRs, the earliest at 17:27:07Z. #305 is included (merged 21:49:56Z, docs only).
- Codex status was read in full for #229, #301, #302 and #306: each shows the failed Codex summary and the usage-limit notice. The other PRs have exactly two comments, both from the Codex bot (the same summary and notice pattern), and were not opened one by one.
- Outside Claude reviews on GitHub: #306 (independent review, 22:15Z). #280 is recorded by the coordinator as having an outside Claude review.
- #301 is still open, so it is not listed. The coordinator records an outside Claude review for it; it will be added when it merges.

## Merged after the limit (chronological, 2026-10-21, UTC)

- #227 17:27 fix(duties): a retry that ends without running settles the failure it was retrying
- #228 17:29 fix(cloud-host): withModes keeps the runner's steerable flag, so owner messages reach Claude runs
- #231 17:32 boxes: setup snapshots are named by long digests and checked by owner
- #230 17:34 fix(cloud-instabox): the egress guard reads its rules back by meaning; real iptables test (recheck12 item 1)
- #233 17:35 fix(cloud-runners): a steering message is read when the kept transcript shows it, and never given twice across a restart
- #232 17:39 fix(cloud-playbooks): a coding change is never delivered unreviewed, with or without modes (recheck11 item 7, recheck9 item 2)
- #235 17:40 boxes: each acquire holds its own claim, and a woken box stays waking until its resume ends
- #234 17:42 fix(gateway,host): refuse unstamped bookings on a fenced invite; smoke stops when it cannot cancel the earlier run
- #236 17:44 fix(cloud-runners): a box woken between the guard and the launch is guarded again before the task's code runs (recheck12 item 4)
- #240 17:46 fix(cloud-playbooks): the orchestrator's turn limit is one allowance for the implementer, review, fix and retries (recheck10 item 6)
- #239 17:47 boxes: a failed sleep acts on the box only while no one has taken it
- #242 17:49 fix(cloud-playbooks): verification.json and the PR body describe the delivered change after a fix (recheck9 item 6)
- #244 17:51 fix(server,conductor,playbooks): manifests, assistant messages, approval cards and PR descriptions carry no key (recheck11 item 4)
- #229 17:53 fix(deploy): the rehearsal runs in its own Compose project, volumes and image tags
- #245 17:53 boxes: a create that instabox accepted but could not be read back keeps its slot as lost
- #243 17:56 fix(cloud-conductor): a user's stop cancels the tasks a restart kept, though no run is open (recheck9 item 5)
- #246 17:56 fix(cloud-conductor): whether a run called a tool is kept per run, so a later overloaded turn is not retried (recheck9 item 3)
- #247 17:59 fix(cloud-instabox): the egress guard compares the whole ordered chain, name servers included, and refuses anything extra or qualified (recheck12 item 7, recheck13 item 1)
- #248 18:00 boxes: a snapshot with no ownership description is not ours
- #250 18:06 feat(cloud-instabox): the egress guard lets the box reach itself on loopback, and checks that exact rule (owner decision)
- #251 18:06 boxes: a broken box left by a restore is dated, so cleanup retries and deletes it
- #249 18:08 feat(cloud-playbooks): a change that could not be reviewed, or has a P1 left, is kept for the owner to look at (T25, owner decision 4)
- #252 18:09 fix(cloud-conductor, cloud-playbooks): the deep research cross-runner check reads who ran what, not file names (recheck10 item 9)
- #253 18:13 boxes: each create attempt has its own idempotency key
- #254 18:15 fix(cloud-gateway): the gateway's own keys are scrubbed from vendor errors at any length, and in their URL-encoded and JSON-escaped forms (recheck13 item 3)
- #255 18:20 boxes: giving up a stale claim keeps a sleeping box asleep
- #256 18:22 fix(cloud-runners): an install's output is scrubbed before it is cut, so the body of a long private key does not reach the error (recheck13 item 5)
- #257 18:23 feat(cloud-duties): proposed cards - kinds, store and noise limits (T30 piece 1)
- #258 18:26 boxes: a cached box is checked again before hand-out and sleep, and refused instead of relabelled
- #259 18:29 feat(cloud-duties): read-only GitHub signals and the cards they make (T30 piece 2)
- #260 18:30 fix(cloud-orchestrator,cloud-host): a credential written as data is scrubbed when serialised again, and the logger keeps the link between scheme or header name and value (recheck11 item 5)
- #241 18:32 Build the images from an allowlisted Docker context
- #261 18:33 boxes: the builder box is deleted to the end, and a leftover one is removed before the next build
- #237 18:35 fix(cloud-server): the run timeline is bounded in pages, series, log read and answer size
- #263 18:37 fix(cloud-host): a service key too short for the scrubber to know is refused at start (recheck11 item 6)
- #262 18:38 feat(cloud-duties): a scan turns a project's signals into cards (T30 piece 3)
- #264 18:40 boxes: repository scripts run as the unprivileged agent account, never as the sandbox user
- #266 18:48 feat(cloud-supervisor, cloud-server): a proposed card is an inbox item with Do it and Not now (T30 piece 4)
- #265 18:53 boxes: a setup snapshot is cleaned first and refused if a credential is left
- #238 18:53 plans: a sealed per-invite vault for the Claude setup token (T27 PR 9a)
- #267 18:55 feat(cloud-host): a tap on a card starts one task (T30 piece 5)
- #269 19:01 feat(cloud-duties, cloud-host): settle card tasks and show the typical cost (T30 piece 6)
- #271 19:07 feat(cloud-host): scan projects for cards daily and after own tasks, behind MAKA_CLOUD_CARDS (T30 piece 7)
- #272 19:13 feat(cloud-server, cloud-supervisor, cloud-host): suggestion switches and the turn-off offer (T30 piece 8)
- #273 19:52 feat(cloud-web, cloud-client): proposed cards on Home and switches on Projects (T30 piece 9)
- #268 20:00 Run every CLI as the agent account, Codex included
- #270 20:03 host: run tasks on the box pool when MAKA_CLOUD_BOXES=1 (off by default)
- #274 20:08 docs: T30 proposed cards status and what is still open (piece 10)
- #275 20:09 Task code never starts as the sandbox user; the box check tries the firewall as the agent account
- #276 20:16 Give the agent account a handoff directory for the brief and the result
- #277 20:35 A transcript append says which lines it committed, and only those are acknowledged
- #282 20:36 fix(cloud-playbooks): keep the verified change before its review starts (recheck16 item 2, recheck14 item 3)
- #283 20:37 Launch notes: the box pool, proposed cards and the plan vault stay off
- #284 20:42 fix(cloud-conductor): a user's stop cancels the kept tasks even when a new run is open (recheck15 item 5)
- #285 20:42 fix(cloud-conductor): runs from before tool history was recorded count as having called a tool (recheck15 item 6)
- #281 20:45 A guard that fails after a wake is final, and repo code is guarded after any wake
- #286 20:45 fix(cloud-playbooks): the review keeps its share of the turn allowance (recheck14 item 6)
- #278 20:47 boxes: a create whose wait timed out keeps its slot as lost
- #287 20:47 Timeline: fold cost reports in constant time and cap the answer in bytes
- #288 20:54 A retry after an interrupted guard rebuild keeps the live hook
- #289 20:57 Every untrusted exec runs as the agent account: repo tests, CLI gate and check, brief write
- #291 21:05 The kept conversation holds no key shapes: transcript lines are scrubbed like text a person reads
- #194 21:15 feat(cloud-mobile): the iOS and Android app with sign-in, Home and Chat, and its CI (T29 PR 3)
- #290 21:16 Launch takes a program and arguments and builds the agent boundary itself; the box check reads the sudo policy and more
- #293 21:18 Launch notes: the rehearsal's task steps are unverified, and tasks need the agent account
- #292 21:19 fix(cloud-playbooks): a kept change is never pushed unless the owner explicitly asks for it unreviewed (recheck B1)
- #295 21:19 fix(cloud-conductor): a v10 step counts open runs at v8/v9 as having called a tool (recheck B4)
- #296 21:19 fix(cloud-playbooks): keep the fixed change before its second review (recheck B3)
- #294 21:20 Steering delivery is proved by a host-side receipt, and a resumed turn starts from the server's transcript
- #279 21:31 Keep nested .git directories out of the Docker build context
- #297 21:31 Egress: a machine nobody has checked is not trusted
- #300 21:32 Recovery spend is keyed by attempt, so a re-read or a restart never counts spend twice
- #305 21:49 docs: post-launch backlog for findings about what is off at launch
- #303 21:55 A conversation that could not be kept stops the turn
- #280 22:06 Smoke: clean up an earlier run's tasks every run, and count only a confirmed stop (outside Claude review, per coordinator)
- #308 22:15 fix(cloud-playbooks): an open_pull_request approval covers the exact change it named (recheck B1)
- #306 22:15 fix(cloud-playbooks): a failed second review keeps the fixed change (recheck B2) (outside Claude review, comment 22:15Z)
- #307 22:21 A stop from an earlier attempt no longer reaches the run or the model access of a later one
- #302 22:27 Secrets: one detection path for approvals, questions, text and install output

## Not in the list

- #309 (Egress guard: refuse a box where the lock cannot be taken) was closed unmerged at 22:28Z.
- #301, #304, #298 and #299 are open at the time of this check.
