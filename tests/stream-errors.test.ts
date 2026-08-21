import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, StopReason } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";

import { logAgentStreamError } from "../src/agents/stream-errors.js";
import { runObserver } from "../src/agents/observer/agent.js";
import { debugLogRelativePath, withDebugLogContext } from "../src/debug-log.js";

const TEST_MODEL: Model<Api> = {
	id: "stream-error-test",
	name: "Stream error test",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

function assistantMessage(stopReason: StopReason, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: TEST_MODEL.api,
		provider: TEST_MODEL.provider,
		model: TEST_MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

function messageEnd(message: AgentMessage): AgentEvent {
	return { type: "message_end", message };
}

function singleEventAgentLoop(
	event: AgentEvent,
): typeof import("@earendil-works/pi-agent-core").agentLoop {
	return () => {
		const stream = new EventStream<AgentEvent, AgentMessage[]>(
			() => false,
			() => [],
		);
		queueMicrotask(() => {
			stream.push(event);
			stream.end([]);
		});
		return stream;
	};
}

describe("agent stream error logging", () => {
	let root = "";

	beforeEach(() => {
		root = `${tmpdir()}/om-stream-errors-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const agentDir = join(root, "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function readLoggedEvents(
		sessionId: string,
	): Array<{ event: string; data: Record<string, unknown> }> {
		const path = join(root, "agent", debugLogRelativePath({ sessionId }));
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	it("logs assistant message_end with stopReason error, prefixed with the stage", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-stream-1" }, () => {
			logAgentStreamError(
				"observer",
				messageEnd(
					assistantMessage("error", "prompt is too long: 5198507 tokens > 1000000 maximum"),
				),
			);
		});

		const events = readLoggedEvents("session-stream-1");
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("observer.stream_error");
		expect(events[0].data).toMatchObject({
			stopReason: "error",
			errorMessage: "prompt is too long: 5198507 tokens > 1000000 maximum",
		});
	});

	it("logs aborted runs and uses the caller's stage name", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-stream-2" }, () => {
			logAgentStreamError("reflector", messageEnd(assistantMessage("aborted")));
		});

		const events = readLoggedEvents("session-stream-2");
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("reflector.stream_error");
		expect(events[0].data).toMatchObject({ stopReason: "aborted" });
	});

	it("ignores successful assistant messages, non-assistant messages, and other events", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-stream-3" }, () => {
			logAgentStreamError("observer", messageEnd(assistantMessage("stop")));
			logAgentStreamError("observer", messageEnd({ role: "user", content: [], timestamp: 0 }));
			logAgentStreamError("observer", { type: "turn_start" });
			// One real error so the log file exists and we can assert nothing else landed.
			logAgentStreamError("observer", messageEnd(assistantMessage("error", "marker")));
		});

		const events = readLoggedEvents("session-stream-3");
		expect(events).toHaveLength(1);
		expect(events[0].data).toMatchObject({ errorMessage: "marker" });
	});

	it("runObserver logs a stream_error when the loop ends with an errored assistant message", async () => {
		const failingEvent = messageEnd(assistantMessage("error", "upstream 400"));

		await withDebugLogContext({ enabled: true, sessionId: "session-stream-4" }, async () => {
			const result = await runObserver({
				model: TEST_MODEL,
				apiKey: "test",
				priorReflections: [],
				priorObservations: [],
				chunk: "[Source entry id: entry-a]\nSome content.",
				allowedSourceEntryIds: ["entry-a"],
				agentLoop: singleEventAgentLoop(failingEvent),
			});
			expect(result).toMatchObject({
				outcome: "failed",
				reason: "stream_error",
				stopReason: "error",
			});
		});

		const events = readLoggedEvents("session-stream-4");
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("observer.stream_error");
		expect(events[0].data).toMatchObject({ stopReason: "error", errorMessage: "upstream 400" });
	});
});
