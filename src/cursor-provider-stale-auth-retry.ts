import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { isCursorSdkUnauthenticatedFailure } from "./cursor-provider-errors.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnSendResult,
} from "./cursor-provider-turn-types.js";

/**
 * True when a local Cursor session agent failed send as unauthenticated after idle
 * (expired access token / stale transport) and recreating can still help.
 * Reused pooled agents (`created === false`) and `Agent.resume()` leases
 * (`resumed === true`) are retried. Fresh `Agent.create()` failures and
 * `run.wait()` after send returned a run are not retried here.
 */
function shouldRetryStaleLocalCursorAuth(
	prepared: CursorProviderTurnPrepareResult,
	error: unknown,
): boolean {
	if (prepared.runtimeTarget !== "local" || !isCursorSdkUnauthenticatedFailure(error)) {
		return false;
	}
	return prepared.sessionAgentLease.created === false || prepared.sessionAgentLease.resumed === true;
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
 * Prepare and send a Cursor provider turn, retrying once after discarding a
 * reused pooled or resumed local agent that failed Agent.send() as unauthenticated
 * after idle. The retry prepare uses `forceCreate` so Agent.resume cannot reload
 * the same expired agent. `prepareTurn` must assign the caller's `prepared`
 * variable before returning so a throwing `sendTurn` still has a prepared turn
 * for live-run cleanup.
 */
export async function prepareAndSendCursorTurnRetryingStaleAuth(params: {
	prepareTurn: (retry?: { forceCreate: true }) => Promise<CursorProviderTurnPrepareResult>;
	sendTurn: (prepared: CursorProviderTurnPrepareResult) => Promise<CursorProviderTurnSendResult>;
	sdkEventDebug?: Pick<CursorSdkEventDebugSink, "recordProviderEvent">;
}): Promise<{ prepared: CursorProviderTurnPrepareResult; sendResult: CursorProviderTurnSendResult }> {
	const prepared = await params.prepareTurn();
	try {
		return { prepared, sendResult: await params.sendTurn(prepared) };
	} catch (error) {
		if (!shouldRetryStaleLocalCursorAuth(prepared, error)) throw error;
		try {
			params.sdkEventDebug?.recordProviderEvent("stale_local_agent_unauthenticated_retry", {
				sendPlanReason: prepared.meta.sendPlan.reason,
			});
		} catch {
			// Debug capture is optional and must never change provider execution.
		}
		await discardPreparedTurnForStaleAuthRetry(prepared);
		const retried = await params.prepareTurn({ forceCreate: true });
		return { prepared: retried, sendResult: await params.sendTurn(retried) };
	}
}
