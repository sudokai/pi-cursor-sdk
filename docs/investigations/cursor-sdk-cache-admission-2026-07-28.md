# Cache-warmth discrepancy: `@cursor/sdk` conversations warm one turn later than native Cursor agent conversations

**Date:** 2026-07-28
**Reporter:** pi-cursor-sdk (pi extension wrapping `@cursor/sdk`)
**SDK:** `@cursor/sdk@1.0.23`, local mode
**Models exercised:** `composer-2.5` (`:slow`), `grok-4.5` (`:slow`, backend `cursor-grok-4.5-high`)
**Evidence basis:** Cursor dashboard usage-events CSV exports cross-checked against SDK `turn-ended` usage events captured client-side (exact agreement on every turn, 9/9).

## Summary

For an identical workload (three consecutive "hello" turns in one conversation), a conversation driven through `@cursor/sdk` gets **no conversation-prefix cache hits on turns 1 and 2**, regardless of pacing (tested 8–90 s gaps). The first full-prefix hit always arrives on **turn 3**. The native Cursor agent, same model, same account, minutes later, is **~99.5% cache-warm already on turn 2**. The model-side cache is therefore capable of immediate read-after-write; SDK-driven conversations appear to be subject to a more conservative cache-admission policy.

## Reproduction

1. Start a conversation via `@cursor/sdk` (local agent), model `composer-2.5`.
2. Send "hello" three times, waiting for each run to finish. Pacing does not matter (verified with ~10–20 s and ~60–90 s gaps).
3. Export the dashboard usage-events CSV and compare `Cache Read` against prompt size (`Input (w/o Cache Write)` + `Cache Read`) per turn.
4. Repeat inside the native Cursor agent chat with the same model.

## Observed behavior

### A. SDK-driven sessions — cold until turn 3, pacing-independent

Session A — `composer-2.5:slow`, gaps 19 s / 8 s:

| Turn | Time (UTC) | Prompt tokens | Cache Read | Hit rate |
|---|---|---|---|---|
| 1 | 20:28:03 | 18,846 | 5,675 | 30.1% |
| 2 | 20:28:19 | 19,017 | 5,675 | 29.8% |
| 3 | 20:28:25 | 22,607 | 19,016 | 84.1% |

Session B — `composer-2.5:slow`, gaps **90 s / 66 s** (paced to rule out propagation delay):

| Turn | Time (UTC) | Prompt tokens | Cache Read | Hit rate |
|---|---|---|---|---|
| 1 | 20:35:05 | 18,936 | 5,675 | 30.0% |
| 2 | 20:36:32 | 18,996 | 5,675 | 29.9% |
| 3 | 20:37:38 | 22,567 | 18,995 | 84.2% |

Session C — `grok-4.5:slow`, gaps 17 s / 8.5 s:

| Turn | Time (UTC) | Prompt tokens | Cache Read | Hit rate |
|---|---|---|---|---|
| 1 | 20:28:48 | 19,739 | 896 | 4.5% |
| 2 | 20:29:01 | 19,783 | 2,560 | 12.9% |
| 3 | 20:29:08 | 23,550 | 19,712 | 83.7% |

Three earlier same-day SDK sessions (09:11–09:13 five-turn, 09:23, 09:55) show the identical signature: turns 1–2 cold (only the ~5.6k global block), warm from turn 3 — including a five-turn session where turns 3, 4, 5 are all warm. The 5,675-token block that always hits is a long-lived global prefix (system prompt + tool definitions); the same value appears across days and sessions in the usage CSV.

The prompt prefix is byte-stable across turns, so this is not a cache bust: turn 3's cache read (e.g. 18,995) equals turn 2's *entire* prompt (18,996), which is only possible if turns 1–3 share an identical prefix; turn 2's prompt equals turn 1's prompt plus exactly the appended conversation tokens (+60 to +171).

### B. Native Cursor agent session — warm from turn 2

`composer-2.5`, same account, same day, gaps 21 s / 6 s:

| Turn | Time (UTC) | Prompt tokens | Cache Read | Hit rate |
|---|---|---|---|---|
| 1 | 20:40:43 | 17,883 | 6,636 | 37.1% |
| 2 | 20:41:04 | 17,966 | 17,882 | **99.5%** |
| 3 | 20:41:10 | 18,036 | 17,965 | **99.6%** |

### Side-by-side

| Turn | Native agent hit rate | SDK agent hit rate (paced) |
|---|---|---|
| 1 | 37.1% | 30.0% |
| 2 | **99.5%** | **29.9%** |
| 3 | 99.6% | 84.2% |

## Interpretation

- Pacing independence (8–90 s gaps produce identical results) rules out asynchronous cache-write propagation delay. The warmth pattern is **turn-count-driven, not time-driven**: SDK conversations behave as if a conversation-specific prefix is admitted to the cache only after being seen twice ("cache on second reference"), becoming readable from the third request.
- The native agent does not exhibit this: its turn-2 request already reads back essentially the whole turn-1 prompt. So the infrastructure supports immediate read-after-write; SDK-originated conversations appear to be routed through a different, conservative admission path (no persistent conversation cache namespace, no explicit cache hints, or a different cache tier).
- `@cursor/sdk@1.0.23` exposes no cache-related request options, so this cannot be influenced client-side.
- SDK `turn-ended` usage events matched the dashboard CSV exactly on all verified turns (`inputTokens` = `Input (w/o Cache Write)` + `Cache Read`), so the effect is not a measurement artifact.

## Impact

Each fresh SDK conversation pays full prompt price for its first two turns (here ~13–19k uncached tokens per turn). Long-running sessions amortize this to noise, but SDK workloads that spawn many short conversations (one-shot agents, CI runs, scripted tooling) pay the cold-prefix premium on every conversation, on both latency and billed input tokens.

## Request

1. Confirm whether the seen-twice cache admission for SDK-driven conversations is intentional.
2. If not intentional, bring SDK conversations to parity with the native agent (warm from turn 2).
3. If intentional, document the warm-up behavior so SDK developers can plan around it (e.g., keep conversations alive rather than respawning agents per task).

## Raw data

All figures above are from the reporter's own dashboard usage-events CSV (`usage-events-2026-07-28`), cross-checked against client-side captures of SDK `turn-ended` deltas. Full per-turn tables and the client-side capture method are available on request.
