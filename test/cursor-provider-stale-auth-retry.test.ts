import { describe, expect, it } from "vitest";
import { AUTH_CURSOR_SDK_ERROR_MESSAGE, CursorStaleLocalAuthRetryError } from "../src/cursor-provider-errors.js";
import {
	isStaleAuthRetryEligibleLease,
	shouldRetryStaleLocalAuthFailure,
	shouldRetryStaleLocalCursorAuthWaitOutcome,
} from "../src/cursor-provider-stale-auth-retry.js";
import type { CursorRunOutcome } from "../src/cursor-provider-run-outcome.js";
import type { CursorProviderTurnPrepareResult } from "../src/cursor-provider-turn-types.js";

function preparedTurn(options: {
	runtimeTarget?: "local" | "cloud";
	execution?: "conversation" | "summary";
	created?: boolean;
	resumed?: boolean;
	textDeltas?: string[];
} = {}): CursorProviderTurnPrepareResult {
	const { runtimeTarget = "local", execution = "conversation", created = false, resumed = false, textDeltas = [] } = options;
	return {
		runtimeTarget,
		execution,
		sessionAgentLease: runtimeTarget === "local" && execution === "conversation" ? { created, resumed } : undefined,
		textDeltas,
	} as unknown as CursorProviderTurnPrepareResult;
}

function authOutcome(): CursorRunOutcome {
	return {
		kind: "error",
		errorMessage: AUTH_CURSOR_SDK_ERROR_MESSAGE,
		incompleteTools: { reason: "sdk-failure", assistantTextProduced: false },
		waitResult: { status: "error" },
	} as CursorRunOutcome;
}

describe("stale local Cursor auth retry eligibility", () => {
	it.each([
		["a reused pooled agent", { created: false, resumed: false }, true],
		["a resumed agent", { created: true, resumed: true }, true],
		["a fresh agent", { created: true, resumed: false }, false],
		["a Cloud turn", { runtimeTarget: "cloud" as const }, false],
		["a summary turn", { execution: "summary" as const }, false],
	])("recognizes %s", (_label, options, expected) => {
		expect(isStaleAuthRetryEligibleLease(preparedTurn(options))).toBe(expected);
	});

	it("retries an auth wait outcome only when no user-visible text was emitted", () => {
		expect(shouldRetryStaleLocalCursorAuthWaitOutcome(preparedTurn(), authOutcome())).toBe(true);
		expect(shouldRetryStaleLocalCursorAuthWaitOutcome(preparedTurn({ textDeltas: ["visible answer"] }), authOutcome())).toBe(false);
		expect(shouldRetryStaleLocalCursorAuthWaitOutcome(preparedTurn(), authOutcome(), true)).toBe(false);
	});

	it("retries a thrown auth failure only before visible output", () => {
		const error = new CursorStaleLocalAuthRetryError();
		expect(shouldRetryStaleLocalAuthFailure(preparedTurn(), error)).toBe(true);
		expect(shouldRetryStaleLocalAuthFailure(preparedTurn(), error, true)).toBe(false);
	});
});
