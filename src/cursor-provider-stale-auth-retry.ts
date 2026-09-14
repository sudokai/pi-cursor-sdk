import { cursorLiveRuns } from "./cursor-provider-live-run-drain.js";
import { isCursorSdkUnauthenticatedFailure } from "./cursor-provider-errors.js";
import type { CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import type {
	CursorProviderTurnPrepareResult,
	CursorProviderTurnSendResult,
} from "./cursor-provider-turn-types.js";

/**
 * True when a reused pooled local Cursor session agent failed send as unauthenticated
 * (idle expired access token / stale transport). Fresh Agent.create() failures and
 * run.wait() after send returned a run are not retried here.
 */
function shouldRetryStalePooledCursorAuth(
	prepared: CursorProviderTurnPrepareResult,
	error: unknown,
): boolean {
	return (
		prepared.runtimeTarget === "local" &&
		prepared.sessionAgentLease.created === false &&
		isCursorSdkUnauthenticatedFailure(error)
	);
}

/**
 * Drop the failed prepared turn so the next acquire cannot reuse the stale
 * pooled agent. A live run started during prepare is released (that abandons
 * the session agent); otherwise the session agent is abandoned directly.
 * Then restore the SDK output filter.
 */
async function discardPreparedTurnForStalePooledAuthRetry(
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
 * Prepare and send a Cursor provider turn, retrying once after discarding a reused
 * pooled local agent that failed Agent.send() as unauthenticated after idle.
 * `prepareTurn` must assign the caller's `prepared` variable before returning so a
 * throwing `sendTurn` still has a prepared turn for live-run cleanup.
 */
export async function prepareAndSendCursorTurnRetryingStaleAuth(params: {
	prepareTurn: () => Promise<CursorProviderTurnPrepareResult>;
	sendTurn: (prepared: CursorProviderTurnPrepareResult) => Promise<CursorProviderTurnSendResult>;
	sdkEventDebug?: Pick<CursorSdkEventDebugSink, "recordProviderEvent">;
}): Promise<{ prepared: CursorProviderTurnPrepareResult; sendResult: CursorProviderTurnSendResult }> {
	const prepared = await params.prepareTurn();
	try {
		return { prepared, sendResult: await params.sendTurn(prepared) };
	} catch (error) {
		if (!shouldRetryStalePooledCursorAuth(prepared, error)) throw error;
		try {
			params.sdkEventDebug?.recordProviderEvent("pooled_agent_unauthenticated_retry", {
				sendPlanReason: prepared.meta.sendPlan.reason,
			});
		} catch {
			// Debug capture is optional and must never change provider execution.
		}
		await discardPreparedTurnForStalePooledAuthRetry(prepared);
		const retried = await params.prepareTurn();
		return { prepared: retried, sendResult: await params.sendTurn(retried) };
	}
}
