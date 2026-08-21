import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import {
	CURSOR_APPROX_CHARS_PER_TOKEN,
	CURSOR_IMAGE_TOKEN_ESTIMATE,
	estimateCursorContextTokens,
	estimateCursorTextTokens,
	type CursorPromptOptions,
} from "./context.js";
import { asRecord, getNumber } from "./cursor-record-utils.js";
import type { CursorRuntime } from "./cursor-config.js";

export interface CursorUsagePromptOptions extends CursorPromptOptions {
	maxInputTokens: number;
	charsPerToken: number;
	imageTokenEstimate: number;
}

/**
 * Raw SDK `turn-ended` usage fields.
 *
 * Contract (verified against @cursor/sdk 1.0.23 and the Cursor usage-events CSV):
 * - For a single model invocation, `inputTokens` is the full prompt size and
 *   `cacheReadTokens` / `cacheWriteTokens` partition it.
 * - The SDK emits one `turn-ended` per agent run. For multi-invocation runs
 *   those fields are a billing sum, which is valid spend but never context
 *   occupancy.
 * - The SDK's published `totalTokens` transform double-counts cache; do not
 *   copy it.
 * - Pi stores uncached input and cache fields as disjoint spend components.
 * - Occupancy (`usage.totalTokens`) is always a replayable local context estimate,
 *   floored at the last accepted compatible in-window assistant occupancy. The
 *   turn-ended aggregate is never a per-invocation occupancy measurement.
 */
export interface CursorSdkTurnUsage {
	/** Full prompt tokens for one invocation, or the summed full-prompt tokens across a run. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

function getPromptInputTokenBudget(model: Model<Api>): number {
	const outputReserveTokens = Math.min(model.maxTokens, Math.max(1, Math.floor(model.contextWindow * 0.2)));
	return Math.max(1, model.contextWindow - outputReserveTokens);
}

export function getCursorPromptOptions(model: Model<Api>): CursorUsagePromptOptions {
	return {
		maxInputTokens: getPromptInputTokenBudget(model),
		charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN,
		imageTokenEstimate: CURSOR_IMAGE_TOKEN_ESTIMATE,
	};
}

function getNonNegativeTokenCount(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = getNumber(record, key);
	return value === undefined || value < 0 ? undefined : Math.floor(value);
}

export function readCursorSdkTurnUsage(value: unknown): CursorSdkTurnUsage | undefined {
	const record = asRecord(value);
	const inputTokens = getNonNegativeTokenCount(record, "inputTokens");
	const outputTokens = getNonNegativeTokenCount(record, "outputTokens");
	const cacheReadTokens = getNonNegativeTokenCount(record, "cacheReadTokens");
	const cacheWriteTokens = getNonNegativeTokenCount(record, "cacheWriteTokens");
	if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined;
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export function readCursorSdkTurnUsageFromUpdate(update: unknown): CursorSdkTurnUsage | undefined {
	const record = asRecord(update);
	return record?.type === "turn-ended" ? readCursorSdkTurnUsage(record.usage) : undefined;
}

function stringifyUsageValue(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

export function estimateCursorAssistantSessionOutputTokens(message: AssistantMessage): number {
	const parts = message.content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			if (block.type === "toolCall") {
				return `Tool call (${block.name}, call ${block.id}): ${stringifyUsageValue(block.arguments)}`;
			}
			return "";
		})
		.filter(Boolean);
	return estimateCursorTextTokens(parts.join("\n"), { charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN });
}

function withAssistantMessage(context: Context, partial: AssistantMessage): Context {
	return { ...context, messages: [...context.messages, partial] };
}

export function estimateCursorContextTotalTokens(partial: AssistantMessage, model: Model<Api>, context: Context): number {
	return estimateCursorContextTokens(withAssistantMessage(context, partial), getCursorPromptOptions(model));
}

function getCursorSdkUncachedInputTokens(turnUsage: CursorSdkTurnUsage): number {
	return turnUsage.inputTokens - turnUsage.cacheReadTokens - turnUsage.cacheWriteTokens;
}

/** Cursor usage-events CSV billing total; spend only, never context occupancy. */
export function getCursorSdkBillingTotalTokens(turnUsage: CursorSdkTurnUsage): number {
	return turnUsage.inputTokens + turnUsage.outputTokens;
}

/** Whether SDK usage has a structurally valid non-negative cache partition. */
export function isCursorSdkUsageStructurallyValid(turnUsage: CursorSdkTurnUsage): boolean {
	const counts = [turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens, turnUsage.cacheWriteTokens];
	const uncachedInput = getCursorSdkUncachedInputTokens(turnUsage);
	return counts.every((count) => Number.isFinite(count) && count >= 0) && Number.isFinite(uncachedInput) && uncachedInput >= 0;
}

/** Whether SDK usage can safely populate pi spend fields. */
export function isCursorSdkUsagePartitionSafe(turnUsage: CursorSdkTurnUsage): boolean {
	return isCursorSdkUsageStructurallyValid(turnUsage);
}

export interface CursorSdkUsageApplyOptions {
	runtime: CursorRuntime;
	turn?: CursorSdkTurnUsage;
	billed?: CursorSdkTurnUsage;
}

export interface CursorSdkUsageCarrier {
	cursorSdk?: CursorSdkTurnUsage;
}

function isCompatibleCursorAssistantMeasurement(assistant: AssistantMessage, model: Model<Api>): boolean {
	return assistant.api === model.api && assistant.provider === model.provider && assistant.model === model.id;
}

function getLatestCompactionBoundary(context: Context): { index: number; tokensBefore?: number } | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index] as { role?: string; tokensBefore?: number };
		if (message.role !== "compactionSummary") continue;
		const tokensBefore = message.tokensBefore;
		return {
			index,
			tokensBefore: Number.isFinite(tokensBefore) && tokensBefore !== undefined && tokensBefore > 0 ? Math.floor(tokensBefore) : undefined,
		};
	}
	return undefined;
}

function getLastAcceptedContextOccupancy(context: Context, model: Model<Api>): number {
	const boundary = getLatestCompactionBoundary(context);
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		if (boundary && index < boundary.index) break;
		const message = context.messages[index];
		if (message.role !== "assistant" || !("usage" in message)) continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) continue;
		if (!isCompatibleCursorAssistantMeasurement(assistant, model)) continue;
		const { usage } = assistant;
		const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (!Number.isFinite(total) || total <= 0 || total > model.contextWindow) continue;
		if (boundary?.tokensBefore !== undefined && total >= boundary.tokensBefore) continue;
		return total;
	}
	return 0;
}

/** Context occupancy for compaction; SDK billing never sets it. */
export function resolveCursorOccupancyTokens(partial: AssistantMessage, model: Model<Api>, context: Context): number {
	return Math.max(estimateCursorContextTotalTokens(partial, model, context), getLastAcceptedContextOccupancy(context, model));
}

/**
 * Project either raw local or verified billed SDK spend onto pi. Both sources
 * use the same overflow-safe pi fields and preserve the exact SDK partition on
 * the host-ignored carrier; occupancy stays a replayable context estimate.
 */
function applyCursorSdkUsageProjection(
	partial: AssistantMessage,
	turnUsage: CursorSdkTurnUsage,
	model: Model<Api>,
	context: Context,
): void {
	const maxInputTokens = getCursorPromptOptions(model).maxInputTokens;
	partial.usage.input = Math.min(getCursorSdkUncachedInputTokens(turnUsage), maxInputTokens);
	partial.usage.output = turnUsage.outputTokens;
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	partial.usage.totalTokens = resolveCursorOccupancyTokens(partial, model, context);
	(partial.usage as Usage & CursorSdkUsageCarrier).cursorSdk = {
		inputTokens: turnUsage.inputTokens,
		outputTokens: turnUsage.outputTokens,
		cacheReadTokens: turnUsage.cacheReadTokens,
		cacheWriteTokens: turnUsage.cacheWriteTokens,
	};
}

/** Map raw local SDK spend onto pi while keeping occupancy safe. */
export function applyCursorSdkUsage(
	partial: AssistantMessage,
	turnUsage: CursorSdkTurnUsage,
	model: Model<Api>,
	context: Context,
): void {
	applyCursorSdkUsageProjection(partial, turnUsage, model, context);
}

/** Map a verified Agent.getUsage() billed row onto pi without exposing billing sums to pi-ai. */
export function applyCursorSdkBilledUsage(
	partial: AssistantMessage,
	turnUsage: CursorSdkTurnUsage,
	model: Model<Api>,
	context: Context,
): void {
	applyCursorSdkUsageProjection(partial, turnUsage, model, context);
}

export function applyCursorApproximateUsage(partial: AssistantMessage, model: Model<Api>, context: Context, sessionInputTokens: number): void {
	const outputTokens = estimateCursorAssistantSessionOutputTokens(partial);
	partial.usage.input = Math.max(0, sessionInputTokens);
	partial.usage.output = outputTokens;
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	partial.usage.totalTokens = Math.max(
		partial.usage.input + partial.usage.output,
		estimateCursorContextTotalTokens(partial, model, context),
		getLastAcceptedContextOccupancy(context, model),
	);
}

export function applyCursorUsage(
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	sessionInputTokens: number,
	sdkUsage?: CursorSdkUsageApplyOptions,
): void {
	const billed = sdkUsage?.billed;
	const localTurn = sdkUsage?.runtime === "local" ? sdkUsage.turn : undefined;
	if (billed && isCursorSdkUsagePartitionSafe(billed)) {
		applyCursorSdkBilledUsage(partial, billed, model, context);
		return;
	}
	// Cloud raw usage remains display-only until its field semantics are independently observed.
	if (localTurn && isCursorSdkUsageStructurallyValid(localTurn)) {
		applyCursorSdkUsage(partial, localTurn, model, context);
		return;
	}
	applyCursorApproximateUsage(partial, model, context, sessionInputTokens);
}
