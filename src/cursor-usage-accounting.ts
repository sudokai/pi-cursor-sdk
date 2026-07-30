import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai/compat";
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
 * - The SDK emits one `turn-ended` per agent run. For multi-invocation runs those
 *   fields are a billing sum, which is valid spend but never context occupancy.
 * - The SDK's published `totalTokens` transform double-counts cache; do not copy it.
 * - Pi stores uncached input and cache fields as disjoint spend components.
 * - Occupancy (`usage.totalTokens`) is always a local context estimate, floored at
 *   the last accepted compatible in-window assistant occupancy.
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

function isCompatibleCursorAssistantMeasurement(assistant: AssistantMessage, model: Model<Api>): boolean {
	return assistant.api === model.api && assistant.provider === model.provider && assistant.model === model.id;
}

function getLastAcceptedContextOccupancy(context: Context, model: Model<Api>): number {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role !== "assistant" || !("usage" in message)) continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) continue;
		if (!isCompatibleCursorAssistantMeasurement(assistant, model)) continue;
		const { usage } = assistant;
		const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (Number.isFinite(total) && total > 0 && total <= model.contextWindow) return total;
	}
	return 0;
}

/** Context occupancy for compaction; SDK billing never sets it. */
export function resolveCursorOccupancyTokens(partial: AssistantMessage, model: Model<Api>, context: Context): number {
	return Math.max(estimateCursorContextTotalTokens(partial, model, context), getLastAcceptedContextOccupancy(context, model));
}

/** Map local SDK spend onto pi while keeping occupancy a local estimate. */
export function applyCursorSdkUsage(
	partial: AssistantMessage,
	turnUsage: CursorSdkTurnUsage,
	model: Model<Api>,
	context: Context,
): void {
	partial.usage.input = getCursorSdkUncachedInputTokens(turnUsage);
	partial.usage.output = turnUsage.outputTokens;
	partial.usage.cacheRead = turnUsage.cacheReadTokens;
	partial.usage.cacheWrite = turnUsage.cacheWriteTokens;
	partial.usage.totalTokens = resolveCursorOccupancyTokens(partial, model, context);
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
	sdkUsage?: { runtime: CursorRuntime; turn?: CursorSdkTurnUsage },
): void {
	// Cloud raw usage remains display-only until its field semantics are independently observed.
	const usage = sdkUsage?.runtime === "local" ? sdkUsage.turn : undefined;
	if (usage && isCursorSdkUsageStructurallyValid(usage)) {
		applyCursorSdkUsage(partial, usage, model, context);
		return;
	}
	applyCursorApproximateUsage(partial, model, context, sessionInputTokens);
}
