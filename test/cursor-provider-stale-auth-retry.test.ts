import { AuthenticationError } from "@cursor/sdk";
import type { LocalAgentStore, SDKAgent } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { prepareAndSendCursorTurnRetryingStaleAuth } from "../src/cursor-provider-stale-auth-retry.js";
import type { CursorLiveRun } from "../src/cursor-live-run-coordinator.js";
import type { CursorProviderTurnSendResult, LocalCursorProviderTurnPrepareResult } from "../src/cursor-provider-turn-types.js";
import type { SessionCursorAgentLease } from "../src/cursor-session-agent.js";
import { makeUnauthenticatedConnectError } from "./helpers/cursor-unauthenticated-connect-error.js";

const { mockReleaseLiveRun } = vi.hoisted(() => ({
	mockReleaseLiveRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/cursor-provider-live-run-drain.js", () => ({
	cursorLiveRuns: {
		release: mockReleaseLiveRun,
	},
}));

function makeLocalPreparedTurn(options: {
	created: boolean;
	resumed?: boolean;
	liveRun?: CursorLiveRun;
}): LocalCursorProviderTurnPrepareResult {
	const { created, resumed = false, liveRun } = options;
	const abandon = vi.fn().mockResolvedValue(undefined);
	const restoreCursorSdkOutputFilter = vi.fn();
	const turnCoordinator = {} as LocalCursorProviderTurnPrepareResult["runtime"]["turnCoordinator"];
	return {
		runtimeTarget: "local",
		agent: { agentId: "agent-1" } as SDKAgent,
		cwd: process.cwd(),
		payload: { text: "hello" },
		meta: {
			sendPlan: { mode: "incremental", reason: "incremental", resetAgent: false },
			prompt: { text: "hello", images: [] },
			bootstrap: false,
			promptInputTokens: 0,
			useNativeToolReplay: false,
			bridgeEnabled: false,
			nativeReplayId: "replay-1",
			agentMode: "agent",
			modelSelection: { id: "composer-2.5" },
		},
		localForce: { value: false, source: "builtin", trustLevel: "builtin" },
		contextWindowAgentId: "agent-1",
		textDeltas: [],
		sessionAgentScopeKey: "scope-1",
		sessionAgentLease: {
			scopeKey: "scope-1",
			poolKey: "pool-1",
			instanceId: 1,
			agent: { agentId: "agent-1" } as SDKAgent,
			store: {} as LocalAgentStore,
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 1 },
			created,
			resumed,
			commitSend: () => {},
			trackRunCompletion: () => {},
		} satisfies SessionCursorAgentLease,
		restoreCursorSdkOutputFilter,
		lifecycle: {
			commitSend: () => {},
			trackRunCompletion: () => {},
			abandon,
			dispose: async () => {},
		},
		runtime: liveRun
			? { kind: "live", liveRun, turnCoordinator }
			: { kind: "direct", turnCoordinator },
	};
}

function makeSendResult(): CursorProviderTurnSendResult {
	return {
		send: { run: { id: "run-2" }, cursorAgentMessageOffset: undefined },
		abortRegistration: undefined,
	} as CursorProviderTurnSendResult;
}

describe("stale local Cursor auth retry", () => {
	it.each([
		["unauthenticated ConnectError", () => makeUnauthenticatedConnectError()],
		["AuthenticationError", () => new AuthenticationError("expired token")],
	])("recreates a reused pooled agent after %s on send", async (_name, makeError) => {
		const reused = makeLocalPreparedTurn({ created: false });
		const recreated = makeLocalPreparedTurn({ created: true });
		const sendResult = makeSendResult();
		const prepareTurn = vi.fn().mockResolvedValueOnce(reused).mockResolvedValueOnce(recreated);
		const sendTurn = vi.fn().mockRejectedValueOnce(makeError()).mockResolvedValueOnce(sendResult);

		const result = await prepareAndSendCursorTurnRetryingStaleAuth({ prepareTurn, sendTurn });

		expect(result.prepared).toBe(recreated);
		expect(result.sendResult).toBe(sendResult);
		expect(prepareTurn).toHaveBeenCalledTimes(2);
		expect(prepareTurn).toHaveBeenNthCalledWith(2, { forceCreate: true });
		expect(sendTurn).toHaveBeenCalledTimes(2);
		expect(reused.lifecycle.abandon).toHaveBeenCalledTimes(1);
		expect(reused.restoreCursorSdkOutputFilter).toHaveBeenCalledTimes(1);
	});

	it("does not recreate a freshly created agent on unauthenticated send", async () => {
		const fresh = makeLocalPreparedTurn({ created: true });
		const error = makeUnauthenticatedConnectError();
		const sendTurn = vi.fn().mockRejectedValue(error);

		await expect(
			prepareAndSendCursorTurnRetryingStaleAuth({
				prepareTurn: async () => fresh,
				sendTurn,
			}),
		).rejects.toBe(error);
		expect(sendTurn).toHaveBeenCalledTimes(1);
		expect(fresh.lifecycle.abandon).not.toHaveBeenCalled();
	});

	it("recreates a resumed local agent after unauthenticated send", async () => {
		const resumed = makeLocalPreparedTurn({ created: true, resumed: true });
		const recreated = makeLocalPreparedTurn({ created: true });
		const sendResult = makeSendResult();
		const prepareTurn = vi.fn().mockResolvedValueOnce(resumed).mockResolvedValueOnce(recreated);
		const sendTurn = vi.fn().mockRejectedValueOnce(makeUnauthenticatedConnectError()).mockResolvedValueOnce(sendResult);

		const result = await prepareAndSendCursorTurnRetryingStaleAuth({ prepareTurn, sendTurn });

		expect(result.prepared).toBe(recreated);
		expect(result.sendResult).toBe(sendResult);
		expect(prepareTurn).toHaveBeenNthCalledWith(2, { forceCreate: true });
		expect(resumed.lifecycle.abandon).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-auth send failure on a reused pooled agent", async () => {
		const reused = makeLocalPreparedTurn({ created: false });
		const error = new Error("boom");
		const sendTurn = vi.fn().mockRejectedValue(error);

		await expect(
			prepareAndSendCursorTurnRetryingStaleAuth({
				prepareTurn: async () => reused,
				sendTurn,
			}),
		).rejects.toBe(error);
		expect(sendTurn).toHaveBeenCalledTimes(1);
		expect(reused.lifecycle.abandon).not.toHaveBeenCalled();
	});

	it("releases a prepare-started live run when retrying stale auth", async () => {
		const liveRun = { disposed: false } as CursorLiveRun;
		const reused = makeLocalPreparedTurn({ created: false, liveRun });
		const recreated = makeLocalPreparedTurn({ created: true });
		const sendResult = makeSendResult();
		mockReleaseLiveRun.mockClear();

		const result = await prepareAndSendCursorTurnRetryingStaleAuth({
			prepareTurn: vi.fn().mockResolvedValueOnce(reused).mockResolvedValueOnce(recreated),
			sendTurn: vi.fn().mockRejectedValueOnce(makeUnauthenticatedConnectError()).mockResolvedValueOnce(sendResult),
		});

		expect(result.prepared).toBe(recreated);
		expect(mockReleaseLiveRun).toHaveBeenCalledWith(liveRun);
		expect(reused.lifecycle.abandon).not.toHaveBeenCalled();
		expect(reused.restoreCursorSdkOutputFilter).toHaveBeenCalledTimes(1);
	});
});
