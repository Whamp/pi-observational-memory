import {
	InMemoryCredentialStore,
	fauxAssistantMessage,
	fauxProvider,
	type Context,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { Runtime } from "../src/runtime.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import {
	OM_OBSERVER_COMPLETED,
	OM_OBSERVATIONS_RECORDED,
	isSourceEntry,
} from "../src/session-ledger/index.js";

const COVERED_RAW_SENTINEL = "COVERED_RAW_SENTINEL";
const UNCOVERED_RAW_SENTINEL = "UNCOVERED_RAW_SENTINEL";
const CURRENT_PROMPT_SENTINEL = "CURRENT_PROMPT_SENTINEL";
const KEEP_TAIL_SENTINEL = "KEEP_TAIL_SENTINEL_".repeat(8);
const OM_MEMORY_SENTINEL = "OM_MEMORY_SENTINEL";
const NATIVE_SUMMARY_SENTINEL = "NATIVE_SUMMARY_SENTINEL";

function contextText(context: Context): string {
	return JSON.stringify(context);
}

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
				contexts.set("covered-turn", contextText(context));
				return fauxAssistantMessage("covered turn complete");
			},
			(context) => {
				contexts.set("covered-tail", contextText(context));
				return fauxAssistantMessage("covered tail complete");
			},
			(context) => {
				contexts.set("uncovered-turn", contextText(context));
				return fauxAssistantMessage("uncovered turn complete");
			},
			(context) => {
				contexts.set("uncovered-tail", contextText(context));
				return fauxAssistantMessage("uncovered tail complete");
			},
			(context) => {
				contexts.set("native-summary-input", contextText(context));
				return fauxAssistantMessage(`${NATIVE_SUMMARY_SENTINEL}\n${OM_MEMORY_SENTINEL}`);
			},
			(context) => {
				contexts.set("after-native-compaction", contextText(context));
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
				contexts.set("after-failure", contextText(context));
				return fauxAssistantMessage("continued after failure");
			},
		]);

		try {
			await session.prompt(COVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(KEEP_TAIL_SENTINEL, { expandPromptTemplates: false });
			try {
				await session.compact();
			} catch {
				// The host reports native summarization failures by rejection.
			}

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
				contexts.set("after-abort", contextText(context));
				return fauxAssistantMessage("continued after abort");
			},
		]);

		try {
			await session.prompt(COVERED_RAW_SENTINEL, { expandPromptTemplates: false });
			await session.prompt(KEEP_TAIL_SENTINEL, { expandPromptTemplates: false });
			const compaction = session.compact();
			await summaryStarted;
			session.abortCompaction();
			try {
				await compaction;
			} catch {
				// The host reports aborted compaction by rejection.
			}

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
				contexts.set("warmup", contextText(context));
				return fauxAssistantMessage("warmup complete");
			},
			(context) => {
				contexts.set("overflow-error", contextText(context));
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "prompt is too long: 1200 tokens > 1000 maximum",
				});
			},
			(context) => {
				contexts.set("native-summary-input", contextText(context));
				return fauxAssistantMessage(NATIVE_SUMMARY_SENTINEL);
			},
			(context) => {
				contexts.set("retry-after-compaction", contextText(context));
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
