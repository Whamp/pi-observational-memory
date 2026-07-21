import { streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";

import { normalizeSourceEntryIds, OBSERVATION_TIMESTAMP_PATTERN, runObserver } from "../src/agents/observer/agent.js";
import { estimateStringTokens } from "../src/tokens.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			// No streaming events needed for these tests.
		},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

describe("OBSERVATION_TIMESTAMP_PATTERN", () => {
	it("matches local minute timestamps without regex shorthand escapes", () => {
		expect(OBSERVATION_TIMESTAMP_PATTERN).not.toContain("\\d");
		const pattern = new RegExp(OBSERVATION_TIMESTAMP_PATTERN);
		expect(pattern.test("2026-05-02 10:30")).toBe(true);
		expect(pattern.test("2026-5-02 10:30")).toBe(false);
		expect(pattern.test("2026-05-02T10:30")).toBe(false);
		expect(pattern.test("2026-05-02 10:30:00")).toBe(false);
	});
});

describe("runObserver", () => {
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
		allowedSourceEntryIds: ["entry-a"],
	};

	it("keeps core observer prompt rules", async () => {
		let systemPrompt = "";
		let userPrompt = "";
		const loop = fakeAgentLoop((prompts, context) => {
			systemPrompt = context.systemPrompt;
			userPrompt = prompts[0].content[0].text;
		});

		await runObserver({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Preserve user assertions exactly");
		expect(systemPrompt).toContain("Detail preservation");
		expect(systemPrompt).toContain("Frame state changes as supersession");
		expect(systemPrompt).toContain("sourceEntryIds");
		expect(systemPrompt).toContain("empty observations array");
		expect(systemPrompt).toContain("plain-text confirmation alone is a failed outcome");
		expect(systemPrompt).not.toContain("simply do not call the tool");
		expect(systemPrompt).toContain("The dropper will drop these first");
		expect(systemPrompt).toContain("highest-resistance, load-bearing observations");
		expect(systemPrompt).not.toContain("will NEVER be dropped");
		expect(systemPrompt).not.toContain("pruner");
		expect(userPrompt).toContain("explicitly call record_observations with an empty observations array");
	});

	it("passes Pi's standard stream function to the agent loop", async () => {
		const loop = vi.fn(fakeAgentLoop(() => {}));

		await runObserver({ ...baseArgs, agentLoop: loop });

		expect(loop).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), expect.any(Object), undefined, streamSimple);
	});

	it("reports Empty only after an explicit empty observations submission", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { observations: [] });
		});

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toEqual({
			outcome: "empty",
		});
	});

	it("records V3 observations with source ids and code-computed tokenCount", async () => {
		const content = "User asked for a memory update.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content, relevance: "high", sourceEntryIds: ["entry-a"] }],
			});
		});

		const result = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(result.outcome).toBe("recorded");
		if (result.outcome !== "recorded") return;
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			content,
			timestamp: "2026-05-02 10:30",
			relevance: "high",
			sourceEntryIds: ["entry-a"],
			tokenCount: estimateStringTokens(content),
		});
		expect(result.observations[0].id).toMatch(/^[a-f0-9]{12}$/);
	});

	it("reports Failed when every proposed observation is rejected", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] }],
			});
		});

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toEqual({
			outcome: "failed",
			reason: "rejected_proposals",
			rejectedCount: 1,
		});
	});

	it("reports Recorded when empty, accepted, and rejected proposals occur in the same run", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-empty", { observations: [] });
			await context.tools[0].execute("tool-1", {
				observations: [
					{ timestamp: "2026-05-02 10:30", content: "Accepted", relevance: "high", sourceEntryIds: ["entry-a"] },
					{ timestamp: "2026-05-02 10:31", content: "Rejected", relevance: "medium", sourceEntryIds: ["missing"] },
				],
			});
		});

		const result = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(result.outcome).toBe("recorded");
		if (result.outcome !== "recorded") return;
		expect(result.observations.map((item) => item.content)).toEqual(["Accepted"]);
	});

	it("reports Failed when an explicit empty submission is followed by a rejection", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", { observations: [] });
			await context.tools[0].execute("tool-2", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Rejected", relevance: "medium", sourceEntryIds: ["missing"] }],
			});
		});

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toEqual({
			outcome: "failed",
			reason: "rejected_proposals",
			rejectedCount: 1,
		});
	});

	it("dedupes deterministic ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{ timestamp: "2026-05-02 10:30", content: "Same content", relevance: "medium", sourceEntryIds: ["entry-a"] },
					{ timestamp: "2026-05-02 10:31", content: "Same content", relevance: "high", sourceEntryIds: ["entry-a"] },
				],
			});
		});

		const result = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(result.outcome).toBe("recorded");
		if (result.outcome !== "recorded") return;
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].content).toBe("Same content");
	});

	it("reports Failed when no structured outcome is submitted", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toEqual({
			outcome: "failed",
			reason: "no_structured_outcome",
		});
	});

	it("uses maxTurns as an observer turn cap", async () => {
		let shouldStopAfterTurn: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			shouldStopAfterTurn = config.shouldStopAfterTurn;
		});

		await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

		expect(shouldStopAfterTurn).toBeTypeOf("function");
		expect(shouldStopAfterTurn({})).toBe(false);
		expect(shouldStopAfterTurn({})).toBe(true);
	});

	it("uses configured observer thinking level for reasoning models", async () => {
		let seenReasoning: unknown;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({ ...baseArgs, model: { reasoning: true } as any, agentLoop: loop, thinkingLevel: "minimal" });

		expect(seenReasoning).toBe("minimal");
	});

	it("omits observer reasoning when thinkingLevel is off", async () => {
		let seenReasoning: unknown = "unset";
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({ ...baseArgs, model: { reasoning: true } as any, agentLoop: loop, thinkingLevel: "off" });

		expect(seenReasoning).toBeUndefined();
	});
});

describe("normalizeSourceEntryIds", () => {
	const allowed = ["entry-a", "entry-b", "entry-c"];

	it("accepts source ids from the allowed chunk and orders them by branch order", () => {
		expect(normalizeSourceEntryIds(["entry-c", "entry-a"], allowed)).toEqual(["entry-a", "entry-c"]);
	});

	it("dedupes repeated source ids", () => {
		expect(normalizeSourceEntryIds(["entry-b", "entry-b", "entry-a"], allowed)).toEqual(["entry-a", "entry-b"]);
	});

	it("rejects missing, empty, or hallucinated source ids", () => {
		expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a", "not-in-the-chunk"], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a"], [])).toBeUndefined();
	});
});
