import type { Context, Message, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { CURSOR_APPROX_CHARS_PER_TOKEN, estimateCursorPromptMessageTokens } from "./context.js";
import type { CursorSdkTurnUsage } from "./cursor-usage-accounting.js";

export interface CursorLiveRunAccountingState {
	promptInputTokens: number;
	promptInputTokensReported: boolean;
	consumedToolResultIds: ReadonlySet<string>;
	sdkTurnEnded: boolean;
	sdkTurnUsage?: CursorSdkTurnUsage;
	/**
	 * Model invocation count for this run: number of SDK `onStep` steps with
	 * `type: "assistantMessage"`. Used to detect multi-invocation billing aggregates.
	 */
	modelInvocationCount: number;
}

export interface CursorLiveToolResultConsumption {
	state: CursorLiveRunAccountingState;
	toolResults: ToolResultMessage[];
	toolResultInputTokens: number;
	toolCallIds: string[];
}

export function createCursorLiveRunAccountingState(promptInputTokens: number): CursorLiveRunAccountingState {
	return {
		promptInputTokens,
		promptInputTokensReported: false,
		consumedToolResultIds: new Set(),
		sdkTurnEnded: false,
		modelInvocationCount: 0,
	};
}

/**
 * Records an SDK `turn-ended` usage event. The latest per-turn usage overwrites any
 * pending value (it is never summed): the SDK emits per-turn usage via `toTokenUsage`,
 * and cross-turn summing is a separate opt-in helper (`sumTokenUsage`) that double-counts
 * if applied here. Note the SDK may still deliver **already-aggregated** usage for a
 * multi-invocation run inside that single event — occupancy policy lives in
 * `cursor-usage-accounting.ts`. `turn-ended` is also not carried forward across pi turns:
 * if it arrives after its turn has emitted it belongs to a turn that already fell back to
 * approximate, and applying it to a later turn would mis-attribute usage (see
 * `docs/investigations/cursor-live-run-turn-ended-usage-2026-07-27.md` and the contract in
 * `docs/cursor-model-ux-spec.md`). The next `takeCursorLiveSdkTurnUsage` consumes the
 * recorded value.
 */
export function recordCursorLiveSdkTurnEnded(
	state: CursorLiveRunAccountingState,
	sdkTurnUsage?: CursorSdkTurnUsage,
): CursorLiveRunAccountingState {
	return { ...state, sdkTurnEnded: true, sdkTurnUsage };
}

/**
 * Record one model invocation from an SDK `onStep` `assistantMessage`.
 * Increments `modelInvocationCount` so multi-invocation billing usage can be detected later.
 */
export function recordCursorLiveModelInvocation(state: CursorLiveRunAccountingState): CursorLiveRunAccountingState {
	return { ...state, modelInvocationCount: state.modelInvocationCount + 1 };
}

export function takeCursorLiveSdkTurnUsage(state: CursorLiveRunAccountingState): {
	state: CursorLiveRunAccountingState;
	sdkTurnUsage?: CursorSdkTurnUsage;
} {
	const { sdkTurnUsage, ...nextState } = state;
	return {
		state: {
			...nextState,
			sdkTurnEnded: false,
		},
		sdkTurnUsage,
	};
}

function asToolResultMessage(message: Message): ToolResultMessage | undefined {
	return message.role === "toolResult" ? message : undefined;
}

export function consumeCursorLiveToolResults(
	state: CursorLiveRunAccountingState,
	context: Context,
	isMatchingToolResult: (toolResult: ToolResultMessage) => boolean,
): CursorLiveToolResultConsumption {
	const consumedToolResultIds = new Set(state.consumedToolResultIds);
	const toolResults: ToolResultMessage[] = [];
	let toolResultInputTokens = 0;

	for (const message of context.messages) {
		const toolResult = asToolResultMessage(message);
		if (!toolResult) continue;
		if (consumedToolResultIds.has(toolResult.toolCallId)) continue;
		if (!isMatchingToolResult(toolResult)) continue;
		consumedToolResultIds.add(toolResult.toolCallId);
		toolResults.push(toolResult);
		toolResultInputTokens += estimateCursorPromptMessageTokens(toolResult, { charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN });
	}

	return {
		state: { ...state, consumedToolResultIds },
		toolResults,
		toolResultInputTokens,
		toolCallIds: toolResults.map((toolResult) => toolResult.toolCallId),
	};
}

export function takeCursorLiveTurnInputTokens(
	state: CursorLiveRunAccountingState,
	toolResultInputTokens: number,
): { state: CursorLiveRunAccountingState; sessionInputTokens: number } {
	const promptInputTokens = state.promptInputTokensReported ? 0 : state.promptInputTokens;
	return {
		state: state.promptInputTokensReported ? state : { ...state, promptInputTokensReported: true },
		sessionInputTokens: promptInputTokens + toolResultInputTokens,
	};
}
