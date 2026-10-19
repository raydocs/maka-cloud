# T3 findings: does Maka keep Claude history append-only?

Measured on `main` at 329a1d5 (ai-sdk 4.0.82) with `packages/cloud-conductor-checks`. Rerun with
`npm run build -w @maka-cloud/conductor-checks && npm run report -w @maka-cloud/conductor-checks`.

## Short answer

- **Thinking is safe on the default path.** With the defaults that `runtime-host` wires (pruning and
  compaction on), with everything off, and across a restart, every thinking and redacted_thinking
  block and its signature comes back unchanged, at the same position, in every later request:
  70 blocks, 2,415 checks per run.
- **The byte-identical prefix fails on every request, for two by-design reasons.** One is the moving
  cache marker. The other is the per-turn environment context that is sent after the history and
  dropped from the next request. Setting those two aside, the history is append-only on the
  default path.
- **Compaction rewrites the history by design**, and after any compaction Maka **drops every later
  redacted_thinking block**. That second part is an upstream bug.
- **A session created without an `llmConnectionId` drops all prior-turn thinking.**

## Method

A SessionManager on real SQLite stores runs an AiSdkBackend built with the seams `runtime-host`
gives it (`packages/runtime-host/src/server/execution-model-composition.ts:139-470`): the default
context budget policy, projection transitions, compaction checkpoints, the tool-result archive, the
text summarizer, and the per-turn `runtime.environment` context. Its `anthropic` connection points
at a local fake Messages endpoint that records every request body. The model is `claude-opus-5-5`
at thinking level `high`. The conversation is 30 user turns with 1 to 3 tool steps each, which
makes 70 requests. One turn in three returns redacted_thinking; every other reply returns signed
thinking.

The checks compare every main request with the one before it, both across tool steps and across
turns:

1. **Strict prefix:** each earlier `messages[i]` is byte-identical in the next request.
2. **Content prefix:** check 1 with `cache_control` keys and the request-only context blocks set
   aside.
3. **Thinking:** every block the endpoint returned is found in every later request with the same
   text, signature and position.
4. **Breakpoints:** at most 4 in total, the message marker on the last durable block, never moving
   backwards.

## Results

| Run | Setting | Turns ok | Strict prefix breaks | Content prefix breaks | Thinking failures | Breakpoint failures |
|---|---|---|---|---|---|---|
| A | Defaults as runtime-host wires them | 30/30 | 69 request_only_context_and_cache_control | 0 | 0 of 70 | 0 |
| B | Pruning and compaction off (no context budget policy) | 30/30 | 69 request_only_context_and_cache_control | 0 | 0 of 70 | 0 |
| C | Pruning on, tool results over 7,500 bytes, first archive write fails | 30/30 | 68 request_only_context_and_cache_control, 1 rewrite | 1 | 0 of 70 | 0 |
| D | Proactive compaction (low compaction threshold) | 30/30 | 68 request_only_context_and_cache_control, 1 rewrite | 1 | 67 of 70 | 1 |
| E | Reactive overflow recovery (one context-overflow 400 at turn 20) | 30/30 | 66 request_only_context_and_cache_control, 4 rewrite | 4 | 49 of 70 | 1 |
| F | Manual compaction before turn 16 | 30/30 | 63 request_only_context_and_cache_control, 6 rewrite | 6 | 40 of 70 | 1 |
| G | Restart after turn 15 (new SessionManager and backend, same stores) | 30/30 | 69 request_only_context_and_cache_control | 0 | 0 of 70 | 0 |
| H | Defaults, but the session has no llmConnectionId | 30/30 | 40 request_only_context_and_cache_control, 29 rewrite | 29 | 68 of 70 | 0 |

`system` and `tools` were byte-stable between all requests in every run. No request carried more
than 2 cache markers: the top-level automatic one and one message marker.

## What breaks what

| # | Path | Breaks | Where | When |
|---|---|---|---|---|
| 1 | Moving history cache marker | Strict prefix only. The previous marked block loses its `cache_control` key; content is unchanged | `packages/runtime/src/model-adapter.ts:1382-1405`, called at `:347`, index from `ai-sdk-turn.ts:1660`, enabled by `model-factory.ts:540` | Every request on a `providerType: 'anthropic'` connection |
| 2 | Request-only contexts after the history | Strict prefix only. Request N ends with a context text block that request N+1 no longer has | `packages/runtime/src/ai-sdk-turn.ts:1571-1573` and `:1631`; the production source is `runtime-host/src/server/execution-model-composition.ts:485-497` (`runtime.environment`, every turn) | Every request in runtime-host |
| 3 | Late tool-result archive | Content prefix: a tool_result already sent in full becomes a `maka.archived_tool_result` placeholder | Threshold `read-page.ts:25` (7,500 bytes) at `tool-result-archive-transition.ts:242`; a failed write is swallowed at `tool-result-archive-transition.ts:115-139`; the retry happens at the next prune, `ai-sdk-turn.ts:1359` and `ai-sdk-compaction.ts:618-635` | Only after an archive write fails. Large results whose write succeeds are archived before their first send (run C: every other large result) |
| 4 | Compaction checkpoint replay | Content prefix and thinking: the covered prefix becomes one checkpoint block, so all earlier thinking is gone and the marker moves back to block 1 | Pre-turn: `history-compaction.ts:513-568`. Proactive mid-turn: `ai-sdk-compaction.ts:908-916`. Reactive overflow: `ai-sdk-compaction.ts:1229-1314`. Manual: `ai-sdk-compaction.ts:277-498` | Proactive only when the user declares `compactionThreshold` (`core/src/model-thinking.ts:269-274`, otherwise inert). Reactive on any context-overflow error (on by default). Manual on `/compact` |
| 5 | **Bug:** redacted_thinking dropped after a checkpoint | Thinking and content prefix. Every redacted_thinking produced after a checkpoint disappears: at the next turn after a pre-turn checkpoint (run F), or at the next step of the same turn after a mid-turn checkpoint (runs D and E). Signed thinking is unaffected | A redacted block is stored as a thinking event with empty text (`model-adapter.ts:1064-1075`, `session-event-runtime-mapper.ts:234-244`). `estimateRuntimeEventChars` counts only text (`model-history.ts:417-418`), so `isHistoryCompactContentEvent` is false (`history-compact-checkpoint.ts:863-865`), and checkpoint replay keeps only content events (`history-compaction.ts:520`; mid-turn `ai-sdk-turn.ts:1370`). The cause is read from the code; runs D, E and F confirm the effect | Once any checkpoint exists in the session |
| 6 | Route provenance without a connection id | Thinking and content prefix. All thinking from earlier turns is dropped at every turn boundary; thinking within a turn survives | `runtime-invocation-route.ts:42-53` gives `provenance: 'unknown'` when the header has no `llmConnectionId`. Prior-turn thinking is admitted only for `provenance: 'runtime'` with the same `providerStateIdentity` and model (`model-history.ts:307-330`, applied at `ai-sdk-turn.ts:2934`) | Sessions created without `llmConnectionId`. From the same code, a missing or changed `providerStateIdentity` also drops it (read from the code, not run) |

Pruning on or off makes no difference to normal tool results: runs A and B produce identical
results. Restarting onto the same stores keeps everything (run G).

## For T5 (conductor)

- Create every conductor session with an `llmConnectionId`, and register the backend so that it
  reports a stable `providerStateIdentity` (a prepared backend factory, as `runtime-host` does).
  Otherwise path 6 drops all prior-turn thinking.
- Send no per-request contexts. Put the environment line in the user message once, or in the
  system prompt. Then the only strict-prefix difference left is the moving `cache_control` key
  (path 1), which is Anthropic's documented incremental caching pattern.
- Leave `compactionThreshold` undefined for Opus 5.5 on its 1M window, so proactive compaction
  stays off. Reactive overflow recovery stays as the last resort; when it fires, it is a deliberate
  break.
- Until path 5 is fixed upstream, any session that has compacted once loses redacted_thinking on
  every later turn. The fix is small: count redacted data in `estimateRuntimeEventChars`, or keep
  thinking events in `isHistoryCompactContentEvent`. It belongs upstream (apache/maka), not in a
  fork patch.

## Upstream candidates

These two are to be filed with apache/maka. Each repro is a small script you run from
`packages/runtime` after `npm run build -w @maka/runtime`. Both were run on the code measured above.

### Redacted thinking is dropped from compaction replay (path 5)

`isHistoryCompactContentEvent` (`history-compact-checkpoint.ts:863-865`) keeps an event only if
`estimateRuntimeEventChars` (`model-history.ts:414-418`) is above zero. That function counts only
`content.text`. A redacted_thinking block is stored as a thinking event with empty text and the
opaque data in `providerOptions.anthropic.redactedData`, so it counts as zero. Checkpoint replay
filters events with this predicate (`history-compaction.ts:520`, mid-turn `ai-sdk-turn.ts:1370`),
so every redacted_thinking block after a checkpoint is dropped from the request.

```js
import { isHistoryCompactContentEvent } from './dist/history-compact-checkpoint.js';

const base = { id: 'e1', invocationId: 'i1', runId: 'r1', sessionId: 's1', turnId: 't1', ts: 1,
  partial: false, role: 'assistant', author: 'model' };
const signed = { ...base, content: { kind: 'thinking', text: 'step 1', signature: 'sig' } };
const redacted = { ...base, id: 'e2', content: { kind: 'thinking', text: '',
  providerOptions: { anthropic: { redactedData: 'opaque' } } } };

console.log(isHistoryCompactContentEvent(signed));   // true
console.log(isHistoryCompactContentEvent(redacted)); // false: dropped after a checkpoint
```

To reproduce end to end, use run F in `packages/cloud-conductor-checks`: compact once, then every
later redacted_thinking block is missing from the next request. Suggested fix: count
`providerOptions.anthropic.redactedData` in `estimateRuntimeEventChars`, or keep thinking events
in `isHistoryCompactContentEvent` whatever their text length.

### A session without `llmConnectionId` drops all earlier thinking (path 6)

`runtimeInvocationRouteForHeader` (`runtime-invocation-route.ts:24-58`) returns
`provenance: 'unknown'` for a non-plugin backend whose header has no `llmConnectionId`. That
happens even when the backend passes a `providerStateIdentity`, and the identity is not carried on
the unknown route. `compatibleProviderReasoningReplayEventIds` (`model-history.ts:307-330`) admits
earlier runs' reasoning only for `provenance: 'runtime'`. So every thinking block from earlier
turns is stripped at each turn boundary, with no diagnostic. This may be a deliberate fail-closed
choice. If it is, a header without `llmConnectionId` should be rejected or warned about rather than
silently degrading Anthropic replay.

```js
import { runtimeInvocationRouteForHeader } from './dist/runtime-invocation-route.js';
import { compatibleProviderReasoningReplayEventIds } from './dist/model-history.js';

const identity = `sha256:${'5'.repeat(64)}`;
const header = { backend: 'ai-sdk', llmConnectionSlug: 'anthropic', model: 'claude-opus-5-5' };
for (const h of [header, { ...header, llmConnectionId: 'conn-1' }]) {
  const route = runtimeInvocationRouteForHeader(h, identity);
  const kept = compatibleProviderReasoningReplayEventIds([{ id: 'think-1', runId: 'run-1' }],
    [{ runId: 'run-1', opening: { route } }], identity, 'claude-opus-5-5', 'run-2');
  console.log(h.llmConnectionId ?? 'unset', route.provenance, kept.has('think-1'));
}
// unset unknown false
// conn-1 runtime true
```

To reproduce end to end, use run H in `packages/cloud-conductor-checks`: 68 of 70 thinking blocks
are missing from later requests.

## What was not verified

- Live mode (`src/__tests__/live-opus.test.ts`) was written but not run. It needs both
  `ANTHROPIC_API_KEY` and `MAKA_CLOUD_LIVE=1`.
- The fake returns made-up signatures, so nothing here shows what Anthropic does with them. In
  particular, it is unknown whether Opus 5.5 accepts thinking whose original request ended with a
  context block that the next request no longer has (path 2). The live run reports any 400 and the
  per-request `cache_read_input_tokens`.
- The tools are two custom tools, not Maka's builtin file tools. The archive uses the
  artifact-backed recorder, not runtime-host's ledger-backed one; both produce a placeholder
  rewrite.
- Images, steering messages, plan mode and child agents were not exercised.
