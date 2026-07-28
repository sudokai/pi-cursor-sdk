# Cursor live-run `turn-ended` usage accounting

> Maintainer note: internal investigation. For installation/usage, start with the [README](../../README.md). For the behavior contract this relates to, see [Cursor Model UX Spec](../cursor-model-ux-spec.md).

## Status

Active source of truth for the live-run SDK usage-accounting problem introduced by commit `5df250ac` ("fix(live-run): apply late SDK turn-ended usage instead of discarding"). Fold the durable facts into `docs/cursor-model-ux-spec.md` / `docs/cursor-native-tool-replay.md` once the recommended action lands, then delete this file.

## Summary

Commit `5df250ac` is corrupting per-message usage (and therefore pi's context-window percentage, cost, and compaction signals). It has **two independent defects**, and measurement overturned the premise behind the second one:

1. **It sums per-turn usage (inflate bug).** `recordCursorLiveSdkTurnEnded` was changed from overwrite to accumulate. The SDK's `turn-ended.usage` is per-turn (`toTokenUsage`); cross-turn summing is a separate opt-in helper (`sumTokenUsage`). Summing double-counts and inflates `usage.totalTokens`.
2. **It violates the documented accounting contract.** `docs/cursor-model-ux-spec.md` mandates: per-turn usage is used only if it arrives *before the pi turn emits*; after a timeout, later usage is **ignored, never carried/summed**. The commit carries stale usage forward across turns (and sums it).

Measurement (below) then showed the commit's stated motivation — *"turn-ended fires after tool execution and routinely arrived late [within a turn]"* — rests on a **false premise**: the SDK emits `turn-ended`/`usage` **once per run, at the very end**, not once per pi turn. There is no per-turn `turn-ended` to wait for.

## Background

- `src/cursor-live-run-accounting.ts` records SDK `turn-ended` usage; `takeCursorLiveSdkTurnUsage` consumes it when a pi turn is emitted.
- `src/cursor-provider-live-run-drain.ts` waits up to a hard-coded 125 ms (`waitForCursorLiveSdkTurnEnded`) for `turn-ended` before emitting a tool-use turn, then applies usage via `src/cursor-usage-accounting.ts` (`applyCursorUsage`, `isCursorSdkUsageSafeForPiMessage`).
- Pre-`5df250ac`, a timeout set `ignoreFutureSdkTurnUsage`, which discarded later usage for the whole run. `5df250ac` removed that and made `recordCursorLiveSdkTurnEnded` **sum** instead of overwrite, claiming "carry-forward" of late usage to the next emitted turn.

User-visible symptom: context-window usage percentages are wrong (inflated or collapsed to an approximate `cacheRead=0` value), and cost/`totalTokens` accounting is unreliable.

## Defect 1 — sum inflation (reproduced)

End-to-end repro through `streamCursor` (native-replay live run): a previous turn's late `turn-ended` and the current turn's `turn-ended` both land before one `takeSdkTurnUsage`:

| field | turn-1 (late) | turn-2 (own) | emitted (bug) | expected |
|---|---|---|---|---|
| input | 10000 | 20000 | **30000** | 20000 |
| cacheRead | 5000 | 10000 | **15000** | 10000 |
| totalTokens | — | — | **45300** | 30200 |

When the sum exceeds the model context window, `isCursorSdkUsageSafeForPiMessage` rejects it and `applyCursorUsage` falls back to `applyCursorApproximateUsage` (`cacheRead=0`). Net effect: usage **flickers** between inflated-sum and zero-cache depending on timing.

## Why we measured

To pick a bounded wait deadline for `waitForCursorLiveSdkTurnEnded` from real latency data, instead of guessing. The measurement answered a different question than expected.

## Method

Real `cursor/composer-2-5` local runs (native-replay + bridge, `--cursor-no-fast`) with the maintainer debug recorder (`PI_CURSOR_SDK_EVENT_DEBUG=1`), which timestamps every `onDelta`/stream event with `elapsedMs` from provider-turn start. SDK version `@cursor/sdk@1.0.23`. Two distinct multi-step prompts; artifacts retained under `/tmp` (gitignored; not committed). Model context window resolves to **256000** via `~/.pi/agent/cursor-sdk-context-windows.json` (`"auto": 256000`).

Findings cross-checked against the installed SDK package types and runtime (`node_modules/@cursor/sdk/dist/esm/agent/usage-types.d.ts`; the `turn-ended` emit site in `dist/esm/642.js`; the `turnEnded`→`turn-ended` delta mapping in `dist/esm/357.js`).

## Findings

### F1 — The SDK emits ONE `turn-ended`/`usage` per run, at the very end

| Run | tool calls | model invocations (`onStep` `assistantMessage`) | `step-completed` deltas | `turn-ended` deltas |
|---|---|---|---|---|
| 1 | 5 | 3 | **1** | **1** |
| 2 | 3 | multiple | **1** | **1** |

The raw `run.stream()` event stream likewise carried exactly **1** `usage` event per run. The `turn-ended` delta maps 1:1 from internal `turnEnded` stream messages (`dist/esm/357.js`); nothing in the SDK synthesizes one per model invocation or per tool round in local mode. The single event lands immediately after `step-completed` (run 1: `step-completed` @13997 ms, `turn-ended` @14010 ms; run 2: @27208 ms / @27217 ms).

**Implication:** no value of the per-turn wait deadline can give intermediate pi turns their own SDK usage — the event does not exist for them. The commit's "turn-ended arrived late within a turn" model is incorrect; the event arrives once, at run completion. The pre-`5df250ac` "~94% fell back to approximate" is structural: when pi splits one SDK run into N tool-use turns, only the final turn can ever observe the single end-of-run usage; the other N−1 correctly fall back to approximate.

### F2 — The single usage value is full-agent-context-sized

Run 1: `{input:122961, cacheRead:79515, total:203088}`. Run 2: `{input:79254, cacheRead:56083, total:136179}`. Both are whole-prompt-scale (system prompt + tool defs + conversation), far larger than any single tool round. Carrying this forward and summing it across turns (as `5df250ac` does) is what produces the inflated percentages.

### F3 — The real, actionable bug is a final-turn capture race

Both runs' usage passed the safety guard (`total ≤ 256000`), yet:

| Run | SDK `totalTokens` | guard (`≤256000`) | final pi message usage | outcome |
|---|---|---|---|---|
| 1 | 203088 | pass | `{input:4074, cacheRead:0, total:5434}` | **approximate — not applied** |
| 2 | 136179 | pass | `{input:79254, cacheRead:56083, total:136179}` | **applied** |

The difference is a **race**: `run.wait()` resolves and the `turn-ended` `onDelta` callback fire at the same instant (≈ run end); the stop/finalize path can call `takeSdkTurnUsage` just before the usage is recorded, missing it and falling back to approximate. Run 1 hit the race; run 2 did not. This is independent of, and more impactful than, the sum bug — it means even the single correct usage value is sometimes lost.

## Implications for the fix

- The planned "tune the per-turn wait" intervention is **void** — there is no per-turn `turn-ended` to wait for.
- Intermediate split turns structurally have no SDK usage; approximate fallback for them is correct, not a bug to patch with carry-forward.
- The only place a bounded wait helps is the **finalize path**, to deterministically capture the single end-of-run usage for the final/stop turn (F3). It is small: the event lands ~10–150 ms after `step-completed`.

## Recommended action

1. **Revert the accumulation** in `src/cursor-live-run-accounting.ts`: `recordCursorLiveSdkTurnEnded` sets (overwrites) `sdkTurnUsage`; delete `sumCursorSdkTurnUsage`. Each pi turn captures only its own usage; no cross-turn carry-forward.
2. **Restore the documented contract** ("per-turn usage only if it arrives before the pi turn emits; after a timeout, ignore — never carry or sum"). Intermediate split turns fall back to approximate, which is correct given F1.
3. **Fix the final-turn race (F3)** in the finalize path: after `run.wait()` resolves, briefly reconcile for the `turn-ended`/`usage` event before emitting the stop turn, so the one real usage value is reliably captured. Keep it bounded (event arrives within ~10–150 ms of `step-completed`).
4. **Remove the now-misguided `waitForCursorLiveSdkTurnEnded` per-turn wait** (or document why it is retained). It cannot obtain per-turn usage that the SDK does not emit.
5. **Tests/docs:** flip the three `5df250a` tests (`test/cursor-live-run-accounting.test.ts`, `test/cursor-live-run-coordinator.test.ts`, `test/cursor-provider-replay-live-run.test.ts`) from "accumulates/sums" to the restored contract; add a regression test asserting an emitted turn never reports a cross-turn sum, and a finalize-race test asserting the end-of-run usage is applied to the stop turn; update the carry-forward/whole-run-ignore wording in `docs/cursor-model-ux-spec.md` and `docs/cursor-native-tool-replay.md`.

### Open caveat

Evidence is **local mode only** (`composer-2-5`, bridge). Cloud mode was not exercised here. The recommended fix is safe regardless: if cloud ever emits multiple per-turn `turn-ended` events, "no sum, no carry-forward, per-turn capture + finalize reconcile" remains correct, and the finalize wait becomes a no-op. A cloud run should be added to confirm whether cloud emits per-turn usage before treating this as fully closed.

### Validation gate

`npm test` + `npm run typecheck` are necessary. Because this touches provider runtime accounting, the pre-commit gate per `AGENTS.md` is `npm run smoke:platform:all` (and `npm run smoke:cloud` for the cloud caveat above). Use `cursor/composer-2-5:slow` (or `cursor/composer-2-5` if Cloud lacks the `:slow` variant) for live evidence.
