import type { SDKAgent } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-config.js";
import { asRecord, getArray, getString } from "./cursor-record-utils.js";
import { readCursorSdkTurnUsage, type CursorSdkTurnUsage } from "./cursor-usage-accounting.js";

const BILLED_USAGE_TIMEOUT_MS = 5000;

type UsageQuery = { runId: string } | undefined;
type UsageRequest = Promise<unknown | undefined>;

// The SDK does not expose cancellation for Agent.getUsage(). Keep one request in
// flight per agent/query so a timed-out call cannot be followed by an overlapping
// uncancellable request. The map is replaced by test reset and otherwise releases
// entries as soon as the SDK promise settles.
let inFlightUsageRequestsByAgent = new WeakMap<SDKAgent, Map<string, UsageRequest>>();

// A process-lifetime watermark is still useful between turns. It is deliberately
// supplemented by primeCursorBilledUsageBaseline() before every local send so a
// restarted/resumed process marks historical rows before selecting new usage.
const seenBilledRunIdsByAgent = new Map<string, Set<string>>();

export function isCursorSdkClientMintedRunId(runId: string): boolean {
	return runId.startsWith("run-");
}

export function sumCursorSdkTurnUsage(usages: readonly CursorSdkTurnUsage[]): CursorSdkTurnUsage | undefined {
	if (usages.length === 0) return undefined;
	return usages.reduce(
		(total, usage) => ({
			inputTokens: total.inputTokens + usage.inputTokens,
			outputTokens: total.outputTokens + usage.outputTokens,
			cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
			cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
		}),
	);
}

export function peekCursorBilledUsageRunIds(agentId: string): ReadonlySet<string> {
	return seenBilledRunIdsByAgent.get(agentId) ?? new Set();
}

export function rememberCursorBilledUsageRunIds(agentId: string, runIds: readonly string[]): void {
	if (runIds.length === 0) return;
	let seen = seenBilledRunIdsByAgent.get(agentId);
	if (!seen) {
		seen = new Set();
		seenBilledRunIdsByAgent.set(agentId, seen);
	}
	for (const runId of runIds) seen.add(runId);
}

function usageQueryKey(query: UsageQuery): string {
	return query?.runId ? `run:${query.runId}` : "all";
}

function getOrStartUsageRequest(agent: SDKAgent, query: UsageQuery): UsageRequest {
	let requests = inFlightUsageRequestsByAgent.get(agent);
	if (!requests) {
		requests = new Map();
		inFlightUsageRequestsByAgent.set(agent, requests);
	}
	const key = usageQueryKey(query);
	const existing = requests.get(key);
	if (existing) return existing;

	const request = Promise.resolve()
		.then(() => agent.getUsage(query))
		.catch(() => undefined)
		.finally(() => {
			if (requests?.get(key) === request) requests.delete(key);
		});
	requests.set(key, request);
	return request;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = BILLED_USAGE_TIMEOUT_MS): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export function selectCursorBilledTurnUsage(
	agentUsage: unknown,
	options: { runtime: CursorRuntime; runId?: string; seenRunIds?: ReadonlySet<string> },
): { turn?: CursorSdkTurnUsage; runIds: string[] } {
	const runs = (getArray(asRecord(agentUsage), "runs") ?? []).flatMap((item) => {
		const record = asRecord(item);
		const runId = getString(record, "runId");
		const usage = readCursorSdkTurnUsage(record?.usage);
		return runId && usage ? [{ runId, usage }] : [];
	});
	if (options.runtime === "cloud" && options.runId) {
		const match = runs.find((run) => run.runId === options.runId);
		return match ? { turn: match.usage, runIds: [match.runId] } : { runIds: [] };
	}
	const unseen = runs.filter((run) => !options.seenRunIds?.has(run.runId));
	return { turn: sumCursorSdkTurnUsage(unseen.map((run) => run.usage)), runIds: unseen.map((run) => run.runId) };
}

export async function fetchCursorSdkAgentUsage(
	agent: SDKAgent,
	options: { runtime: CursorRuntime; runId?: string; timeoutMs?: number },
): Promise<unknown | undefined> {
	if (typeof agent.getUsage !== "function") return undefined;
	const query: UsageQuery =
		options.runtime === "cloud" && options.runId && isCursorSdkClientMintedRunId(options.runId)
			? { runId: options.runId }
			: undefined;
	return withTimeout(getOrStartUsageRequest(agent, query), options.timeoutMs);
}

/**
 * Establish a pre-send local baseline. This makes the process-local watermark
 * safe across restart/resume: all rows visible before the new send are marked
 * seen, so finalization can select only rows created by that send.
 */
export async function primeCursorBilledUsageBaseline(options: {
	agent: SDKAgent;
	agentId: string;
	runtime: CursorRuntime;
}): Promise<boolean> {
	if (options.runtime !== "local") return true;
	if (typeof options.agent.getUsage !== "function") return false;
	const agentUsage = await fetchCursorSdkAgentUsage(options.agent, { runtime: "local" });
	if (agentUsage === undefined) return false;
	const baseline = selectCursorBilledTurnUsage(agentUsage, { runtime: "local" });
	rememberCursorBilledUsageRunIds(options.agentId, baseline.runIds);
	return true;
}

export async function attachCursorSdkBilledTurnUsage(options: {
	agent: SDKAgent;
	agentId: string;
	runtime: CursorRuntime;
	runId?: string;
	/** False means the pre-send baseline failed; do not overcount historical rows. */
	baselineReady?: boolean;
}): Promise<{ agentUsage?: unknown; turn?: CursorSdkTurnUsage; agentUsageAttempted: boolean }> {
	const agentUsageAttempted = typeof options.agent.getUsage === "function";
	const agentUsage = await fetchCursorSdkAgentUsage(options.agent, {
		runtime: options.runtime,
		runId: options.runId,
	});
	if (agentUsage === undefined) return { agentUsageAttempted };
	if (options.runtime === "local" && options.baselineReady === false) {
		return { agentUsage, agentUsageAttempted };
	}
	const selected = selectCursorBilledTurnUsage(agentUsage, {
		runtime: options.runtime,
		runId: options.runtime === "cloud" ? options.runId : undefined,
		seenRunIds: peekCursorBilledUsageRunIds(options.agentId),
	});
	rememberCursorBilledUsageRunIds(options.agentId, selected.runIds);
	return { agentUsage, turn: selected.turn, agentUsageAttempted };
}

export const __testUtils = {
	reset(): void {
		seenBilledRunIdsByAgent.clear();
		inFlightUsageRequestsByAgent = new WeakMap();
	},
};
