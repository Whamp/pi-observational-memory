import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { debugLog } from "../debug-log.js";

/** Terminal failure reported by an agent event stream. */
export interface AgentStreamFailure {
	stopReason: "error" | "aborted";
	errorMessage?: string;
}

/** Read a terminal assistant failure from an agent event. */
export function agentStreamFailure(event: AgentEvent): AgentStreamFailure | undefined {
	if (event.type !== "message_end") {
		return undefined;
	}
	const message = event.message;
	if (message.role !== "assistant") {
		return undefined;
	}
	if (message.stopReason !== "error" && message.stopReason !== "aborted") {
		return undefined;
	}
	return { stopReason: message.stopReason, errorMessage: message.errorMessage };
}

/**
 * Surface LLM failures from an agent-loop event stream.
 *
 * When the underlying LLM call fails, the loop ends the stream with a final
 * assistant message whose stopReason is "error" (or "aborted") — no exception
 * is thrown. Without this hook the drain loops treat such runs exactly like
 * "the model chose not to call the tool", which hides the real cause
 * (rate limits, oversized prompts, auth failures, ...) from the debug log.
 */
export function logAgentStreamError(stage: "observer" | "reflector" | "dropper", event: AgentEvent): void {
	const failure = agentStreamFailure(event);
	if (!failure) {
		return;
	}
	debugLog(`${stage}.stream_error`, {
		stopReason: failure.stopReason,
		errorMessage: failure.errorMessage,
	});
}
