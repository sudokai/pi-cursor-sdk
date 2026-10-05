import {
	CursorStaleLocalAuthRetryError,
	isCursorSdkAuthenticationFailureMessage,
	isCursorSdkUnauthenticatedFailure,
} from "./cursor-provider-errors.js";
import type { CursorRunOutcome } from "./cursor-provider-run-outcome.js";
import type { CursorProviderTurnPrepareResult } from "./cursor-provider-turn-types.js";

/**
 * Reused pooled agents (`created === false`) and `Agent.resume()` leases
 * (`resumed === true`) can recover from idle unauthenticated failures by
 * recreating. Fresh `Agent.create()` failures cannot.
 */
export function isStaleAuthRetryEligibleLease(prepared: CursorProviderTurnPrepareResult): boolean {
	if (prepared.runtimeTarget !== "local" || prepared.execution !== "conversation") return false;
	return prepared.sessionAgentLease.created === false || prepared.sessionAgentLease.resumed === true;
}

/**
 * True when a local Cursor session agent failed send or wait as unauthenticated after idle
 * (expired access token / stale transport) and recreating can still help.
 * `run.wait()` unauthenticated is retried only when drain/finalize reports no
 * user-visible output (`CursorStaleLocalAuthRetryError` or an auth guidance outcome).
 */
/** Checks whether an eligible reused local conversation agent failed authentication. */
export function shouldRetryStaleLocalAuthFailure(
	prepared: CursorProviderTurnPrepareResult,
	error: unknown,
	hasVisibleOutput = false,
): boolean {
	if (hasVisibleOutput || !isStaleAuthRetryEligibleLease(prepared)) return false;
	return isCursorSdkUnauthenticatedFailure(error) || error instanceof CursorStaleLocalAuthRetryError;
}

export function shouldRetryStaleLocalCursorAuthWaitOutcome(
	prepared: CursorProviderTurnPrepareResult,
	outcome: CursorRunOutcome,
	hasVisibleOutput = false,
): boolean {
	if (!isStaleAuthRetryEligibleLease(prepared) || outcome.kind !== "error") return false;
	if (hasVisibleOutput) return false;
	if (prepared.textDeltas.some((delta) => delta.trim().length > 0)) return false;
	return isCursorSdkAuthenticationFailureMessage(outcome.errorMessage);
}
