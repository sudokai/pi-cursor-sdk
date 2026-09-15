import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import {
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CursorStaleLocalAuthRetryError,
	isCursorSdkUnauthenticatedFailure,
} from "./cursor-provider-errors.js";
import type { CursorRunOutcome } from "./cursor-provider-run-outcome.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnSendResult,
} from "./cursor-provider-turn-types.js";

/**
 * Reused pooled agents (`created === false`) and `Agent.resume()` leases
 * (`resumed === true`) can recover from idle unauthenticated failures by
 * recreating. Fresh `Agent.create()` failures cannot.
 */
export function isStaleAuthRetryEligibleLease(prepared: CursorProviderTurnPrepareResult): boolean {
	if (prepared.runtimeTarget !== "local") return false;
	return prepared.sessionAgentLease.created === false || prepared.sessionAgentLease.resumed === true;
}

/**
 * True when a local Cursor session agent failed send or wait as unauthenticated after idle
 * (expired access token / stale transport) and recreating can still help.
 * `run.wait()` unauthenticated is retried only when drain/finalize reports no
 * user-visible output (`CursorStaleLocalAuthRetryError` or an auth guidance outcome).
 */
function shouldRetryStaleLocalCursorAuth(
	prepared: CursorProviderTurnPrepareResult,
	error: unknown,
): boolean {
	if (!isStaleAuthRetryEligibleLease(prepared)) return false;
	return isCursorSdkUnauthenticatedFailure(error) || error instanceof CursorStaleLocalAuthRetryError;
}

export function shouldRetryStaleLocalCursorAuthWaitOutcome(
	prepared: CursorProviderTurnPrepareResult,
	outcome: CursorRunOutcome,
): boolean {
	if (!isStaleAuthRetryEligibleLease(prepared) || outcome.kind !== "error") return false;
	if (prepared.textDeltas.some((delta) => delta.trim().length > 0)) return false;
	return outcome.errorMessage === AUTH_CURSOR_SDK_ERROR_MESSAGE;
}

/**
 * Drop the failed prepared turn so the next acquire cannot reuse the stale
 * pooled agent. A live run started during prepare is released (that abandons
 * the session agent); otherwise the session agent is abandoned directly.
 * Then restore the SDK output filter.
 */
async function discardPreparedTurnForStaleAuthRetry(
	prepared: CursorProviderTurnPrepareResult,
): Promise<void> {
	const liveRun = prepared.runtime.liveRun;
	if (liveRun && !liveRun.disposed) {
		await cursorLiveRuns.release(liveRun);
	} else {
		await prepared.lifecycle.abandon();
	}
	prepared.restoreCursorSdkOutputFilter();
}

/**
 * Prepare, send, and optionally await a Cursor provider turn, retrying once after
 * discarding a reused pooled or resumed local agent that failed Agent.send() or
 * run.wait() as unauthenticated after idle. The retry prepare uses `forceCreate`
 * so Agent.resume cannot reload the same expired agent. `prepareTurn` must assign
 * the caller's `prepared` variable before returning so a throwing `sendTurn` still
 * has a prepared turn for live-run cleanup.
 */
export async function prepareAndSendCursorTurnRetryingStaleAuth(params: {
	prepareTurn: (retry?: { forceCreate: true }) => Promise<CursorProviderTurnPrepareResult>;
	sendTurn: (prepared: CursorProviderTurnPrepareResult) => Promise<CursorProviderTurnSendResult>;
	afterSend?: (
		prepared: CursorProviderTurnPrepareResult,
		sendResult: CursorProviderTurnSendResult,
	) => Promise<void>;
	sdkEventDebug?: Pick<CursorSdkEventDebugSink, "recordProviderEvent">;
}): Promise<{ prepared: CursorProviderTurnPrepareResult; sendResult: CursorProviderTurnSendResult }> {
	const prepared = await params.prepareTurn();
	let sendResult: CursorProviderTurnSendResult | undefined;
	try {
		sendResult = await params.sendTurn(prepared);
		await params.afterSend?.(prepared, sendResult);
		return { prepared, sendResult };
	} catch (error) {
		if (!shouldRetryStaleLocalCursorAuth(prepared, error)) throw error;
		try {
			params.sdkEventDebug?.recordProviderEvent("stale_local_agent_unauthenticated_retry", {
				sendPlanReason: prepared.meta.sendPlan.reason,
			});
		} catch {
			// Debug capture is optional and must never change provider execution.
		}
		try {
			await sendResult?.send.run.cancel();
		} catch {
			// Best-effort cancel of the unauthenticated wait run before recreate.
		}
		await discardPreparedTurnForStaleAuthRetry(prepared);
		const retried = await params.prepareTurn({ forceCreate: true });
		const retriedSend = await params.sendTurn(retried);
		await params.afterSend?.(retried, retriedSend);
		return { prepared: retried, sendResult: retriedSend };
	}
}
