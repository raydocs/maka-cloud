# Model gateway (`@maka-cloud/gateway`)

A host-side proxy between everything that calls a model and the model vendors. It holds the
vendor API keys, gives each caller a revocable token bound to a budget, reserves the worst-case
cost of every request before sending it, and charges what the vendor reports afterwards.

## Why

Before this, `startStack` handed `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` to the runners, and
`envModelAccess` put them in the sandbox environment of every task. Any task with a shell could
read the master keys and spend without limit, and stopping the task revoked nothing. Spend was
metered from what the CLI printed: Codex prints usage only at `turn.completed`, so a budget could
not act inside a turn. The supervisor reserved verification spend with a two-characters-per-token
estimate that dense Unicode undercuts about threefold.

## Shape

```
sandbox CLI ──HTTPS, task token──▶ gateway ──master key──▶ vendor API
conductor, supervisor ──in-process fetch──▶ gateway ──master key──▶ vendor API
```

- **One package, no workspace dependencies.** It needs Node only. `cloud-host` builds it from the
  environment and adapts it to the runners' `ModelAccessProvider`, the conductor and the supervisor.
- **Vendor keys stay on the host.** The gateway alone reads `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY`. Sandboxes get the gateway URL and a task token; the conductor and the supervisor
  get an in-process `fetch` and a placeholder key.
- **Two routes, one pipeline.** The HTTP server serves `POST /anthropic/v1/messages`,
  `POST /anthropic/v1/messages/count_tokens` and `POST /openai/v1/responses`. Everything else is
  404. In-process callers use `gateway.inProcess(input)`, which runs the same pipeline without a
  socket. There is one code path for bounds, reservation, forwarding, metering and cutting.

## Tokens

- 32 random bytes, base64url, prefixed `mkg_`. The gateway keeps only their SHA-256, in memory.
  A request is authenticated by `x-api-key` or `Authorization: Bearer`, looked up by hash.
- **Revocation.** `revoke()` marks the grant dead and aborts its in-flight requests at once: an
  open stream ends mid-way. It resolves once every request of the grant has settled, so the spend
  read after it is final. A runner revokes before it reports its end, and in its cleanup on every
  exit (cancel, failure, throw, start that lost a race with a cancel), and reports the final spend
  as its last `usage`; the orchestrator records that spend even after a cancel or the end of the
  tree's top-level task. The orphan sweep calls `revokeForTask`. Grants are never persisted, so a
  host restart revokes every token.
- **Concurrency.** A grant has at most 8 requests in flight; more are refused with 429. A leaked
  token cannot exhaust the vendor rate limit for everyone.
- **Scope.** A token is issued for one vendor. A Claude task's token is refused on the OpenAI route.
- **Tenancy.** A tenant's tasks share one sandbox user, so a task can read a sibling task's token
  from `/proc`. That token is bound to the sibling's budget and dies with the sibling. Tenants never
  share a machine, so no token crosses tenants.

## Budgets

The gateway invents no ledger. A grant charges a **budget port**: `reserve(key, usd)` and
`settle(key, usd)`, both synchronous, so the check and the reservation are one step.

- **Runner tasks.** The conductor already reserved the delegation's `budgetUsd` in its run ledger,
  and the orchestrator passes what is left of the tree's cap as `RunSpec.budgetUsd`. A runner grant
  draws on a **tree pool** keyed by the tree's root task (`RunSpec.budgetRootId`, new): the pool
  starts at the first run's `budgetUsd`, and every later grant in the tree is capped at the smaller
  of its own `budgetUsd` and what the pool has left. Concurrent sibling tasks therefore cannot
  together spend more than the tree's cap, which the orchestrator's soft cap alone did not
  guarantee. A run without `budgetUsd` gets no token and fails to start. What the gateway settles
  is reported back as the runner's `usage` events, so `task_cost` and the conductor's settlement of
  the delegation see the gateway's numbers.
  Those events live only in the process, so the host also writes each runner request to a spend
  journal (`gateway-spend.db`, SQLite, synchronous): a hold before it is sent, its cost when it
  settles. A request the journal cannot take is refused (503) and its reservation released. At the
  next start the orchestrator records, as `task_cost` on the tree root, what each task's grants
  settled in earlier processes plus every hold they left open at its reserved amount, before it
  ends the orphaned runs.
- **Conductor.** Its requests go through `inProcess`, one grant per Maka session, closed when the
  turn or the planner ends; its own configuration holds no vendor key. Each request reserves in the
  run ledger (a `reserve` row with ref `request:<key>`) and settles there as a `model` row. A
  request the run cannot cover is refused before it is sent and opens a budget question for what
  it needs. The conductor stops adding spend from `recordModelCallAttempt`, which would count it
  twice; its request gate stays. A reservation a crashed process never settled is charged in full
  at the next start.
- **Supervisor.** The verifier's port is the existing gate: the day's cap, then the conversation's
  run budget through `Conductor.reserveSpend/settleSpend`. A check model through the gateway is
  `metered`: the supervisor stops reserving its own estimate and hands the gateway a charge, so
  the gateway reserves on the exact request body; a refusal is a check that could not run for
  budget. The digest summary goes through the gateway on its own limit of $0.50 per UTC day, kept
  in the spend journal: a restart reads the day's spend back, and a reservation a crashed process
  never settled counts in full. Without that limit the inbox does not build the summary model.

## Worst-case reservation

Before a request is sent, the gateway computes the most it can cost and reserves that. A request
whose cost it cannot bound is refused (400), never sent.

- **Input bound.** The UTF-8 byte length of the request body as tokens (no tokenizer emits more
  tokens than bytes of text), plus a fixed overhead per request (default 4,000 tokens, for the
  vendor's hidden tool-use prompt).
- **Only listed content.** Request content is checked against an allowlist, at every depth, so
  a type the gateway does not know is refused rather than bounded by its bytes. Anthropic: the
  system prompt is text blocks; a message is `{role, content}` with role `user` or `assistant`;
  its blocks are `text`, `thinking`, `redacted_thinking`, `tool_use` and `tool_result`, each with
  only its listed keys, and a tool result's content is a string or text blocks. OpenAI: every
  typed object in `input` is a message, a text, refusal or reasoning part, one of the local tool
  calls the tool list allows or its output, or a typed value inside one (a shell action or
  outcome, a patch operation); `instructions` is a string. Everything else is refused: images,
  files and documents (what a model bills for an image depends on the model and the detail
  level, and a tile-based model bills a 32×32 image at detail `high` 8,500 tokens), search
  results, citations, stored items and server-tool history such as a fetched PDF, which bills
  its pages and not the bytes of its URL. Coding and research need only text.
- **When the byte bound does not fit.** Agent contexts are large and bytes overstate tokens about
  fourfold. When the byte bound exceeds what is left, an Anthropic request is counted with the
  vendor's free token-count endpoint (plus 10% and the overhead)
  and reserved at the counted bound. Only if that does not fit either is it refused.
- **Output bound.** Anthropic: `max_tokens` (required by the API). OpenAI: `max_output_tokens`; when
  absent the gateway sets it to the model's configured output cap, which the model cannot exceed
  anyway. A value above the configured cap is refused.
- **Prices.** Per model, from a table: input, output, cache read, and the long-context tier where
  one applies (the higher tier is used when the bound is above its threshold). Input is reserved at
  the cache-write rate (1.25×, or 2× when the body asks for a one-hour cache), since any input token
  may be written to the cache. A model not in the table is refused. Built in: `claude-opus-5-5`,
  `claude-sonnet-5-5`, `claude-haiku-5-5` (list prices as of 2026-10). OpenAI models must be
  configured with `MAKA_CLOUD_GATEWAY_MODELS`.
- **Allowlisted fields.** Request fields that change the price or add work the body does not
  show are refused: fast mode, inference geography, service tiers other than standard, server-side
  conversation state (`previous_response_id`, `conversation`, stored prompts), MCP servers,
  containers, compaction, and every hosted tool (web search, web fetch, code execution, file
  search, a shell in a vendor container). OpenAI tools the caller runs itself are accepted only in
  their exact shape (`function`, `custom`, `local_shell`, `apply_patch`, and `shell` with
  `environment: {"type": "local"}` and nothing else). Only the fields each route lists are accepted; an unknown field is refused, so a CLI
  update that starts sending a new priced field fails loudly instead of overspending.

## Settling and cutting

- The gateway reads the vendor's usage from the response as it passes through, without changing
  the bytes: Anthropic `message_start` (input and cache counts) and `message_delta` (output);
  OpenAI `response.completed`, `response.incomplete` or `response.failed`, or the JSON body.
- **Settle** at the reported usage only when it meets the vendor's schema for its mode;
  anything else settles at the reservation, never at an earlier count. Every count is a
  non-negative integer, and a field the schema does not list may not carry a charge (only a
  string, a boolean, `null` or 0 is ignored).
  - Anthropic (`message_start`, each `message_delta`, or the JSON body): the output count is
    required; the input count too, except in a delta, where `null` means unchanged; the cache
    counts may be `null`. Counts are cumulative, so none may go down. A cache-write split, when
    present, gives both lifetimes, neither going down, and adds up to the aggregate given with it
    or earlier; writes the split does not cover are charged at the dearest lifetime the request
    allows. Hosted-tool counts must be zero.
  - OpenAI (one final usage object; a second one is malformed): input and output counts are
    required; `input_tokens_details` and `output_tokens_details`, when present, carry
    `cached_tokens` and `reasoning_tokens`, no larger than their totals; `total_tokens`, when
    present, is their sum.

  An error status before any output (4xx, 5xx) settles at 0: the vendors do not bill those. A
  response that ends without complete, valid usage settles at the full reservation, since what
  was billed is unknown; a stream cut after a valid `message_start` settles at the reported input
  plus the full output bound.
- **Cut.** A stream is cut (the upstream request aborted, the client's stream ended with an error
  event) when the grant is revoked, when the gateway closes, and when the reported input already
  makes the request cost more than its reservation. The last case is a bound that turned out
  wrong; the overrun is settled in full and, on the conductor ledger, blocks the run until the user
  answers a budget question.

## Web search

Hosted vendor web search stays refused (see "Allowlisted fields"). Research runs search through
the gateway instead.

- **Route.** `POST /search` with a task token of either vendor and the body `{query, count?}`:
  a query of 1 to 128 characters, up to 20 results (10 by default). An unknown field is refused.
  The answer is `{results: [{title, url, snippet, published?}]}`. Neither the answer nor an
  error names the provider.
- **Provider.** Behind `SearchProvider`. The first backend is the DeepSeek Search API
  (`POST /v1/tools/search`, key `DEEPSEEK_API_KEY`), so no separate search engine is needed. It
  bills $0.75 per 1,000 calls that answer 200 with at least one result. Errors, empty results and
  timeouts are free.
- **Budget.** Each call reserves its fixed price ($0.00075 by default) through the grant's port
  before it is sent. It settles at that price when the provider billed it or may have (a
  connection that broke after the request was sent, a timeout, or a 200 whose answer has no
  list of results), else at 0. Only a valid empty list counts as an unbilled empty search. A call the budget
  cannot cover is refused with 402 and never sent. Searches count against the grant's in-flight
  limit, are cut on revoke and after 30 seconds, and `revoke()` waits for them to settle.
- **Untrusted text.** The gateway keeps only http(s) URLs and strips control and bidi characters,
  and it caps every field. The sandbox's `web-search` command prints the results between markers
  that carry a random tag, and says the text between them is data from the web, never
  instructions. The supervisor already reads everything a run reports as untrusted.

## Secrets and logs

- No request or response body, header value, token or key is logged. Warnings carry a grant's
  subject (task id or run id), the route and a status code.
- Upstream requests carry only `content-type`, `accept`, `anthropic-version`, `anthropic-beta` and
  the master key; the caller's credentials are stripped. Responses pass back `content-type` and
  the vendor's request id only.
- Error bodies use the vendor's error shape so the CLIs report them, with texts that name no
  vendor or model ("the task's model budget is used up").

## Configuration

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Vendor keys. Read by the gateway only. |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` | The gateway's upstreams (default: the vendors' APIs). |
| `MAKA_CLOUD_GATEWAY_HOST`, `MAKA_CLOUD_GATEWAY_PORT` | Where it listens (default 127.0.0.1:8082). |
| `MAKA_CLOUD_GATEWAY_PUBLIC_URL` | The gateway as sandboxes reach it. HTTPS, except for a loopback host. |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` | Web search key and API (optional). Without the key, runs get no `web-search` command. |
| `MAKA_CLOUD_GATEWAY_MODELS` | JSON array of `{vendor, model, inputPerMTokUsd, outputPerMTokUsd, cacheReadPerMTokUsd?, maxOutputTokens, longContext?}`; replaces a built-in entry of the same model. |

## Delivery

1. **PR A1:** the package, the runners on gateway tokens (sandbox env has no vendor key), gateway
   metering as the runner's `usage`, `RunSpec.budgetRootId`, the host stack and config.
2. **PR A2:** the conductor and the supervisor verifier and summary through `inProcess`, after the
   conductor and supervisor follow-up PRs that touch the same files have merged. The stack hands
   the conductor no vendor key.
3. **PR A3:** web search: the `/search` route with a per-call reservation, the DeepSeek backend,
   the runners' `MAKA_SEARCH_URL` and `MAKA_SEARCH_TOKEN`, and the `web-search` sandbox tool,
   which the research contract names.

## Not covered

- The token-count endpoint is described as an estimate; the 10% margin is an assumption, and the
  `message_start` check is what catches a count that was too low.
- Prices are configuration. A wrong table entry makes every bound wrong by the same factor.
- Hosted web search is refused, so research tasks search and fetch from the sandbox shell only.
- Per-user plans and monthly limits are T17; this gateway is the enforcement point they will use.
