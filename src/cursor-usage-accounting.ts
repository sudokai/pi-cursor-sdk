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
 * Raw SDK turn-ended usage fields.
 *
 * IMPORTANT: the Cursor SDK `turn-ended` event reports `inputTokens` as the total prompt tokens
 * (regular input + cache read), NOT regular input alone.  `cacheReadTokens` is a separate field
 * that overlaps with `inputTokens`.  Do NOT sum all four fields for totalTokens — that
 * double-counts cache read.  Use `inputTokens + outputTokens + cacheWriteTokens` for the
 * true total (or equivalently split input: `(inputTokens - cacheReadTokens) + outputTokens +
 * cacheReadTokens + cacheWriteTokens`).
 */
export interface CursorSdkTurnUsage {
	/** Total prompt tokens (regular input + cacheRead).  Does NOT include cacheWriteTokens. */
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

export function isCursorSdkUsageSafeForPiMessage(turnUsage: CursorSdkTurnUsage, model: Model<Api>): boolean {
	// All SDK fields must be finite and non-negative.
	const counts = [turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens, turnUsage.cacheWriteTokens];
	// cacheReadTokens is already included in inputTokens (per the CursorSdkTurnUsage contract);
	// the true total is input + output + cacheWrite (no separate cacheRead add).
	const trueTotal = turnUsage.inputTokens + turnUsage.outputTokens + turnUsage.cacheWriteTokens;
	return (
		counts.every((count) => Number.isFinite(count) && count >= 0) &&
		turnUsage.outputTokens <= model.maxTokens &&
		trueTotal <= model.contextWindow
	);
}

export function applyCursorSdkUsage(partial: AssistantMessage, turnUsage: CursorSdkTurnUsage): void {
	// SDK inputTokens = regular input + cacheRead (see CursorSdkTurnUsage doc).
	// Subtract cacheRead to get the actual billed input tokens, then re-sum for the true total.
	const actualInput = Math.max(0, turnUsage.inputTokens - turnUsage.cacheReadTokens);
	partial.usage.input = actualInput;
	partial.usage.output = turnUsage.outputTokens;
	partial.usage.cacheRead = turnUsage.cacheReadTokens;
	partial.usage.cacheWrite = turnUsage.cacheWriteTokens;
	partial.usage.totalTokens = actualInput + turnUsage.outputTokens + turnUsage.cacheReadTokens + turnUsage.cacheWriteTokens;
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
	);
}

export function applyCursorUsage(
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	sessionInputTokens: number,
	sdkUsage?: { turn?: CursorSdkTurnUsage },
): void {
	const usage = sdkUsage?.turn;
	if (usage && isCursorSdkUsageSafeForPiMessage(usage, model)) {
		applyCursorSdkUsage(partial, usage);
		return;
	}
	applyCursorApproximateUsage(partial, model, context, sessionInputTokens);
}
