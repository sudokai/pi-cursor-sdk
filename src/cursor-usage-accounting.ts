import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai/compat";
import {
	CURSOR_APPROX_CHARS_PER_TOKEN,
	CURSOR_IMAGE_TOKEN_ESTIMATE,
	estimateCursorContextTokens,
	estimateCursorTextTokens,
	type CursorPromptOptions,
} from "./context.js";
import { asRecord, getNumber } from "./cursor-record-utils.js";

export interface CursorUsagePromptOptions extends CursorPromptOptions {
	maxInputTokens: number;
	charsPerToken: number;
	imageTokenEstimate: number;
}

/**
 * Raw SDK `turn-ended` usage fields.
 *
 * Contract (verified against @cursor/sdk 1.0.23 and the Cursor usage-events CSV):
 * - For a **single** model invocation, `inputTokens` is the FULL prompt size (it includes
 *   `cacheReadTokens` / `cacheWriteTokens` as a partition, not an additive extra).
 * - The SDK emits one `turn-ended` per agent **run**. When the run makes multiple model
 *   invocations (`onStep` `assistantMessage` count ≥ 2), those fields are a **billing sum**
 *   across invocations (same totals as the Cursor usage-events CSV). That sum is valid spend
 *   (↑/↓/R/CH) but is **not** context occupancy for the footer or compaction — do not store it
 *   as `usage.totalTokens` when `modelInvocationCount >= 2`.
 * - The SDK's own `totalTokens` field additionally double-counts cache
 *   (`input+output+cacheRead+cacheWrite`); never copy it into pi.
 * - pi models `usage.input` / `cacheRead` / `cacheWrite` as disjoint additive prompt components,
 *   so `applyCursorSdkUsage` stores the uncached share as `input` (`inputTokens - cacheRead -
 *   cacheWrite`) and keeps the cache fields separately. Occupancy (`usage.totalTokens`) uses
 *   `inputTokens + outputTokens` only for single-invocation runs; multi-invocation runs keep
 *   SDK spend fields but estimate occupancy (see `resolveCursorSdkOccupancyTokens`).
 */
export interface CursorSdkTurnUsage {
	/** Full prompt tokens for one invocation, or the summed full-prompt tokens across a multi-invocation run. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/**
 * Count of SDK `onStep` `assistantMessage` events for the run that produced usage.
 * This is the model invocation count used to detect multi-invocation billing aggregates.
 */
export type CursorSdkModelInvocationCount = number;

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
	// SDK inputTokens is the full prompt (or summed full prompts); cache fields partition it.
	return turnUsage.inputTokens - turnUsage.cacheReadTokens - turnUsage.cacheWriteTokens;
}

/**
 * Cursor usage-events CSV Total Tokens for a turn: full prompt (`inputTokens`) plus output.
 * This is billing spend, not context occupancy, when the run had multiple model invocations.
 */
export function getCursorSdkBillingTotalTokens(turnUsage: CursorSdkTurnUsage): number {
	return turnUsage.inputTokens + turnUsage.outputTokens;
}

/**
 * Whether SDK usage is safe to attribute as spend on a pi assistant message.
 * Rejects non-finite/negative fields, invalid cache partitions, and run aggregates that cannot
 * fit in the selected model window (full-agent cumulative poison).
 */
export function isCursorSdkUsageSafeForPiMessage(turnUsage: CursorSdkTurnUsage, model: Model<Api>): boolean {
	const counts = [turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens, turnUsage.cacheWriteTokens];
	const uncachedInput = getCursorSdkUncachedInputTokens(turnUsage);
	return (
		counts.every((count) => Number.isFinite(count) && count >= 0) &&
		Number.isFinite(uncachedInput) &&
		uncachedInput >= 0 &&
		turnUsage.outputTokens <= model.maxTokens &&
		getCursorSdkBillingTotalTokens(turnUsage) <= model.contextWindow
	);
}

/**
 * True when the model invocation count is ≥ 2, so `turn-ended` usage is a multi-invocation
 * billing aggregate rather than one prompt's context occupancy.
 * `0`/`undefined` means steps were not observed — treat as a single model invocation.
 */
export function isCursorSdkUsageMultiInvocation(modelInvocationCount: CursorSdkModelInvocationCount | undefined): boolean {
	return typeof modelInvocationCount === "number" && Number.isFinite(modelInvocationCount) && modelInvocationCount >= 2;
}

/**
 * Resolve context occupancy tokens for the footer and compaction percentage.
 * Single model invocation: SDK billing total (full prompt + output).
 * Multiple model invocations: max of replayable estimate, last accepted occupancy, and
 * per-invocation mean of the billing sum (ceil) — never the raw multi-call billing sum.
 */
export function resolveCursorSdkOccupancyTokens(
	partial: AssistantMessage,
	turnUsage: CursorSdkTurnUsage,
	model: Model<Api>,
	context: Context,
	modelInvocationCount?: CursorSdkModelInvocationCount,
): number {
	const billingTotal = getCursorSdkBillingTotalTokens(turnUsage);
	if (!isCursorSdkUsageMultiInvocation(modelInvocationCount) || modelInvocationCount === undefined) {
		return billingTotal;
	}
	const invocationCount = Math.floor(modelInvocationCount);
	return Math.max(
		estimateCursorContextTotalTokens(partial, model, context),
		getLastAcceptedContextOccupancy(context),
		Math.ceil(billingTotal / invocationCount),
	);
}

/**
 * Map SDK turn usage onto a pi assistant message: spend fields always, context occupancy via
 * `resolveCursorSdkOccupancyTokens` when model/context options are provided.
 */
export function applyCursorSdkUsage(
	partial: AssistantMessage,
	turnUsage: CursorSdkTurnUsage,
	options?: { model: Model<Api>; context: Context; modelInvocationCount?: CursorSdkModelInvocationCount },
): void {
	// Pi treats input/cacheRead/cacheWrite as disjoint additive prompt components (spend).
	partial.usage.input = getCursorSdkUncachedInputTokens(turnUsage);
	partial.usage.output = turnUsage.outputTokens;
	partial.usage.cacheRead = turnUsage.cacheReadTokens;
	partial.usage.cacheWrite = turnUsage.cacheWriteTokens;
	partial.usage.totalTokens = options
		? resolveCursorSdkOccupancyTokens(partial, turnUsage, options.model, options.context, options.modelInvocationCount)
		: getCursorSdkBillingTotalTokens(turnUsage);
}

function getLastAcceptedContextOccupancy(context: Context): number {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role !== "assistant" || !("usage" in message)) continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) continue;
		const { usage } = assistant;
		const total =
			usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (Number.isFinite(total) && total > 0) return total;
	}
	return 0;
}

export function applyCursorApproximateUsage(partial: AssistantMessage, model: Model<Api>, context: Context, sessionInputTokens: number): void {
	const outputTokens = estimateCursorAssistantSessionOutputTokens(partial);
	partial.usage.input = Math.max(0, sessionInputTokens);
	partial.usage.output = outputTokens;
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	// Never report less occupancy than the last accepted assistant measurement in this context.
	partial.usage.totalTokens = Math.max(
		partial.usage.input + partial.usage.output,
		estimateCursorContextTotalTokens(partial, model, context),
		getLastAcceptedContextOccupancy(context),
	);
}

export function applyCursorUsage(
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	sessionInputTokens: number,
	sdkUsage?: { turn?: CursorSdkTurnUsage; modelInvocationCount?: CursorSdkModelInvocationCount },
): void {
	const usage = sdkUsage?.turn;
	if (usage && isCursorSdkUsageSafeForPiMessage(usage, model)) {
		applyCursorSdkUsage(partial, usage, {
			model,
			context,
			modelInvocationCount: sdkUsage?.modelInvocationCount,
		});
		return;
	}
	applyCursorApproximateUsage(partial, model, context, sessionInputTokens);
}
