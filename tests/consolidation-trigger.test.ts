import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import type { StageModelConfig } from "../src/config.js";
import {
	OM_OBSERVER_COMPLETED,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runReflector.mockReset();
	mockAgents.runDropper.mockReset();
	mockAgents.runObserver.mockResolvedValue({ outcome: "failed", reason: "no_structured_outcome" });
	mockAgents.runReflector.mockResolvedValue(undefined);
	mockAgents.runDropper.mockResolvedValue(undefined);
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	observerChunkMaxTokens?: number;
	observationsPoolMaxTokens?: number;
	observationsPoolTargetTokens?: number;
	showWorkerNotifications?: boolean;
	passive?: boolean;
	consolidationInFlight?: boolean;
	appendEntryReturnsId?: boolean;
	observer?: StageModelConfig;
	reflector?: StageModelConfig;
	dropper?: StageModelConfig;
	sessionId?: string;
}) {
	let entries = [...args.entries];
	let sessionId = args.sessionId ?? "session-1";
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return args.appendEntryReturnsId === false ? undefined : id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	const runtime = {
		config: {
			showWorkerNotifications: args.showWorkerNotifications ?? true,
			passive: args.passive ?? false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			reflectAfterTokens: args.reflectAfterTokens ?? 1,
			observerChunkMaxTokens: args.observerChunkMaxTokens,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? Math.floor((args.observationsPoolMaxTokens ?? 100) / 2),
			agentMaxTurns: 9,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
			...(args.observer ? { observer: args.observer } : {}),
			...(args.reflector ? { reflector: args.reflector } : {}),
			...(args.dropper ? { dropper: args.dropper } : {}),
		},
		consolidationInFlight: args.consolidationInFlight ?? false,
		consolidationPhase: undefined as "observer" | "reflector" | "dropper" | undefined,
		resolveFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		lastDropperError: undefined as string | undefined,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" } })),
		launchConsolidationTask: vi.fn((_ctx, work) => {
			runtime.consolidationInFlight = true;
			launchedWork = work;
			return Promise.resolve();
		}),
		recordConsolidationStageError: vi.fn((ctx, phase: "observer" | "reflector" | "dropper", error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (phase === "observer") runtime.lastObserverError = message;
			if (phase === "reflector") runtime.lastReflectorError = message;
			if (phase === "dropper") runtime.lastDropperError = message;
			ctx.ui?.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
			return message;
		}),
	};
	registerConsolidationTrigger(pi as any, runtime as any);
	if (!handlers.agent_start) throw new Error("agent_start consolidation handler not registered");
	if (!handlers.turn_end) throw new Error("turn_end consolidation handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => sessionId,
		},
	};
	return {
		pi,
		runtime,
		ctx,
		fire: (eventName = "turn_end") => handlers[eventName]!(undefined, ctx),
		fireAgentStart: () => handlers.agent_start!(undefined, ctx),
		fireTurnEnd: () => handlers.turn_end!(undefined, ctx),
		runLaunchedWork: async () => {
			const work = launchedWork;
			launchedWork = undefined;
			return work?.();
		},
		addEntries: (...more: TestEntry[]) => {
			entries = [...entries, ...more];
		},
		setSessionId: (next: string) => {
			sessionId = next;
		},
		getEntries: () => entries,
	};
}

describe("V3 consolidation trigger", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("registers agent_start and turn_end consolidation entrypoints", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { pi } = setup({ entries });

		expect(pi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("waits for in-flight print-mode consolidation on shutdown before the extension context goes stale", async () => {
		const recorded = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		let resolveObserver: ((value: unknown) => void) | undefined;
		mockAgents.runObserver.mockImplementationOnce(() => new Promise((resolve) => {
			resolveObserver = resolve;
		}));

		let entries: TestEntry[] = [textCustomMessage("raw-1", "aaaaaaaa")];
		const handlers: Record<string, ((event: unknown, ctx: any) => unknown) | undefined> = {};
		const pi = {
			on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => unknown) => {
				handlers[eventName] = cb;
			}),
			appendEntry: vi.fn((customType: string, data: unknown) => {
				entries = [...entries, { type: "custom", id: `appended-${pi.appendEntry.mock.calls.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			}),
		};
		const runtime = {
			config: {
				passive: false,
				debugLog: false,
				observeAfterTokens: 1,
				reflectAfterTokens: 999,
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 50,
				agentMaxTurns: 9,
				model: { provider: "anthropic", id: "memory", thinking: "minimal" },
			},
			consolidationInFlight: false,
			consolidationPromise: null as Promise<void> | null,
			consolidationPhase: undefined as "observer" | "reflector" | "dropper" | undefined,
			resolveFailureNotified: false,
			lastObserverError: undefined as string | undefined,
			lastReflectorError: undefined as string | undefined,
			lastDropperError: undefined as string | undefined,
			ensureConfig: vi.fn(),
			resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" } })),
			launchConsolidationTask: vi.fn((_ctx, work) => {
				runtime.consolidationInFlight = true;
				const promise = work().finally(() => {
					runtime.consolidationInFlight = false;
					runtime.consolidationPromise = null;
				});
				runtime.consolidationPromise = promise;
				return promise;
			}),
			recordConsolidationStageError: vi.fn((ctx, phase: "observer" | "reflector" | "dropper", error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (phase === "observer") runtime.lastObserverError = message;
				if (phase === "reflector") runtime.lastReflectorError = message;
				if (phase === "dropper") runtime.lastDropperError = message;
				ctx.ui?.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
				return message;
			}),
		};
		registerConsolidationTrigger(pi as any, runtime as any);

		const ctx = {
			mode: "print",
			cwd: "/tmp/project",
			hasUI: false,
			ui: undefined,
			model: { provider: "session" },
			modelRegistry: {},
			sessionManager: { getBranch: () => entries },
		};
		handlers.turn_end?.(undefined, ctx);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockAgents.runObserver).toHaveBeenCalled();

		let shutdownSettled = false;
		const shutdown = Promise.resolve(handlers.session_shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx)).then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();

		expect(shutdownSettled).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();

		resolveObserver?.({ outcome: "recorded", observations: [recorded] });
		await shutdown;

		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [recorded], coversUpToId: "raw-1" });
		expect(runtime.lastObserverError).toBeUndefined();
	});

	it("does not launch below all thresholds from either entrypoint", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries, observeAfterTokens: 10, reflectAfterTokens: 10 });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint in passive mode", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const passive = setup({ entries, passive: true });

		passive.fireAgentStart();
		passive.fireTurnEnd();

		expect(passive.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("does not launch from either entrypoint while consolidation is already in flight", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const locked = setup({ entries, consolidationInFlight: true });

		locked.fireAgentStart();
		locked.fireTurnEnd();

		expect(locked.runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("launches from agent_start when work is due", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, runtime } = setup({ entries });

		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when agent_start fires before turn_end", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireAgentStart();
		fireTurnEnd();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("uses the shared lock when turn_end fires before agent_start", () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fireAgentStart, fireTurnEnd, runtime } = setup({ entries });

		fireTurnEnd();
		fireAgentStart();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("runs observer first and appends source-addressed observations", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obs] });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });
		runtime.lastObserverError = "stale observer failure";

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalled();
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["raw-1"],
			maxTurns: 9,
			thinkingLevel: "minimal",
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
		expect(runtime.lastObserverError).toBeUndefined();
	});

	it("forwards OAuth-shaped auth (headers, no apiKey) to the observer agent", async () => {
		const obs = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obs] });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });
		runtime.resolveModel.mockResolvedValueOnce({
			ok: true,
			model: { provider: "kimi-coding" },
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
		}));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [obs], coversUpToId: "raw-1" });
	});

	it("uses existing observation coverage and retries larger ranges after no-output", async () => {
		const prior = observation("cccccccccccc", { sourceEntryIds: ["raw-1"] });
		const newObs = observation("dddddddddddd", { sourceEntryIds: ["raw-2"] });
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [newObs] });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-prior", { observations: [prior], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccc"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-2", "raw-3"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, { observations: [newObs], coversUpToId: "raw-3" });
	});

	it("persists Empty as Observation Coverage without creating an observation batch", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "empty" });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, ctx, runtime } = setup({ entries });
		runtime.lastObserverError = "stale observer failure";

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVER_COMPLETED, {
			outcome: "empty",
			coversUpToId: "raw-1",
		});
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: observer found no new observations",
			"info",
		);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(runtime.lastObserverError).toBeUndefined();
	});

	it("gates the routine Empty notification", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "empty" });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, ctx } = setup({ entries, showWorkerNotifications: false });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVER_COMPLETED, {
			outcome: "empty",
			coversUpToId: "raw-1",
		});
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("does not observe Empty-covered source again in the same or a fresh runtime", async () => {
		mockAgents.runObserver.mockResolvedValue({ outcome: "empty" });
		const first = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], reflectAfterTokens: 999 });

		first.fire();
		await first.runLaunchedWork();
		first.runtime.consolidationInFlight = false;
		first.fire();
		await first.runLaunchedWork();

		const fresh = setup({ entries: first.getEntries(), reflectAfterTokens: 999 });
		fresh.fire();
		await fresh.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
	});

	it("keeps silent observer failures uncovered, visible, ungated, and immediately retryable", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const result = setup({ entries, showWorkerNotifications: false, reflectAfterTokens: 999 });

		result.fire();
		await result.runLaunchedWork();
		result.runtime.consolidationInFlight = false;
		result.fire();
		await result.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(result.pi.appendEntry).not.toHaveBeenCalled();
		expect(result.runtime.lastObserverError).toBe("observer reported no structured outcome");
		expect(result.ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: observer failed: observer reported no structured outcome",
			"warning",
		);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("keeps rejected observer failures uncovered, visible, ungated, and immediately retryable", async () => {
		mockAgents.runObserver.mockResolvedValue({ outcome: "failed", reason: "rejected_proposals", rejectedCount: 2 });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const result = setup({ entries, showWorkerNotifications: false, reflectAfterTokens: 999 });

		result.fire();
		await result.runLaunchedWork();
		result.runtime.consolidationInFlight = false;
		result.fire();
		await result.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(result.pi.appendEntry).not.toHaveBeenCalled();
		expect(result.runtime.lastObserverError).toBe("observer rejected 2 proposals");
		expect(result.ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: observer failed: observer rejected 2 proposals",
			"warning",
		);
	});

	it("keeps thrown observer failures uncovered, visible, ungated, and immediately retryable", async () => {
		mockAgents.runObserver.mockRejectedValue(new Error("observe failed"));
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const result = setup({ entries, showWorkerNotifications: false, reflectAfterTokens: 999 });

		result.fire();
		await result.runLaunchedWork();
		result.runtime.consolidationInFlight = false;
		result.fire();
		await result.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(result.pi.appendEntry).not.toHaveBeenCalled();
		expect(result.runtime.lastObserverError).toBe("observe failed");
		expect(result.ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: observer failed: observe failed",
			"warning",
		);
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("shows routine worker notifications by default", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obsA] });
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^Observational memory: observer running on ~\d+-token chunk$/), "info"],
			["Observational memory: 1 observation recorded", "info"],
			["Observational memory: reflector running (~2 tokens)", "info"],
			["Observational memory: dropper running after reflection — active observation pool ~19 / 5 target tokens (380%)", "info"],
		]);
	});

	it("suppresses routine worker notifications without hiding warnings", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obsA] });
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const quiet = setup({ entries, observationsPoolTargetTokens: 5, showWorkerNotifications: false });

		quiet.fire();
		await quiet.runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledOnce();
		expect(mockAgents.runReflector).toHaveBeenCalledOnce();
		expect(mockAgents.runDropper).toHaveBeenCalledOnce();
		expect(quiet.ctx.ui.notify).not.toHaveBeenCalled();

		// Deliberate empty is routine info: also hidden when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "empty" });
		const noOutput = setup({ entries, reflectAfterTokens: 999, showWorkerNotifications: false });

		noOutput.fire();
		await noOutput.runLaunchedWork();

		expect(noOutput.ctx.ui.notify).not.toHaveBeenCalled();

		// Real failures still surface as warnings when quiet.
		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "failed", reason: "stream_error", stopReason: "error", errorMessage: "prompt is too long" });
		const failed = setup({ entries, reflectAfterTokens: 999, showWorkerNotifications: false });

		failed.fire();
		await failed.runLaunchedWork();

		expect(failed.ctx.ui.notify).toHaveBeenCalledOnce();
		expect(failed.ctx.ui.notify.mock.calls[0][1]).toBe("warning");
		expect(failed.ctx.ui.notify.mock.calls[0][0]).toContain("observer failed");
	});

	it("reports deliberate empty as info, not a warning", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "empty" });
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, ctx } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(ctx.ui.notify.mock.calls).toEqual([
			[expect.stringMatching(/^Observational memory: observer running on ~\d+-token chunk$/), "info"],
			["Observational memory: observer found no new observations", "info"],
		]);
	});

	it("surfaces API stream errors as observer failure, never as empty", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({
			outcome: "failed",
			reason: "stream_error",
			stopReason: "error",
			errorMessage: "prompt is too long: 5198507 tokens > 1000000 maximum",
		});
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(runtime.lastObserverError).toContain("prompt is too long");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'Observational memory: observer failed: observer stream ended with stopReason "error": prompt is too long: 5198507 tokens > 1000000 maximum',
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("no observations"), expect.anything());
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});

	it("model resolution failure skips appending and notifies once", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, runtime, ctx } = setup({ entries });
		runtime.resolveModel.mockResolvedValueOnce({ ok: false, reason: "no model" });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: observer skipped — no model", "warning");
	});

	it("passes observer and reflector stage thinking overrides to each agent", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obsA] });
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork } = setup({
			entries,
			observer: { thinking: "off" },
			reflector: { thinking: "high" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "off" }));
		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high" }));
	});

	it("dropper inherits reflector thinking when dropper thinking is unset", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			reflector: { thinking: "high" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high" }));
		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high" }));
	});

	it("dropper own thinking override beats inherited reflector thinking", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
			reflector: { thinking: "high" },
			dropper: { thinking: "medium" },
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high" }));
		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "medium" }));
	});

	it("re-reads branch so observer append can unblock reflector in the same consolidation run", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obsA] });
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA] }));
		expect(mockAgents.runObserver.mock.invocationCallOrder[0]).toBeLessThan(mockAgents.runReflector.mock.invocationCallOrder[0]);
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-1" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }]);
	});

	it("runs reflector-only and appends non-empty reflections", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsDroppedEntry("om-drop", { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ observations: [obsA], maxTurns: 9, thinkingLevel: "minimal" }));
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
	});

	it("runs dropper after same-run non-empty reflector output and appends non-empty drops", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [newRef], observations: [obsA] }));
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }]);
	});

	it("hides routine notifications without disabling the worker pipeline", async () => {
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obsA] });
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi, ctx } = setup({
			entries,
			observationsPoolTargetTokens: 5,
			showWorkerNotifications: false,
		});

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledTimes(3);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("does not launch dropper-only work when active pool is over target", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
		];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 999, observationsPoolTargetTokens: 5 });

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("waits for successful reflection even when active observation pool is over target", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, runtime } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 1, observationsPoolTargetTokens: 5 });

		fire();
		await runLaunchedWork();

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("does not launch dropper-only work when dropped tombstones reduce active pool below budget", () => {
		const heavy = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 100 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [heavy], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["cccccccccccc"], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-2" }),
		];
		const { fire, runtime } = setup({ entries, observeAfterTokens: 999, reflectAfterTokens: 1, observationsPoolMaxTokens: 100 });

		fire();

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("uses same-run reflection coverage for drop coverage", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("does not bootstrap dropper without same-run reflection output", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not append reflect/drop entries without observation coverage", async () => {
		mockAgents.runReflector.mockResolvedValueOnce([reflection("ffffffffffff", ["aaaaaaaaaaaa"])]);
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const entries = [textCustomMessage("raw-1", "aaaaaaaa")];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("runs reflector before dropper and covers drops through same-run reflection coverage", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ reflections: [newRef] }));
		expect(pi.appendEntry.mock.calls[0]).toEqual([OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }]);
		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("does not use appended reflection entry id for drop coverage when appendEntry returns no id", async () => {
		const newRef = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
		];
		const { fire, runLaunchedWork, pi } = setup({ entries, observeAfterTokens: 999, appendEntryReturnsId: false, observationsPoolMaxTokens: 10 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry.mock.calls[1]).toEqual([OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }]);
	});

	it("appends no empty reflection or drop entries", async () => {
		const entries = [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })];
		const { fire, runLaunchedWork, pi, ctx } = setup({ entries, observeAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("dropper running"), "info");
	});

	it("preserves stage failure boundaries", async () => {
		mockAgents.runObserver.mockRejectedValueOnce(new Error("observe failed"));
		const observerFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		observerFailure.fire();
		await observerFailure.runLaunchedWork();
		expect(observerFailure.runtime.lastObserverError).toBe("observe failed");
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();

		mockAgents.runObserver.mockReset();
		mockAgents.runObserver.mockResolvedValue({ outcome: "failed", reason: "no_structured_outcome" });
		mockAgents.runReflector.mockReset();
		mockAgents.runReflector.mockRejectedValueOnce(new Error("reflect failed"));
		const reflectorFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })], observeAfterTokens: 999 });
		reflectorFailure.fire();
		await reflectorFailure.runLaunchedWork();
		expect(reflectorFailure.runtime.lastReflectorError).toBe("reflect failed");
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
		expect(reflectorFailure.pi.appendEntry).not.toHaveBeenCalled();

		mockAgents.runReflector.mockReset();
		const newRef = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runDropper.mockReset();
		mockAgents.runDropper.mockRejectedValueOnce(new Error("drop failed"));
		const dropperFailure = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa"), observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" })], observeAfterTokens: 999, observationsPoolMaxTokens: 10 });
		dropperFailure.fire();
		await dropperFailure.runLaunchedWork();
		expect(dropperFailure.runtime.lastDropperError).toBe("drop failed");
		expect(dropperFailure.pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(dropperFailure.pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-1" });
	});
});

describe("observer chunk cap", () => {
	it("caps an oversized backlog and drains it incrementally across runs", async () => {
		const first = observation("111111111111", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		const second = observation("222222222222", { sourceEntryIds: ["raw-2"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [first] }).mockResolvedValueOnce({ outcome: "recorded", observations: [second] });
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
			textCustomMessage("raw-3", "c".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 256, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		// Only the oldest entry fits under the cap; coverage advances to it, not to the backlog tail.
		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(1, expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-1" });

		// The next run continues from the advanced coverage.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-2"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-2" });
	});

	it("bounds one oversized tool result, preserves provenance, and continues on the next run", async () => {
		const first = observation("333333333333", { sourceEntryIds: ["raw-huge"], tokenCount: 4 });
		const second = observation("555555555555", { sourceEntryIds: ["raw-next"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [first] }).mockResolvedValueOnce({ outcome: "recorded", observations: [second] });
		const hugeText = `HEAD:${"m".repeat(2_000)}:TAIL`;
		const entries: TestEntry[] = [
			{
				type: "message",
				id: "raw-huge",
				parentId: null,
				timestamp: "2026-05-02T10:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "bash",
					content: [{ type: "text", text: hugeText }],
					isError: false,
					timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
				},
			},
			textCustomMessage("raw-next", "later"),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, observerChunkMaxTokens: 100, reflectAfterTokens: 999 });

		fire();
		await runLaunchedWork();

		const firstCall = mockAgents.runObserver.mock.calls[0][0];
		expect(firstCall.allowedSourceEntryIds).toEqual(["raw-huge"]);
		expect(firstCall.chunk).toContain("HEAD:");
		expect(firstCall.chunk).toContain(":TAIL");
		expect(firstCall.chunk).toContain("middle omitted: source exceeds observer input budget");
		expect(firstCall.chunk).not.toContain("raw-next");
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, OM_OBSERVATIONS_RECORDED, { observations: [first], coversUpToId: "raw-huge" });

		// The source id still points at the full ledger entry; the next run starts
		// after it instead of retrying the oversized input forever.
		runtime.consolidationInFlight = false;
		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowedSourceEntryIds: ["raw-next"] }));
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, OM_OBSERVATIONS_RECORDED, { observations: [second], coversUpToId: "raw-next" });
	});

	it("derives the cap from the resolved model's context window when not configured", async () => {
		const obs = observation("444444444444", { sourceEntryIds: ["raw-1"], tokenCount: 4 });
		mockAgents.runObserver.mockResolvedValueOnce({ outcome: "recorded", observations: [obs] });
		const entries = [
			textCustomMessage("raw-1", "a".repeat(800)),
			textCustomMessage("raw-2", "b".repeat(800)),
		];
		const { fire, runLaunchedWork, pi, runtime } = setup({ entries, reflectAfterTokens: 999 });
		// contextWindow 1,280 -> cap = floor(1,280 * 0.2) = 256, so only raw-1 fits.
		runtime.resolveModel.mockResolvedValue({ ok: true, model: { reasoning: true, contextWindow: 1_280 }, apiKey: "key", headers: { h: "v" } } as any);

		fire();
		await runLaunchedWork();

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-1"] }));
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_OBSERVATIONS_RECORDED, expect.objectContaining({ coversUpToId: "raw-1" }));
	});
});
