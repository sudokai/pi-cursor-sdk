import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { InteractionUpdateSchema, TurnEndedUpdateSchema } from "@cursor/sdk";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { buildSessionContext, calculateContextTokens, convertToLlm } from "@earendil-works/pi-coding-agent";
import {
	applyCursorApproximateUsage,
	applyCursorUsage,
	estimateCursorAssistantSessionOutputTokens,
	estimateCursorContextTotalTokens,
	getCursorSdkBillingTotalTokens,
	isCursorSdkUsageStructurallyValid,
	readCursorSdkTurnUsage,
	readCursorSdkTurnUsageFromUpdate,
	resolveCursorOccupancyTokens,
	type CursorSdkUsageCarrier,
	type CursorSdkUsageApplyOptions,
} from "../src/cursor-usage-accounting.js";
import { makeContext, makeHarnessModel, makeModel } from "./helpers/pi-harness.js";

// Per-million rates require precision that distinguishes small costs from zero.
const COST_PRECISION = 10;

function makeCostModel(cost: Model<"cursor-sdk">["cost"]): Model<"cursor-sdk"> {
	return makeHarnessModel("cursor", "cursor-sdk", "test-model", { cost });
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-sdk",
		provider: "cursor",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function sdkUsageOf(partial: AssistantMessage): CursorSdkUsageCarrier["cursorSdk"] {
	return (partial.usage as AssistantMessage["usage"] & CursorSdkUsageCarrier).cursorSdk;
}

describe("cursor usage accounting", () => {
	it("counts assistant session output from text, thinking, and tool calls", () => {
		const textOnly = makeAssistantMessage([{ type: "text", text: "Done." }]);
		const withThinking = makeAssistantMessage([
			{ type: "thinking", thinking: "Inspecting the repository." },
			{ type: "text", text: "Done." },
		]);
		const withToolCall = makeAssistantMessage([
			{ type: "text", text: "I will inspect it." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);

		expect(estimateCursorAssistantSessionOutputTokens(textOnly)).toBeGreaterThan(0);
		expect(estimateCursorAssistantSessionOutputTokens(withThinking)).toBeGreaterThan(estimateCursorAssistantSessionOutputTokens(textOnly));
		expect(estimateCursorAssistantSessionOutputTokens(withToolCall)).toBeGreaterThan(estimateCursorAssistantSessionOutputTokens(textOnly));
	});

	it("applies real SDK spend and estimated occupancy for in-window turn-ended usage", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 25_432, outputTokens: 612, cacheReadTokens: 24_000, cacheWriteTokens: 123 },
		});

		expect(partial.usage.input).toBe(25_432 - 24_000 - 123);
		expect(partial.usage.output).toBe(612);
		// SDK turn-ended usage is a billing sum across invocations, never context
		// occupancy: keep the overflow-visible pi fields occupancy-safe and carry
		// real spend on the host-ignored cursorSdk field.
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(sdkUsageOf(partial)).toEqual({
			inputTokens: 25_432,
			outputTokens: 612,
			cacheReadTokens: 24_000,
			cacheWriteTokens: 123,
		});
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).not.toBe(25_432 + 612);
	});

	it("maps SDK cache fields to disjoint pi spend components", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "A" }]);
		// Observed raw local turn-ended.usage (issue #196): inputTokens is full prompt; cache fields partition it.
		// Distinct from published SDK toTokenUsage additive totalTokens (see turn-ended usage contract fixture).
		const turn = {
			inputTokens: 46_965,
			outputTokens: 3,
			cacheReadTokens: 42_036,
			cacheWriteTokens: 4_927,
		};

		expect(isCursorSdkUsageStructurallyValid(turn)).toBe(true);
		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn });
		expect(partial.usage).toMatchObject({
			input: 46_965 - 42_036 - 4_927,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(sdkUsageOf(partial)).toEqual({
			inputTokens: 46_965,
			outputTokens: 3,
			cacheReadTokens: 42_036,
			cacheWriteTokens: 4_927,
		});
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
	});

	it("applies multi-invocation billing spend with estimated occupancy", () => {
		// End-of-run turn-ended may sum multiple model invocations (CSV-aligned billing).
		const model = { ...makeModel(), contextWindow: 200_000, maxTokens: 64_000 };
		const prior = makeAssistantMessage([{ type: "text", text: "Prior single-call turn." }]);
		prior.usage = {
			input: 3_066,
			output: 1_602,
			cacheRead: 59_719,
			cacheWrite: 0,
			totalTokens: 64_387,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				prior,
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Multi-call answer." }]);
		const multiInvocationTurn = {
			inputTokens: 131_743,
			outputTokens: 2_414,
			cacheReadTokens: 127_350,
			cacheWriteTokens: 0,
		};

		expect(getCursorSdkBillingTotalTokens(multiInvocationTurn)).toBe(134_157);

		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: multiInvocationTurn });

		expect(partial.usage).toMatchObject({
			input: 4_393,
			output: 2_414,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(sdkUsageOf(partial)).toEqual({
			inputTokens: 131_743,
			outputTokens: 2_414,
			cacheReadTokens: 127_350,
			cacheWriteTokens: 0,
		});
		expect(partial.usage.input + partial.usage.cacheRead).toBeLessThanOrEqual(model.contextWindow);
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeGreaterThanOrEqual(64_387);
		expect(partial.usage.totalTokens).toBeLessThan(getCursorSdkBillingTotalTokens(multiInvocationTurn));
	});

	it("never uses a below-window local billing aggregate as occupancy", () => {
		const model = { ...makeModel(), contextWindow: 200_000, maxTokens: 64_000 };
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Multi-call answer." }]);
		const localAggregate = {
			inputTokens: 131_743,
			outputTokens: 2_414,
			cacheReadTokens: 127_350,
			cacheWriteTokens: 0,
		};
		const billed = { inputTokens: 80, outputTokens: 12, cacheReadTokens: 60, cacheWriteTokens: 1 };

		expect(localAggregate.inputTokens + localAggregate.outputTokens).toBeLessThan(model.contextWindow);
		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: localAggregate, billed });

		expect(sdkUsageOf(partial)).toEqual(billed);
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).not.toBe(localAggregate.inputTokens + localAggregate.outputTokens);
	});

	it("applies structurally valid multi-invocation spend above the model window", () => {
		const model = { ...makeModel(), contextWindow: 100_000, maxTokens: 16_000 };
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Done." }]);
		const overWindowMulti = {
			inputTokens: 220_000,
			outputTokens: 3_000,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 5_000,
		};

		expect(getCursorSdkBillingTotalTokens(overWindowMulti)).toBeGreaterThan(model.contextWindow);
		expect(isCursorSdkUsageStructurallyValid(overWindowMulti)).toBe(true);

		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: overWindowMulti });

		expect(partial.usage).toMatchObject({
			input: 15_000,
			output: 3_000,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(sdkUsageOf(partial)).toEqual({
			inputTokens: 220_000,
			outputTokens: 3_000,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 5_000,
		});
		expect(partial.usage.input + partial.usage.cacheRead).toBeLessThanOrEqual(model.contextWindow);
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
	});

	it("rejects SDK usage whose cache partition exceeds inputTokens", () => {
		expect(
			isCursorSdkUsageStructurallyValid({
				inputTokens: 100,
				outputTokens: 1,
				cacheReadTokens: 80,
				cacheWriteTokens: 30,
			}),
		).toBe(false);
	});

	it("keeps structural validation separate from model-window occupancy safety", () => {
		const model = makeModel();
		const billingSizedTurn = {
			inputTokens: model.contextWindow + 50_000,
			outputTokens: model.maxTokens + 1_000,
			cacheReadTokens: model.contextWindow,
			cacheWriteTokens: 50_000,
		};

		// Multi-invocation billing can exceed the selected model window; structural validation
		// only protects the spend partition, while occupancy remains separately bounded.
		expect(isCursorSdkUsageStructurallyValid(billingSizedTurn)).toBe(true);
		expect(isCursorSdkUsageStructurallyValid({ ...billingSizedTurn, outputTokens: -1 })).toBe(false);
		expect(isCursorSdkUsageStructurallyValid({ ...billingSizedTurn, cacheWriteTokens: 50_001 })).toBe(false);
	});

	it("applies structurally valid over-window spend and keeps occupancy estimated", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const overWindowUsage = {
			inputTokens: model.contextWindow - 10,
			outputTokens: 11,
			cacheReadTokens: 9,
			cacheWriteTokens: 1,
		};

		expect(isCursorSdkUsageStructurallyValid(overWindowUsage)).toBe(true);
		expect(isCursorSdkUsageStructurallyValid({ ...overWindowUsage, inputTokens: -1 })).toBe(false);
		expect(
			isCursorSdkUsageStructurallyValid({
				inputTokens: Number.NaN,
				outputTokens: 11,
				cacheReadTokens: 9,
				cacheWriteTokens: 1,
			}),
		).toBe(false);

		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: overWindowUsage });

		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(sdkUsageOf(partial)).toMatchObject({ cacheReadTokens: 9, cacheWriteTokens: 1 });
		expect(partial.usage.output).toBe(11);
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
	});

	it("applies full-run-sized SDK spend without poisoning occupancy totals", () => {
		const fixturePath = new URL("./fixtures/cursor-run-usage-compaction-poison.jsonl", import.meta.url);
		const poisonedMessage = readFileSync(fixturePath, "utf8")
			.trim()
			.split(/\r?\n/)
			.map((line) => JSON.parse(line) as { message?: { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } } })
			.find((entry) => entry.message?.usage)?.message?.usage;
		expect(poisonedMessage).toMatchObject({ input: 1_125_429, cacheRead: 1_015_493 });

		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const poisonedSdkUsage = {
			inputTokens: poisonedMessage!.input,
			outputTokens: poisonedMessage!.output,
			cacheReadTokens: poisonedMessage!.cacheRead,
			cacheWriteTokens: poisonedMessage!.cacheWrite,
		};

		expect(isCursorSdkUsageStructurallyValid(poisonedSdkUsage)).toBe(true);

		applyCursorUsage(partial, model, context, 7, { runtime: "local", turn: poisonedSdkUsage });

		// Spend may be large (run billing); occupancy must stay estimate-scale.
		// The large cache-read billing must not leak onto the overflow-visible pi
		// fields (pi-ai treats input+cacheRead as prompt size); it stays on cursorSdk.
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(sdkUsageOf(partial)).toMatchObject({
			cacheReadTokens: poisonedMessage!.cacheRead,
			cacheWriteTokens: poisonedMessage!.cacheWrite,
		});
		expect(partial.usage.input + partial.usage.cacheRead).toBeLessThanOrEqual(model.contextWindow);
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
		expect(partial.usage.totalTokens).toBeLessThan(1_125_429);
	});

	it("reads the installed Cursor SDK turn-ended usage update contract", () => {
		const update = {
			type: "turn-ended",
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 },
		};

		expect(TurnEndedUpdateSchema.safeParse(update).success).toBe(true);
		expect(InteractionUpdateSchema.safeParse(update).success).toBe(true);
		expect(readCursorSdkTurnUsageFromUpdate(update)).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
		// Published SDK toTokenUsage/sumTokenUsage formula only — not the observed raw local turn-ended mapping.
		const sdkBundle = readFileSync(createRequire(import.meta.url).resolve("@cursor/sdk"), "utf8");
		expect(sdkBundle).toMatch(/totalTokens:\w\+\w\+\w\+\w/);
		expect(calculateContextTokens({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		})).toBe(10);
		expect(readCursorSdkTurnUsage({ inputTokens: -1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBeUndefined();
		expect(readCursorSdkTurnUsage({ inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBeUndefined();
		expect(InteractionUpdateSchema.safeParse({
			type: "usage",
			usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, totalTokens: 11 },
		}).success).toBe(false);
	});

	it("ignores returned RunResult usage for pi context totals when turn usage is absent", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7);

		expect(partial.usage.input).toBe(7);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeLessThan(1_125_429);
	});

	it("uses turn-ended spend when present with estimated occupancy", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 },
		});

		expect(partial.usage).toMatchObject({ input: 0, output: 6, cacheRead: 0, cacheWrite: 0 });
		expect(sdkUsageOf(partial)).toEqual({
			inputTokens: 25,
			outputTokens: 6,
			cacheReadTokens: 24,
			cacheWriteTokens: 1,
		});
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
	});

	it("keeps cloud raw turn-ended usage display-only and falls back to approximate spend", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const cloudTurn = { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 };

		expect(isCursorSdkUsageStructurallyValid(cloudTurn)).toBe(true);
		applyCursorUsage(partial, model, context, 7, { runtime: "cloud", turn: cloudTurn });

		expect(partial.usage).toMatchObject({
			input: 7,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(partial.usage.output).toBe(estimateCursorAssistantSessionOutputTokens(partial));
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
	});

	it("keeps the prompt/output estimate fallback when SDK usage is absent", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([
			{ type: "thinking", thinking: "Need a concise answer." },
			{ type: "text", text: "Hello back." },
		]);
		const sessionInputTokens = 7;

		applyCursorApproximateUsage(partial, model, context, sessionInputTokens);

		expect(partial.usage.output).toBe(estimateCursorAssistantSessionOutputTokens(partial));
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.input).toBe(sessionInputTokens);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeGreaterThan(partial.usage.input + partial.usage.output);
	});

	it("floors approximate totalTokens at the last accepted assistant occupancy", () => {
		const model = makeModel();
		const prior = makeAssistantMessage([{ type: "text", text: "Prior." }]);
		prior.usage = {
			input: 10_000,
			output: 50,
			cacheRead: 40_000,
			cacheWrite: 100,
			totalTokens: 50_150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				prior,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.totalTokens).toBeGreaterThanOrEqual(50_150);
	});

	it("never uses billed spend as occupancy, including in-window cloud billed rows", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const billed = { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 };
		applyCursorUsage(partial, model, context, 7, { runtime: "cloud", billed });
		expect(partial.usage.input).toBe(0);
		expect(partial.usage.output).toBe(6);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(sdkUsageOf(partial)).toEqual(billed);
		expect(isContextOverflow(partial, model.contextWindow)).toBe(false);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).not.toBe(31);
	});

	it("accepts billed output above model maxTokens without poisoning occupancy", () => {
		const model = { ...makeModel(), maxTokens: 16 };
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		const billed = { inputTokens: 100, outputTokens: 17, cacheReadTokens: 80, cacheWriteTokens: 10 };

		expect(isCursorSdkUsageStructurallyValid(billed)).toBe(true);
		applyCursorUsage(partial, model, context, 7, { runtime: "local", billed });

		expect(partial.usage.input).toBe(10);
		expect(partial.usage.output).toBe(17);
		expect(sdkUsageOf(partial)).toEqual(billed);
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
	});

	it("ignores retained pre-compaction occupancy while keeping billed spend", () => {
		const model = makeModel();
		const kept = makeAssistantMessage([{ type: "text", text: "Kept." }]);
		kept.usage = {
			input: 10_000,
			output: 50,
			cacheRead: 40_000,
			cacheWrite: 100,
			totalTokens: 50_150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "compactionSummary", summary: "compacted", tokensBefore: 50_150, timestamp: 2 } as unknown as Context["messages"][number],
				kept,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 50_100, outputTokens: 50, cacheReadTokens: 40_000, cacheWriteTokens: 100 },
			billed: { inputTokens: 80, outputTokens: 12, cacheReadTokens: 60, cacheWriteTokens: 1 },
		});
		expect(partial.usage.input).toBe(19);
		expect(partial.usage.output).toBe(12);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(sdkUsageOf(partial)).toEqual({ inputTokens: 80, outputTokens: 12, cacheReadTokens: 60, cacheWriteTokens: 1 });
		expect(partial.usage.totalTokens).toBeLessThan(50_150);
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
	});

	it("uses a replayable estimate for post-compaction local turn usage", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "compactionSummary", summary: "compacted", tokensBefore: 50_150, timestamp: 2 } as unknown as Context["messages"][number],
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 12_000, outputTokens: 40, cacheReadTokens: 11_000, cacheWriteTokens: 20 },
		});
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).not.toBe(12_040);
	});

	it("prefers billed spend even when billed occupancy exceeds the context window", () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 },
			billed: { inputTokens: 200_000, outputTokens: 80, cacheReadTokens: 150_000, cacheWriteTokens: 10 },
		});
		expect(partial.usage.input).toBe(49_990);
		expect(partial.usage.output).toBe(80);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(sdkUsageOf(partial)).toEqual({ inputTokens: 200_000, outputTokens: 80, cacheReadTokens: 150_000, cacheWriteTokens: 10 });
		expect(isContextOverflow(partial, model.contextWindow)).toBe(false);
		expect(partial.usage.totalTokens).toBe(resolveCursorOccupancyTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
	});

	it("ignores pre-compaction occupancy before and after the summary", () => {
		const model = makeModel();
		const prior = makeAssistantMessage([{ type: "text", text: "Prior." }]);
		prior.usage = {
			input: 10_000,
			output: 50,
			cacheRead: 40_000,
			cacheWrite: 100,
			totalTokens: 50_150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const kept = makeAssistantMessage([{ type: "text", text: "Kept." }]);
		kept.usage = {
			...prior.usage,
			totalTokens: 50_150,
		};
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				prior,
				{ role: "compactionSummary", summary: "compacted", tokensBefore: 50_150, timestamp: 2 } as unknown as Context["messages"][number],
				kept,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		applyCursorUsage(partial, model, context, 7);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.totalTokens).toBeLessThan(50_150);
	});

	it("rejects over-window prior assistant occupancy from the compaction poison fixture", () => {
		const fixturePath = new URL("./fixtures/cursor-run-usage-compaction-poison.jsonl", import.meta.url);
		const poisonedAssistant = readFileSync(fixturePath, "utf8")
			.trim()
			.split(/\r?\n/)
			.map((line) => JSON.parse(line) as { message?: AssistantMessage })
			.find((entry) => entry.message?.role === "assistant")?.message;
		expect(poisonedAssistant?.usage.totalTokens).toBe(1_132_478);

		// Same api/provider/model as the fixture so rejection is only over-window poison.
		const model = makeModel("cursor/composer-2-5");
		expect(poisonedAssistant).toMatchObject({
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		expect(poisonedAssistant!.usage.totalTokens).toBeGreaterThan(model.contextWindow);

		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				poisonedAssistant!,
				{ role: "user", content: "Again", timestamp: 3 },
			],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hi." }]);
		partial.model = model.id;

		applyCursorUsage(partial, model, context, 7);

		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
		expect(partial.usage.totalTokens).not.toBe(1_132_478);
	});

	it("keeps pi-ai silent-overflow detection inactive for SDK-shaped billing sums", () => {
		// Regression: a real Cursor session's turn-ended usage is a billing sum across
		// invocations (observed cacheReadTokens 1.7M+ on a 200k-window model). pi-ai's
		// isContextOverflow Case 2 treats `input + cacheRead` as prompt size; if SDK
		// billing leaked onto those fields, every healthy turn looked like overflow and
		// prime-agent auto-compacted once per turn. The overflow-visible fields must
		// stay occupancy-safe (input capped, cacheRead/cacheWrite zero) while the real
		// billing rides on the host-ignored cursorSdk field.
		const model = makeModel();
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		// Observed assistant 24d9e9c5 in the prime-agent session that auto-compacted
		// five times: totalTokens (occupancy) 15,702; cacheRead billing 1,768,042.
		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: {
				inputTokens: 1_795_383,
				outputTokens: 5_516,
				cacheReadTokens: 1_768_042,
				cacheWriteTokens: 0,
			},
		});

		// pi-ai isContextOverflow Case 2: `input + cacheRead > contextWindow` => overflow.
		// Must stay false; cacheRead is zero and input is capped at the prompt budget.
		expect(partial.usage.input + partial.usage.cacheRead).toBeLessThanOrEqual(model.contextWindow);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.totalTokens).toBeLessThan(model.contextWindow);
		// Real spend is preserved on the host-ignored cursorSdk carrier.
		expect(sdkUsageOf(partial)).toEqual({
			inputTokens: 1_795_383,
			outputTokens: 5_516,
			cacheReadTokens: 1_768_042,
			cacheWriteTokens: 0,
		});
	});

	describe.each(["raw", "converted"])("%s Pi compaction context", (format) => {
		function compactedContext(): Context {
			const kept = makeAssistantMessage([{ type: "text", text: "Retained tool turn." }]);
			kept.timestamp = 100;
			kept.usage.totalTokens = 239_412;
			const messages = buildSessionContext([
				{ type: "message", id: "kept", parentId: null, timestamp: new Date(100).toISOString(), message: kept },
				{
					type: "compaction", id: "compact", parentId: "kept", timestamp: new Date(200).toISOString(),
					summary: "Short summary.", firstKeptEntryId: "kept", tokensBefore: 240_866,
				},
			]).messages;
			expect(messages.map((message) => [message.role, message.timestamp])).toEqual([
				["compactionSummary", 200], ["assistant", 100],
			]);
			const converted = convertToLlm(messages);
			expect(converted[0]).toMatchObject({ role: "user", timestamp: 200 });
			return {
				messages: format === "converted" ? converted : messages as Context["messages"],
			};
		}

		it("drops the retained floor below tokensBefore instead of propagating it across turns", () => {
			const model = { ...makeModel(), contextWindow: 256_000 };
			const context = compactedContext();
			for (let turn = 0; turn < 3; turn += 1) {
				const partial = makeAssistantMessage([{ type: "text", text: "Continuing." }]);
				partial.timestamp = 300 + turn;
				applyCursorUsage(partial, model, context, 7);
				expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
				expect(partial.usage.totalTokens).toBeLessThan(1_000);
				context.messages.push(partial);
			}
		});

		it("keeps a genuine post-compaction floor even when it grows past tokensBefore", () => {
			const model = { ...makeModel(), contextWindow: 256_000 };
			const context = compactedContext();
			const measured = makeAssistantMessage([{ type: "text", text: "New measurement." }]);
			measured.timestamp = 300;
			measured.usage.totalTokens = 250_000;
			context.messages.push(measured);
			const partial = makeAssistantMessage([]);
			partial.timestamp = 400;
			applyCursorUsage(partial, model, context, 7);
			expect(partial.usage.totalTokens).toBe(250_000);
		});

		it("keeps billed spend without resurrecting the retained occupancy floor", () => {
			const model = { ...makeModel(), contextWindow: 256_000 };
			const context = compactedContext();
			const partial = makeAssistantMessage([]);
			partial.timestamp = 300;
			applyCursorUsage(partial, model, context, 7, {
				runtime: "local",
				billed: { inputTokens: 245_000, outputTokens: 100, cacheReadTokens: 240_000, cacheWriteTokens: 0 },
			});
			expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
			expect(partial.usage.totalTokens).toBeLessThan(1_000);
			expect(partial.usage).toMatchObject({ input: 5_000, output: 100, cacheRead: 0, cacheWrite: 0 });
			expect(sdkUsageOf(partial)?.cacheReadTokens).toBe(240_000);
		});
	});

	it("calculates cost from disjoint local turn components when the model defines cost rates", () => {
		const model = makeCostModel({ input: 0.75, output: 3.5, cacheRead: 0.075, cacheWrite: 0.375 });
		const context = makeContext();
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 6500, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 500 },
		});

		// Full-prompt inputTokens 6500 minus the 5500-token cache partition bills 1000 uncached input tokens.
		expect(partial.usage.input).toBe(1000);
		expect(partial.usage.output).toBe(200);
		expect(partial.usage.cacheRead).toBe(0);
		expect(sdkUsageOf(partial)?.cacheReadTokens).toBe(5000);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(sdkUsageOf(partial)?.cacheWriteTokens).toBe(500);

		expect(partial.usage.cost.input).toBeCloseTo(0.00075, COST_PRECISION);
		expect(partial.usage.cost.output).toBeCloseTo(0.0007, COST_PRECISION);
		expect(partial.usage.cost.cacheRead).toBeCloseTo(0.000375, COST_PRECISION);
		expect(partial.usage.cost.cacheWrite).toBeCloseTo(0.0001875, COST_PRECISION);
		expect(partial.usage.cost.total).toBeCloseTo(0.0020125, COST_PRECISION);
	});

	it("calculates cost from cloud billed rows without letting billed spend become occupancy", () => {
		const model = makeCostModel({ input: 0.75, output: 3.5, cacheRead: 0.075, cacheWrite: 0.375 });
		const context = makeContext();
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7, {
			runtime: "cloud",
			billed: { inputTokens: 3000, outputTokens: 400, cacheReadTokens: 2000, cacheWriteTokens: 500 },
		});

		expect(partial.usage.input).toBe(500);
		expect(partial.usage.cost.input).toBeCloseTo(0.000375, COST_PRECISION);
		expect(partial.usage.cost.output).toBeCloseTo(0.0014, COST_PRECISION);
		expect(partial.usage.cost.cacheRead).toBeCloseTo(0.00015, COST_PRECISION);
		expect(partial.usage.cost.cacheWrite).toBeCloseTo(0.0001875, COST_PRECISION);
		expect(partial.usage.cost.total).toBeCloseTo(0.0021125, COST_PRECISION);
		// Billed spend still never becomes context occupancy.
		expect(partial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, context));
	});

	it("calculates estimate-derived cost with no cache split on the approximate fallback", () => {
		const model = makeCostModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 });
		const context = makeContext();
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 1000);

		// The supplied activity estimate is uncached input; later splits can supply only new tool-result input.
		expect(partial.usage.input).toBe(1000);
		expect(partial.usage.cost.input).toBeCloseTo(0.001, COST_PRECISION);
		expect(partial.usage.cost.output).toBeGreaterThan(0);
		expect(partial.usage.cost.cacheRead).toBe(0);
		expect(partial.usage.cost.cacheWrite).toBe(0);
		expect(partial.usage.cost.total).toBe(partial.usage.cost.input + partial.usage.cost.output);
	});

	it.each<CursorSdkUsageApplyOptions>([
		{ runtime: "local", turn: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 101, cacheWriteTokens: 0 } },
		{ runtime: "cloud", turn: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
		{ runtime: "local", billed: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 101, cacheWriteTokens: 0 } },
	])("prices the existing fallback when SDK usage is unusable: %j", (sdkUsage) => {
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);
		applyCursorUsage(partial, makeCostModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 }), makeContext(), 1000, sdkUsage);
		expect(partial.usage.input).toBe(1000);
		expect(partial.usage.cacheRead).toBe(0);
		expect(partial.usage.cacheWrite).toBe(0);
		expect(partial.usage.cost.input).toBeCloseTo(0.001, COST_PRECISION);
		expect(partial.usage.cost.output).toBeCloseTo(partial.usage.output * 2 / 1_000_000, COST_PRECISION);
	});

	it("prices valid local usage when an unusable billed row falls through", () => {
		const partial = makeAssistantMessage([]);
		applyCursorUsage(partial, makeCostModel({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }), makeContext(), 7, {
			runtime: "local",
			billed: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 },
			turn: { inputTokens: 10000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000 },
		});
		expect(partial.usage).toMatchObject({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
		expect(sdkUsageOf(partial)).toEqual({ inputTokens: 10000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000 });
		expect(partial.usage.totalTokens).toBeLessThan(10100);
		expect(partial.usage.cost.total).toBeCloseTo(0.0071, COST_PRECISION);
	});

	it.each([
		{ threshold: 10000, expectedCost: 0.0101 },
		{ threshold: 9999, expectedCost: 0.0071 },
	])("uses the native tier threshold $threshold with cached prompt tokens, not occupancy", ({ threshold, expectedCost }) => {
		const partial = makeAssistantMessage([]);
		const model = makeCostModel({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1,
			tiers: [{ inputTokensAbove: threshold, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
		});
		applyCursorUsage(partial, model, makeContext(), 7, {
			runtime: "local", turn: { inputTokens: 10000, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 1000 },
		});
		expect(partial.usage.cost.total).toBeCloseTo(expectedCost, COST_PRECISION);
	});

	it("keeps cost at zero when the model carries zero cost rates", () => {
		const model = makeModel();
		// src/model-discovery.ts registers every cursor/* model with ZERO_COST; the fixture mirrors that.
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const context = makeContext();
		const partial = makeAssistantMessage([{ type: "text", text: "Hello back." }]);

		applyCursorUsage(partial, model, context, 7, {
			runtime: "local",
			turn: { inputTokens: 25, outputTokens: 6, cacheReadTokens: 24, cacheWriteTokens: 1 },
		});

		expect(partial.usage.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
	});

	it("prices uncapped SDK spend without leaking it into overflow detection", () => {
		const model = makeCostModel({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1,
			tiers: [{ inputTokensAbove: 999_999, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
		});
		const partial = makeAssistantMessage([]);
		applyCursorUsage(partial, model, makeContext(), 7, {
			runtime: "local", turn: { inputTokens: 1_000_000, outputTokens: 100, cacheReadTokens: 100_000, cacheWriteTokens: 0 },
		});
		expect(partial.usage.input).toBeLessThan(900_000);
		expect(partial.usage.cacheRead).toBe(0);
		expect(isContextOverflow(partial, model.contextWindow)).toBe(false);
		expect(partial.usage.cost.total).toBeCloseTo(1.821, COST_PRECISION);
	});

	it("clears prior SDK spend before pricing an approximate fallback on the same message", () => {
		const model = makeCostModel({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 });
		const partial = makeAssistantMessage([]);
		applyCursorUsage(partial, model, makeContext(), 7, {
			runtime: "local", turn: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0 },
		});
		applyCursorUsage(partial, model, makeContext(), 10);
		expect(sdkUsageOf(partial)).toBeUndefined();
		expect(partial.usage.input).toBe(10);
		expect(partial.usage.cost.total).toBeCloseTo(0.00001, COST_PRECISION);
	});

});
