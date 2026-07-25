import {
	InMemoryCredentialStore,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	AgentSessionRuntime,
	buildSessionContext,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	runPrintMode,
	SessionManager,
	SettingsManager,
	type CustomMessageEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import {
	OM_OBSERVER_COMPLETED,
	OM_OBSERVATIONS_RECORDED,
	isSourceEntry,
	rawTokensSinceLastCompaction,
} from "../src/session-ledger/index.js";

const COVERED_RAW_SENTINEL = "COVERED_RAW_SENTINEL";
const UNCOVERED_RAW_SENTINEL = "UNCOVERED_RAW_SENTINEL";
const CURRENT_PROMPT_SENTINEL = "CURRENT_PROMPT_SENTINEL";
const KEEP_TAIL_SENTINEL = "KEEP_TAIL_SENTINEL_".repeat(8);
const OM_MEMORY_SENTINEL = "OM_MEMORY_SENTINEL";
const NATIVE_SUMMARY_SENTINEL = "NATIVE_SUMMARY_SENTINEL";
const BETWEEN_TURN_SOURCE_SENTINEL = "BETWEEN_TURN_SOURCE_SENTINEL_".repeat(12);
const BETWEEN_TURN_TASK_SENTINEL = "BETWEEN_TURN_TASK_SENTINEL";
const BETWEEN_TURN_TASK_PROMPT = `${BETWEEN_TURN_TASK_SENTINEL}_`.repeat(12);
const BETWEEN_TURN_MEMORY_SENTINEL = "BETWEEN_TURN_MEMORY_SENTINEL";
const BETWEEN_TURN_FINAL_RESPONSE = "BETWEEN_TURN_FINAL_RESPONSE";
const BETWEEN_TURN_CONTINUATION_TYPE = "om.compaction.continue";

async function createRuntimeHarness(responses: FauxResponseStep[]) {
	const faux = fauxProvider({
		api: "compaction-runtime-test",
		provider: "compaction-runtime-test",
		tokenSize: { min: 128, max: 128 },
		models: [{
			id: "compaction-runtime-test-model",
			name: "Compaction Runtime Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000,
			maxTokens: 80,
		}],
	});
	faux.setResponses(responses);

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	modelRuntime.registerNativeProvider(faux.provider);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 10 },
		retry: { enabled: false },
	});
	const sessionManager = SessionManager.inMemory(process.cwd());
	const runtime = new Runtime();
	runtime.configLoaded = true;
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: "/tmp/pi-observational-memory-compaction-runtime-test",
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Compaction runtime test. Keep responses minimal.",
		extensionFactories: [(pi) => registerCompactionHook(pi, runtime)],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: "/tmp/pi-observational-memory-compaction-runtime-test",
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		noTools: "all",
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	return { faux, runtime, session, sessionManager };
}

function appendRecordedCoverage(sessionManager: SessionManager, sourceIndex: number): void {
	const target = sessionManager.getBranch().filter(isSourceEntry)[sourceIndex];
	if (!target) {
		throw new Error("missing source entry for runtime coverage");
	}
	const appendedId = sessionManager.appendCustomEntry(OM_OBSERVATIONS_RECORDED, {
		observations: [{
			id: "aaaaaaaaaaaa",
			content: OM_MEMORY_SENTINEL,
			timestamp: "2026-07-21T00:00:00.000Z",
			relevance: "high",
			sourceEntryIds: [target.id],
			tokenCount: 5,
		}],
		coversUpToId: target.id,
	});
	if (!appendedId) {
		throw new Error("failed to append runtime coverage");
	}
}

function appendEmptyCoverage(sessionManager: SessionManager, sourceIndex: number): void {
	const target = sessionManager.getBranch().filter(isSourceEntry)[sourceIndex];
	if (!target) {
		throw new Error("missing source entry for Empty runtime coverage");
	}
	sessionManager.appendCustomEntry(OM_OBSERVER_COMPLETED, {
		outcome: "empty",
		coversUpToId: target.id,
	});
}

function compactionEntries(sessionManager: SessionManager) {
	return sessionManager.getBranch().filter((entry) => entry.type === "compaction");
}

function rebuiltContextText(sessionManager: SessionManager): string {
	return JSON.stringify(
		buildSessionContext(sessionManager.getBranch(), sessionManager.getLeafId()).messages,
	);
}

interface ContinuationDetails {
	token: string;
	compactionEntryId: string;
}

function isContinuationDetails(value: unknown): value is ContinuationDetails {
	if (typeof value !== "object" || value === null) return false;
	return (
		"token" in value
		&& typeof value.token === "string"
		&& "compactionEntryId" in value
		&& typeof value.compactionEntryId === "string"
	);
}

function isBetweenTurnContinuationEntry(entry: SessionEntry): entry is CustomMessageEntry {
	return entry.type === "custom_message" && entry.customType === BETWEEN_TURN_CONTINUATION_TYPE;
}

function isPrintJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePrintJsonEvent(line: string): unknown {
	const event: unknown = JSON.parse(line);
	return event;
}

function captureRunPrintModeOutput() {
	const chunks: string[] = [];
	const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
		chunks.push(String(chunk));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	});
	return {
		output: () => chunks.join(""),
		restore: () => write.mockRestore(),
	};
}

async function createBetweenTurnPrintHarness() {
	const capturedModelContexts: string[] = [];
	const compactEvents: Array<{ reason: string; willRetry: boolean; fromExtension: boolean }> = [];
	const toolTurnRawTokens: number[] = [];
	const postCompactionRawTokens: number[] = [];
	const faux = fauxProvider({
		api: "between-turn-runtime-test",
		provider: "between-turn-runtime-test",
		tokenSize: { min: 128, max: 128 },
		models: [{
			id: "between-turn-runtime-test-model",
			name: "Between-turn Runtime Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 80,
		}],
	});
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("between_turn_work", { cycle: 1 }, { id: "between-turn-tool-1" })),
		() => fauxAssistantMessage("FIRST_BOUNDARY_CALL_MUST_BE_ABORTED"),
		() => fauxAssistantMessage(fauxToolCall("between_turn_work", { cycle: 2 }, { id: "between-turn-tool-2" })),
		() => fauxAssistantMessage("SECOND_BOUNDARY_CALL_MUST_BE_ABORTED"),
		() => fauxAssistantMessage(BETWEEN_TURN_FINAL_RESPONSE),
	]);

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	modelRuntime.registerNativeProvider(faux.provider);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 50 },
		retry: { enabled: false },
	});
	const sessionManager = SessionManager.inMemory(process.cwd());
	const preparedSourceId = sessionManager.appendCustomMessageEntry(
		"between-turn.fixture.source",
		BETWEEN_TURN_SOURCE_SENTINEL,
		false,
	);
	sessionManager.appendCustomEntry(OM_OBSERVATIONS_RECORDED, {
		observations: [{
			id: "bbbbbbbbbbbb",
			content: BETWEEN_TURN_MEMORY_SENTINEL,
			timestamp: "2026-07-25T00:00:00.000Z",
			relevance: "high",
			sourceEntryIds: [preparedSourceId],
			tokenCount: 10,
		}],
		coversUpToId: preparedSourceId,
	});

	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...runtime.config,
		compactAfterTokens: 115,
		compactionTrigger: "betweenTurns",
	};
	const agentDir = "/tmp/pi-observational-memory-between-turn-runtime-test";
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Between-turn runtime test. Use the scripted tool and keep responses minimal.",
		extensionFactories: [
			(pi) => {
				pi.on("turn_end", (event, ctx) => {
					const branch = ctx.sessionManager.getBranch();
					if (event.toolResults.length > 0) {
						toolTurnRawTokens.push(rawTokensSinceLastCompaction(branch));
					}
					const latestSource = [...branch].reverse().find(isSourceEntry);
					if (latestSource) {
						pi.appendEntry(OM_OBSERVER_COMPLETED, {
							outcome: "empty",
							coversUpToId: latestSource.id,
						});
					}
				});
				pi.on("context", (event) => {
					capturedModelContexts.push(JSON.stringify(event.messages));
				});
				pi.on("session_compact", (event, ctx) => {
					compactEvents.push({
						reason: event.reason,
						willRetry: event.willRetry,
						fromExtension: event.fromExtension,
					});
					postCompactionRawTokens.push(
						rawTokensSinceLastCompaction(ctx.sessionManager.getBranch()),
					);
				});
			},
			(pi) => {
				registerCompactionTrigger(pi, runtime);
				registerCompactionHook(pi, runtime);
			},
		],
	});
	await resourceLoader.reload();

	const betweenTurnTool = defineTool({
		name: "between_turn_work",
		label: "Between-turn work",
		description: "Produce deterministic work that makes another model turn necessary.",
		parameters: Type.Object({ cycle: Type.Number() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `BETWEEN_TURN_WORK_RESULT_${params.cycle}_`.repeat(3) }],
				details: {
					cycle: params.cycle,
					retainedTask: BETWEEN_TURN_TASK_SENTINEL,
				},
			};
		},
	});
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		customTools: [betweenTurnTool],
		noTools: "builtin",
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	const services = {
		cwd: process.cwd(),
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics: [],
	};
	const runtimeHost = new AgentSessionRuntime(session, services, async () => {
		throw new Error("between-turn print test unexpectedly replaced its session");
	});

	return {
		capturedModelContexts,
		compactEvents,
		faux,
		postCompactionRawTokens,
		runtime,
		runtimeHost,
		sessionManager,
		toolTurnRawTokens,
	};
}

describe("between-turn compaction through real Pi print mode", () => {
	it("releases print mode when continuation startup settles before message_start", async () => {
		const harness = await createBetweenTurnPrintHarness();
		const session = harness.runtimeHost.session;
		const originalPrompt = session.agent.prompt.bind(session.agent);
		let promptCount = 0;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async (input, images) => {
			promptCount++;
			if (promptCount === 2) {
				throw new Error("continuation startup failed before message_start");
			}
			await originalPrompt(input, images);
		});
		let signalContinuationSettlement: (() => void) | undefined;
		const continuationSettlement = new Promise<void>((resolve) => {
			signalContinuationSettlement = resolve;
		});
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled") signalContinuationSettlement?.();
		});
		const outputCapture = captureRunPrintModeOutput();
		const printRun = runPrintMode(harness.runtimeHost, {
			mode: "json",
			initialMessage: BETWEEN_TURN_TASK_PROMPT,
		});
		let printCompleted = false;
		const trackedPrintRun = printRun.then((exitCode) => {
			printCompleted = true;
			return exitCode;
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			await Promise.race([
				continuationSettlement,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => {
						reject(new Error("continuation startup did not reach agent_settled"));
					}, 2_000);
				}),
			]);
			expect(promptCount).toBe(2);
			expect(harness.runtime.compactInFlight).toBe(false);
			expect(await trackedPrintRun).toBe(0);
			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(branch.filter(isBetweenTurnContinuationEntry)).toHaveLength(0);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (!printCompleted) await harness.runtimeHost.dispose();
			await trackedPrintRun;
			unsubscribe();
			promptSpy.mockRestore();
			outputCapture.restore();
		}
	});

	it.each(["text", "json"] as const)("completes two same-session cycles in %s mode", async (mode) => {
		const harness = await createBetweenTurnPrintHarness();
		const initialSessionId = harness.sessionManager.getSessionId();
		const outputCapture = captureRunPrintModeOutput();
		let exitCode: number;
		try {
			exitCode = await runPrintMode(harness.runtimeHost, {
				mode,
				initialMessage: BETWEEN_TURN_TASK_PROMPT,
			});
		} finally {
			outputCapture.restore();
		}
		const output = outputCapture.output();
		const branch = harness.sessionManager.getBranch();
		const compactions = branch.filter((entry) => entry.type === "compaction");
		const continuations = branch.filter(isBetweenTurnContinuationEntry);
		const continuationDetails = continuations.map((entry) => {
			expect(isContinuationDetails(entry.details)).toBe(true);
			if (!isContinuationDetails(entry.details)) {
				throw new Error("between-turn continuation details were invalid");
			}
			return entry.details;
		});

		expect(exitCode).toBe(0);
		expect(harness.sessionManager.getSessionId()).toBe(initialSessionId);
		expect(branch.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(compactions).toHaveLength(2);
		expect(compactions[0].summary).toBe(compactions[1].summary);
		for (const compaction of compactions) {
			expect(compaction.summary).toContain(BETWEEN_TURN_MEMORY_SENTINEL);
			expect(compaction.summary).not.toContain(BETWEEN_TURN_TASK_SENTINEL);
		}
		expect(harness.compactEvents).toEqual([
			{ reason: "manual", willRetry: false, fromExtension: true },
			{ reason: "manual", willRetry: false, fromExtension: true },
		]);
		expect(continuations).toHaveLength(2);
		expect(continuations.every((entry) => entry.display === false)).toBe(true);
		expect(new Set(continuationDetails.map((details) => details.token)).size).toBe(2);
		expect(continuationDetails.map((details) => details.compactionEntryId)).toEqual(
			compactions.map((entry) => entry.id),
		);
		expect(harness.faux.state.callCount).toBe(5);
		expect(harness.faux.getPendingResponseCount()).toBe(0);
		expect(harness.toolTurnRawTokens).toHaveLength(2);
		expect(harness.toolTurnRawTokens.every((tokens) => tokens >= 115)).toBe(true);
		expect(harness.postCompactionRawTokens).toHaveLength(2);
		expect(harness.postCompactionRawTokens.every((tokens) => tokens < 115)).toBe(true);

		for (const [contextIndex, continuationIndex] of [[2, 0], [4, 1]] as const) {
			const modelContext = harness.capturedModelContexts[contextIndex];
			expect(modelContext).toContain(BETWEEN_TURN_MEMORY_SENTINEL);
			expect(modelContext).toContain(BETWEEN_TURN_TASK_SENTINEL);
			expect(modelContext).toContain(continuationDetails[continuationIndex].token);
		}

		if (mode === "text") {
			expect(output).toBe(`${BETWEEN_TURN_FINAL_RESPONSE}\n`);
			expect(output).not.toContain("Continue the interrupted work from the compacted context.");
		} else {
			const events = output.trim().split("\n").map(parsePrintJsonEvent);
			const compactionEndIndexes = events.flatMap((event, index) => (
				isPrintJsonObject(event)
				&& event.type === "compaction_end"
				&& event.reason === "manual"
				&& event.aborted === false
					? [index]
					: []
			));
			const hiddenContinuationEvents = events.filter((event) => {
				if (!isPrintJsonObject(event) || event.type !== "message_start") return false;
				const message = event.message;
				return (
					isPrintJsonObject(message)
					&& message.role === "custom"
					&& message.customType === BETWEEN_TURN_CONTINUATION_TYPE
					&& message.display === false
				);
			});
			const finalResponseIndex = events.findIndex((event) => {
				if (!isPrintJsonObject(event) || event.type !== "message_end") return false;
				const message = event.message;
				if (!isPrintJsonObject(message) || message.role !== "assistant") return false;
				const content = JSON.stringify(message.content);
				return typeof content === "string" && content.includes(BETWEEN_TURN_FINAL_RESPONSE);
			});
			const lastEvent = events.at(-1);
			expect(compactionEndIndexes).toHaveLength(2);
			expect(hiddenContinuationEvents).toHaveLength(2);
			expect(finalResponseIndex).toBeGreaterThan(compactionEndIndexes[1]);
			expect(isPrintJsonObject(lastEvent) ? lastEvent.type : undefined).toBe("agent_settled");
		}
	});
});

describe("real Pi Compaction Authority runtime", () => {
	it("persists an intentionally empty hook compaction for explicit Empty coverage", async () => {
		const { faux, session, sessionManager } = await createRuntimeHarness([
			() => fauxAssistantMessage("covered turn complete"),
			() => fauxAssistantMessage("covered tail complete"),
		]);

		try {
			await session.prompt(COVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(KEEP_TAIL_SENTINEL, { expandPromptTemplates: false });
			appendEmptyCoverage(sessionManager, 1);
			await session.compact();

			const compactions = compactionEntries(sessionManager);
			expect(compactions).toHaveLength(1);
			expect(compactions[0].fromHook).toBe(true);
			expect(compactions[0].summary).toBe("");
			expect(faux.state.callCount).toBe(2);
		} finally {
			session.dispose();
		}
	});

	it("uses OM for covered source, then delegates uncovered active-to-passive source to native compaction", async () => {
		const contexts = new Map<string, string>();
		const { faux, runtime, session, sessionManager } = await createRuntimeHarness([
			(context) => {
				contexts.set("covered-turn", JSON.stringify(context));
				return fauxAssistantMessage("covered turn complete");
			},
			(context) => {
				contexts.set("covered-tail", JSON.stringify(context));
				return fauxAssistantMessage("covered tail complete");
			},
			(context) => {
				contexts.set("uncovered-turn", JSON.stringify(context));
				return fauxAssistantMessage("uncovered turn complete");
			},
			(context) => {
				contexts.set("uncovered-tail", JSON.stringify(context));
				return fauxAssistantMessage("uncovered tail complete");
			},
			(context) => {
				contexts.set("native-summary-input", JSON.stringify(context));
				return fauxAssistantMessage(`${NATIVE_SUMMARY_SENTINEL}\n${OM_MEMORY_SENTINEL}`);
			},
			(context) => {
				contexts.set("after-native-compaction", JSON.stringify(context));
				return fauxAssistantMessage("continuation complete");
			},
		]);

		try {
			await session.prompt(COVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(KEEP_TAIL_SENTINEL, { expandPromptTemplates: false });
			appendRecordedCoverage(sessionManager, 1);
			await session.compact();

			let compactions = compactionEntries(sessionManager);
			expect(compactions).toHaveLength(1);
			expect(compactions[0].fromHook).toBe(true);
			expect(compactions[0].summary).toContain(OM_MEMORY_SENTINEL);
			expect(faux.state.callCount).toBe(2);

			runtime.config.passive = true;
			await session.prompt(UNCOVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(KEEP_TAIL_SENTINEL, { expandPromptTemplates: false });
			await session.compact();
			await session.prompt(CURRENT_PROMPT_SENTINEL, { expandPromptTemplates: false });

			compactions = compactionEntries(sessionManager);
			expect(compactions).toHaveLength(2);
			expect(compactions[1].fromHook).toBe(false);
			expect(compactions[1].summary).toContain(NATIVE_SUMMARY_SENTINEL);
			expect(contexts.get("native-summary-input")).toContain(OM_MEMORY_SENTINEL);
			expect(contexts.get("native-summary-input")).toContain(UNCOVERED_RAW_SENTINEL);
			expect(contexts.get("after-native-compaction")).toContain(NATIVE_SUMMARY_SENTINEL);
			expect(contexts.get("after-native-compaction")).toContain(CURRENT_PROMPT_SENTINEL);
			expect(contexts.get("after-native-compaction")).not.toContain(UNCOVERED_RAW_SENTINEL);
			expect(rebuiltContextText(sessionManager)).toContain(NATIVE_SUMMARY_SENTINEL);
			expect(faux.state.callCount).toBe(6);
		} finally {
			session.dispose();
		}
	});

	it("keeps the branch usable when delegated native summarization fails", async () => {
		const contexts = new Map<string, string>();
		const { session, sessionManager } = await createRuntimeHarness([
			() => fauxAssistantMessage("warmup complete"),
			() => fauxAssistantMessage("tail complete"),
			() => fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "native summarization failed",
			}),
			(context) => {
				contexts.set("after-failure", JSON.stringify(context));
				return fauxAssistantMessage("continued after failure");
			},
		]);

		try {
			await session.prompt(COVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(KEEP_TAIL_SENTINEL, { expandPromptTemplates: false });
			await expect(session.compact()).rejects.toThrow("Summarization failed: native summarization failed");

			expect(compactionEntries(sessionManager)).toHaveLength(0);
			await session.prompt(CURRENT_PROMPT_SENTINEL, { expandPromptTemplates: false });
			expect(contexts.get("after-failure")).toContain(COVERED_RAW_SENTINEL);
			expect(contexts.get("after-failure")).toContain(CURRENT_PROMPT_SENTINEL);
		} finally {
			session.dispose();
		}
	});

	it("keeps the branch usable when delegated native summarization is aborted", async () => {
		const contexts = new Map<string, string>();
		let signalSummaryStarted: (() => void) | undefined;
		const summaryStarted = new Promise<void>((resolve) => {
			signalSummaryStarted = resolve;
		});
		const { session, sessionManager } = await createRuntimeHarness([
			() => fauxAssistantMessage("warmup complete"),
			() => fauxAssistantMessage("tail complete"),
			async (_context, options) => {
				signalSummaryStarted?.();
				const signal = options?.signal;
				if (!signal) {
					throw new Error("native summarization did not receive an abort signal");
				}
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("aborted native summary");
			},
			(context) => {
				contexts.set("after-abort", JSON.stringify(context));
				return fauxAssistantMessage("continued after abort");
			},
		]);

		try {
			await session.prompt(COVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(KEEP_TAIL_SENTINEL, { expandPromptTemplates: false });
			const compaction = session.compact();
			await summaryStarted;
			session.abortCompaction();
			await expect(compaction).rejects.toThrow("Compaction cancelled");

			expect(compactionEntries(sessionManager)).toHaveLength(0);
			await session.prompt(CURRENT_PROMPT_SENTINEL, { expandPromptTemplates: false });
			expect(contexts.get("after-abort")).toContain(COVERED_RAW_SENTINEL);
			expect(contexts.get("after-abort")).toContain(CURRENT_PROMPT_SENTINEL);
		} finally {
			session.dispose();
		}
	});

	it("delegates overflow recovery to native compaction and continues the interrupted prompt", async () => {
		const contexts = new Map<string, string>();
		const sessionEvents: Array<{ type: string; reason?: string; willRetry?: boolean }> = [];
		const { faux, session, sessionManager } = await createRuntimeHarness([
			(context) => {
				contexts.set("warmup", JSON.stringify(context));
				return fauxAssistantMessage("warmup complete");
			},
			(context) => {
				contexts.set("overflow-error", JSON.stringify(context));
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "prompt is too long: 1200 tokens > 1000 maximum",
				});
			},
			(context) => {
				contexts.set("native-summary-input", JSON.stringify(context));
				return fauxAssistantMessage(NATIVE_SUMMARY_SENTINEL);
			},
			(context) => {
				contexts.set("retry-after-compaction", JSON.stringify(context));
				return fauxAssistantMessage("retry complete");
			},
		]);
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "compaction_start" || event.type === "compaction_end") {
				sessionEvents.push({
					type: event.type,
					reason: event.reason,
					willRetry: event.type === "compaction_end" ? event.willRetry : undefined,
				});
			}
		});

		try {
			await session.prompt(COVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(CURRENT_PROMPT_SENTINEL, { expandPromptTemplates: false });

			const compactions = compactionEntries(sessionManager);
			expect(compactions).toHaveLength(1);
			expect(compactions[0].fromHook).toBe(false);
			expect(compactions[0].summary).toContain(NATIVE_SUMMARY_SENTINEL);
			expect(contexts.get("retry-after-compaction")).toContain(NATIVE_SUMMARY_SENTINEL);
			expect(contexts.get("retry-after-compaction")).toContain(CURRENT_PROMPT_SENTINEL);
			expect(contexts.get("retry-after-compaction")).not.toContain(COVERED_RAW_SENTINEL);
			expect(sessionEvents).toContainEqual({
				type: "compaction_end",
				reason: "overflow",
				willRetry: true,
			});
			expect(faux.state.callCount).toBe(4);
		} finally {
			unsubscribe();
			session.dispose();
		}
	});
});
