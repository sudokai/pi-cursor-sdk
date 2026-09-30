import {
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type Context,
	type Message,
	type Tool,
} from "@earendil-works/pi-ai";

export function isCursorSystemMessage(message: { role: string }): boolean {
	return message.role === "system";
}

/** Conversation-only view for Cursor text/history and trailing tool-result scans. */
export function getCursorConversationMessages(context: Pick<Context, "messages">): Message[] {
	return context.messages.filter((message) => !isCursorSystemMessage(message));
}

export function resolveCursorPiContext(context: Context): { systemPrompt: string; tools: Tool[] | undefined } {
	const messages = normalizeContext(context).messages;
	const shorthandWithoutTools = ("systemPrompt" in context || "tools" in context)
		&& context.tools === undefined && !context.messages.some(isCursorSystemMessage);
	const rawContext: unknown = context;
	const systemPromptFromContext = rawContext && typeof rawContext === "object" && "systemPrompt" in rawContext
		? rawContext.systemPrompt
		: undefined;
	const systemPrompt = typeof systemPromptFromContext === "string"
		? systemPromptFromContext
		: Array.isArray(systemPromptFromContext)
			? systemPromptFromContext.filter((part): part is string => typeof part === "string").join("\n\n")
			: getCurrentSystemPrompt(messages);
	return {
		systemPrompt,
		tools: shorthandWithoutTools ? undefined : getCurrentTools(messages),
	};
}
