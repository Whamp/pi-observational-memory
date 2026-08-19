import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { compactionEntry, rawMessage, textCustomMessage, type TestEntry } from "./fixtures/session.js";

type TriggerHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface TriggerHandlers {
	agentEnd: TriggerHandler;
	turnEnd: TriggerHandler;
	agentSettled(event: unknown, ctx: unknown): Promise<void>;
	messageStart: TriggerHandler;
	sessionCompact: TriggerHandler;
	sessionShutdown: TriggerHandler;
}

function captureLifecycleHandlers(args: { compactAfterTokens?: number; compactAfterTokensMode?: "calibrated" | "ratio"; compactAfterTokensRatio?: number; passive?: boolean; compactInFlight?: boolean; compactionTrigger?: "auto" | "native" | "agentEnd" | "betweenTurns" } = {}) {
	const registered = new Map<string, TriggerHandler[]>();
	const pi = {
		on: vi.fn((name: string, handler: TriggerHandler) => {
			const list = registered.get(name) ?? [];
			list.push(handler);
			registered.set(name, list);
		}),
		sendMessage: vi.fn(),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			compactAfterTokens: args.compactAfterTokens ?? 3,
			compactAfterTokensMode: args.compactAfterTokensMode ?? "calibrated",
			compactAfterTokensRatio: args.compactAfterTokensRatio ?? 0.68,
			compactionTrigger: args.compactionTrigger ?? "auto",
			passive: args.passive ?? false,
		},
		compactInFlight: args.compactInFlight ?? false,
		observerPromise: new Promise(() => {}),
		reflectDropPromise: new Promise(() => {}),
	};
	registerCompactionTrigger(pi as any, runtime as any);
	const requireHandler = (name: string, occurrence = 0): TriggerHandler => {
		const list = registered.get(name);
		const handler = list?.[occurrence];
		if (!handler) throw new Error(`${name} handler was not registered`);
		return handler;
	};
	// The merged trigger registers agent_settled twice: occurrence 0 is the
	// agentEnd-mode threshold compaction, occurrence 1 is the between-turn
	// continuation waiter.
	const handlers: TriggerHandlers = {
		agentEnd: requireHandler("agent_settled", 0),
		turnEnd: requireHandler("turn_end"),
		agentSettled: async (event, ctx) => {
			await requireHandler("agent_settled", 1)(event, ctx);
		},
		messageStart: requireHandler("message_start"),
		sessionCompact: requireHandler("session_compact"),
		sessionShutdown: requireHandler("session_shutdown"),
	};
	return { handlers, pi, runtime };
}

function captureHandler(args: Parameters<typeof captureLifecycleHandlers>[0] = {}) {
	const captured = captureLifecycleHandlers(args);
	return { ...captured, handler: captured.handlers.agentEnd };
}

function agentSettled() {
	return { type: "agent_settled" };
}

interface FakeContextOverrides extends Record<string, unknown> {
	model?: { contextWindow: number };
}

function fakeCtx(branches: TestEntry[][], overrides: FakeContextOverrides = {}) {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		mode: "tui",
		sessionManager: { getBranch, getSessionId: vi.fn(() => "session-1") },
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		abort: vi.fn(),
		compact: vi.fn(),
		model: overrides.model,
		...overrides,
	};
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

function toolTurnEnd() {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", content: [] },
		toolResults: [{ role: "toolResult", content: [] }],
	};
}

function terminalTurnEnd() {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", content: [] },
		toolResults: [],
	};
}

function successfulCompactionFixture() {
	const armBranch = [
		textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		textCustomMessage("raw-2", "aaaa"),
	];
	const entry = {
		...compactionEntry("cmp-new", { firstKeptEntryId: "raw-2", summary: "prepared summary" }),
		tokensBefore: 4,
	};
	const postCompactionBranch = [...armBranch, entry];
	const result = {
		summary: "prepared summary",
		firstKeptEntryId: "raw-2",
		tokensBefore: 4,
		estimatedTokensAfter: 1,
	};
	return { armBranch, entry, postCompactionBranch, result };
}

function continuationMessageStart(pi: { sendMessage: ReturnType<typeof vi.fn> }) {
	const message = pi.sendMessage.mock.calls.at(-1)?.[0];
	if (!message) throw new Error("continuation message was not sent");
	return {
		type: "message_start",
		message: { role: "custom", ...message },
	};
}

describe("V3 compaction trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 estimated source tokens); triggering compaction",
			"info",
		);
	});

	it("native trigger policy never calls extension compaction", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3, compactionTrigger: "native" });
		const ctx = fakeCtx([dueBranch], { mode: "tui" });

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("betweenTurns trigger policy never uses the legacy agent_end path", async () => {
		const { handler, runtime } = captureHandler({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch], { mode: "tui" });

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("agentEnd trigger policy preserves threshold compaction even in print mode", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3, compactionTrigger: "agentEnd" });
		const ctx = fakeCtx([dueBranch], { mode: "print" });

		handler(agentSettled(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it.each(["print", "json"])("auto trigger policy skips extension compaction in %s mode", async (mode) => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3, compactionTrigger: "auto" });
		const ctx = fakeCtx([dueBranch], { mode });

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it.each(["tui", "rpc"])("auto trigger policy uses agentEnd behavior in %s mode", async (mode) => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3, compactionTrigger: "auto" });
		const ctx = fakeCtx([dueBranch], { mode });

		handler(agentSettled(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("skips passive mode", async () => {
		const { handler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		];
		const ctx = fakeCtx([branch]);

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("does not compact when provider context and anchored growth exceed the threshold but raw progress does not", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 130000 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "baseline" }),
			rawMessage("baseline", "baseline", {
				message: {
					role: "assistant",
					content: "baseline",
					stopReason: "end_turn",
					usage: { totalTokens: 5000 },
				},
			}),
			textCustomMessage("raw-1", "a".repeat(302_248)), // 75,562 tokens plus the 2-token baseline message
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 135636, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("uses raw progress when provider growth is lower than the raw threshold", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 100 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 101, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress from the first kept entry through the current branch", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("old", "bbbbbbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "kept" }),
			textCustomMessage("kept", "aaaaaaaa"),
			textCustomMessage("new", "bbbbbbbbbbbb"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress from the branch start before the first compaction", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses the same raw metric after deferred re-check", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(runtime.compactInFlight).toBe(true);
	});

	it("ignores high provider context before the first compaction", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 130000 });
		const ctx = fakeCtx([dueBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 130000, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("compacts when raw progress equals the threshold", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 100 } },
			}),
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 101, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("uses raw progress when provider usage is unknown or has no baseline", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [compactionEntry("cmp-1"), textCustomMessage("raw-1", "aaaa")];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: null, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("rechecks raw progress after deferral", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch], {
			getContextUsage: vi.fn(() => ({ tokens: 1, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("falls back to raw progress after a model change", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			compactionEntry("cmp-1"),
			rawMessage("assistant-1", "done", {
				message: { role: "assistant", content: "done", stopReason: "end_turn", usage: { totalTokens: 60000 } },
			}),
			{ type: "model_change", id: "model-1", timestamp: "2026-05-02T10:00:00.000Z" },
			textCustomMessage("raw-1", "aaaa"),
		];
		const ctx = fakeCtx([branch], {
			getContextUsage: vi.fn(() => ({ tokens: 190000, contextWindow: 200000 })),
		});

		handler(agentSettled(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	describe("ratio mode", () => {
		it("does not override native compaction timing", async () => {
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 1,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
				compactionTrigger: "native",
			});
			const ctx = fakeCtx([dueBranch], { mode: "tui", model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(runtime.compactInFlight).toBe(false);
			expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("scales the compaction threshold by model.contextWindow", async () => {
			// 3 tokens raw; ratio 0.5 of 4-token window = 2 -> threshold 2, so 3 >= 2 fires.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not compact when raw tokens are below the scaled threshold", async () => {
			// 1 token raw (belowBranch); ratio 0.5 of 4 = 2 -> threshold 2, so 1 < 2 does not fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([belowBranch], { model: { contextWindow: 4 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the model context window in ratio mode", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], {
				model: { contextWindow: 4 },
				getContextUsage: vi.fn(() => ({ tokens: 2, contextWindow: 10 })),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("falls back to calibrated value when model.contextWindow is unavailable", async () => {
			// ratio mode but no model -> falls back to compactAfterTokens=81000, so 3 tokens won't fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: undefined });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when contextWindow is zero", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 0 } });

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the same resolved threshold on deferred re-check", async () => {
			// threshold = 0.5 * 4 = 2; first branch has 3 (fires, deferred), isIdle=false defers,
			// second branch has 1 (< 2) -> skipped because another compaction reduced pressure.
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch, belowBranch], {
				model: { contextWindow: 4 },
				isIdle: vi.fn(() => false),
			});

			handler(agentSettled(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});
	});
});

describe("between-turn compaction lifecycle", () => {
	it("does not arm from a terminal assistant turn", () => {
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch]);

		handlers.turnEnd(terminalTurnEnd(), ctx);

		expect(ctx.abort).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("does not arm while Pi has a queued message", () => {
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch], {
			hasPendingMessages: vi.fn(() => true),
		});

		handlers.turnEnd(toolTurnEnd(), ctx);

		expect(ctx.abort).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it.each([
		{ name: "below threshold", config: { compactAfterTokens: 3, compactionTrigger: "betweenTurns" as const }, branch: belowBranch },
		{ name: "passive", config: { compactAfterTokens: 3, compactionTrigger: "betweenTurns" as const, passive: true }, branch: dueBranch },
		{ name: "native policy", config: { compactAfterTokens: 3, compactionTrigger: "native" as const }, branch: dueBranch },
		{ name: "agentEnd policy", config: { compactAfterTokens: 3, compactionTrigger: "agentEnd" as const }, branch: dueBranch },
		{ name: "busy", config: { compactAfterTokens: 3, compactionTrigger: "betweenTurns" as const, compactInFlight: true }, branch: dueBranch },
	])("does not arm when $name", ({ config, branch }) => {
		const { handlers, pi } = captureLifecycleHandlers(config);
		const ctx = fakeCtx([branch]);

		handlers.turnEnd(toolTurnEnd(), ctx);

		expect(ctx.abort).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not compact when the resulting settlement is not idle", async () => {
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch], {
			isIdle: vi.fn(() => false),
		});

		handlers.turnEnd(toolTurnEnd(), ctx);
		await handlers.agentSettled({ type: "agent_settled" }, ctx);

		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("ignores duplicate eligible turns while a cycle is armed", () => {
		const { handlers, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		handlers.turnEnd(toolTurnEnd(), ctx);

		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(runtime.compactInFlight).toBe(true);
	});

	it.each(["missing boundary", "mismatched boundary", "insufficient headroom"] as const)(
		"refuses continuation for $0",
		async (failure) => {
			const fixture = successfulCompactionFixture();
			let eventEntry = fixture.entry;
			let postCompactionBranch = fixture.postCompactionBranch;
			let result = fixture.result;
			if (failure === "missing boundary") {
				postCompactionBranch = fixture.armBranch;
			}
			if (failure === "mismatched boundary") {
				postCompactionBranch = [
					...fixture.armBranch,
					{ ...fixture.entry, summary: "different persisted summary" },
				];
			}
			if (failure === "insufficient headroom") {
				eventEntry = {
					...fixture.entry,
					firstKeptEntryId: "raw-1",
				};
				postCompactionBranch = [...fixture.armBranch, eventEntry];
				result = { ...fixture.result, firstKeptEntryId: "raw-1" };
			}
			const { handlers, pi, runtime } = captureLifecycleHandlers({
				compactAfterTokens: 3,
				compactionTrigger: "betweenTurns",
			});
			const ctx = fakeCtx([fixture.armBranch, postCompactionBranch]);

			handlers.turnEnd(toolTurnEnd(), ctx);
			const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
			const callbacks = ctx.compact.mock.calls[0][0];
			handlers.sessionCompact({
				type: "session_compact",
				compactionEntry: eventEntry,
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			}, ctx);
			callbacks.onComplete(result);
			await settlement;

			expect(runtime.compactInFlight).toBe(false);
			expect(pi.sendMessage).not.toHaveBeenCalled();
			const invariantNotifications = ctx.ui.notify.mock.calls.filter(
				([message, level]) => message === "Observational memory: between-turn compaction completed without safe continuation proof; automatic continuation skipped" && level === "error",
			);
			expect(invariantNotifications).toHaveLength(1);
		},
	);

	it.each(["threshold", "overflow"] as const)(
		"does not continue from a Pi-owned %s compaction event",
		async (reason) => {
			const fixture = successfulCompactionFixture();
			const { handlers, pi, runtime } = captureLifecycleHandlers({
				compactAfterTokens: 3,
				compactionTrigger: "betweenTurns",
			});
			const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch]);

			handlers.turnEnd(toolTurnEnd(), ctx);
			const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
			const callbacks = ctx.compact.mock.calls[0][0];
			handlers.sessionCompact({
				type: "session_compact",
				compactionEntry: fixture.entry,
				fromExtension: false,
				reason,
				willRetry: reason === "overflow",
			}, ctx);
			callbacks.onComplete(fixture.result);
			await settlement;

			expect(runtime.compactInFlight).toBe(false);
			expect(pi.sendMessage).not.toHaveBeenCalled();
		},
	);

	it("clears the cycle when abort throws", () => {
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch], {
			abort: vi.fn(() => {
				throw new Error("abort failed");
			}),
		});

		handlers.turnEnd(toolTurnEnd(), ctx);

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("releases an in-progress compaction wait on session shutdown", async () => {
		const fixture = successfulCompactionFixture();
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		const callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		await settlement;

		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: fixture.entry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(fixture.result);
		await Promise.resolve();

		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it.each([
		{ state: "pending", startContinuation: false },
		{ state: "active", startContinuation: true },
	])("releases a $state continuation on session shutdown", async ({ startContinuation }) => {
		const fixture = successfulCompactionFixture();
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		const callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: fixture.entry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(fixture.result);
		await Promise.resolve();
		if (startContinuation) {
			handlers.messageStart(continuationMessageStart(pi), ctx);
		}

		handlers.sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		await settlement;

		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("clears an armed cycle when the session changes before settlement", async () => {
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch]);
		ctx.sessionManager.getSessionId
			.mockReturnValueOnce("session-1")
			.mockReturnValue("session-2");

		handlers.turnEnd(toolTurnEnd(), ctx);
		await handlers.agentSettled({ type: "agent_settled" }, ctx);

		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("clears a pending continuation when startup settles before its message starts", async () => {
		const fixture = successfulCompactionFixture();
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const originatingSettlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		const callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: fixture.entry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(fixture.result);
		await Promise.resolve();

		try {
			await handlers.agentSettled({ type: "agent_settled" }, ctx);
			expect(runtime.compactInFlight).toBe(false);
			await originatingSettlement;
		} finally {
			handlers.sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
			await originatingSettlement;
		}
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("clears the cycle when continuation safety proof throws", async () => {
		const fixture = successfulCompactionFixture();
		const malformedKeptEntry = new Proxy(fixture.armBranch[1], {
			get(target, property, receiver) {
				if (property === "content") {
					throw new Error("persisted continuation proof failed");
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const postCompactionBranch = [
			fixture.armBranch[0],
			malformedKeptEntry,
			fixture.entry,
		];
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, postCompactionBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		const callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: fixture.entry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(fixture.result);

		await expect(settlement).rejects.toThrow("persisted continuation proof failed");
		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("refuses continuation when the manual compaction event is missing", async () => {
		const fixture = successfulCompactionFixture();
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		const callbacks = ctx.compact.mock.calls[0][0];
		callbacks.onComplete(fixture.result);
		await settlement;

		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: between-turn compaction completed without safe continuation proof; automatic continuation skipped",
			"error",
		);
	});

	it.each([
		{ message: "Compaction cancelled", notification: undefined },
		{ message: "native summarization failed", notification: "Observational memory: native summarization failed" },
	])("clears the cycle when compaction reports $message", async ({ message, notification }) => {
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([dueBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		const callbacks = ctx.compact.mock.calls[0][0];
		callbacks.onError(new Error(message));
		await settlement;

		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		if (notification) {
			expect(ctx.ui.notify).toHaveBeenCalledWith(notification, "error");
		} else {
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			"Observational memory: Compaction cancelled",
			"error",
			);
		}
	});

	it("nests repeated cycles and releases parent settlements in LIFO order", async () => {
		const first = successfulCompactionFixture();
		const secondArmBranch = [
			...first.postCompactionBranch,
			textCustomMessage("raw-3", "aaaaaaaaaaaa"),
			textCustomMessage("raw-4", "aaaa"),
		];
		const secondEntry = {
			...compactionEntry("cmp-second", { firstKeptEntryId: "raw-4", summary: "second summary" }),
			tokensBefore: 5,
		};
		const secondResult = {
			summary: "second summary",
			firstKeptEntryId: "raw-4",
			tokensBefore: 5,
			estimatedTokensAfter: 1,
		};
		const secondPostBranch = [...secondArmBranch, secondEntry];
		const { handlers, pi } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([
			first.armBranch,
			first.postCompactionBranch,
			secondArmBranch,
			secondPostBranch,
		]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const rootSettlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		let callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: first.entry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(first.result);
		await Promise.resolve();
		handlers.messageStart(continuationMessageStart(pi), ctx);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const firstContinuationSettlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		callbacks = ctx.compact.mock.calls[1][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: secondEntry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(secondResult);
		await Promise.resolve();
		handlers.messageStart(continuationMessageStart(pi), ctx);

		await handlers.agentSettled({ type: "agent_settled" }, ctx);
		await firstContinuationSettlement;
		await rootSettlement;

		expect(ctx.abort).toHaveBeenCalledTimes(2);
		expect(ctx.compact).toHaveBeenCalledTimes(2);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const tokens = pi.sendMessage.mock.calls.map(([message]) => message.details.token);
		expect(new Set(tokens).size).toBe(2);
	});

	it("uses the ratio threshold captured when the cycle was armed", async () => {
		const fixture = successfulCompactionFixture();
		const { handlers, pi } = captureLifecycleHandlers({
			compactAfterTokens: 81_000,
			compactAfterTokensMode: "ratio",
			compactAfterTokensRatio: 0.5,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch], {
			model: { contextWindow: 8 },
		});

		handlers.turnEnd(toolTurnEnd(), ctx);
		ctx.model = { contextWindow: 2 };
		const settlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		const callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: fixture.entry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(fixture.result);
		await Promise.resolve();

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		handlers.messageStart(continuationMessageStart(pi), ctx);
		await handlers.agentSettled({ type: "agent_settled" }, ctx);
		await settlement;
	});

	it("consumes only the matching continuation token once", async () => {
		const fixture = successfulCompactionFixture();
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);
		const originalSettlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		const callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: fixture.entry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(fixture.result);
		await Promise.resolve();

		const matchingStart = continuationMessageStart(pi);
		handlers.messageStart({
			...matchingStart,
			message: {
				...matchingStart.message,
				details: { ...matchingStart.message.details, token: "wrong-token" },
			},
		}, ctx);
		expect(runtime.compactInFlight).toBe(true);

		handlers.messageStart(matchingStart, ctx);
		handlers.messageStart(matchingStart, ctx);
		expect(runtime.compactInFlight).toBe(false);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		await handlers.agentSettled({ type: "agent_settled" }, ctx);
		await originalSettlement;
	});

	it("aborts at a due tool boundary, compacts after settlement, and awaits host-fallback continuation", async () => {
		const fixture = successfulCompactionFixture();
		const { handlers, pi, runtime } = captureLifecycleHandlers({
			compactAfterTokens: 3,
			compactionTrigger: "betweenTurns",
		});
		const ctx = fakeCtx([fixture.armBranch, fixture.postCompactionBranch]);

		handlers.turnEnd(toolTurnEnd(), ctx);

		expect(ctx.abort).toHaveBeenCalledTimes(1);
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(true);

		const originalSettlement = handlers.agentSettled({ type: "agent_settled" }, ctx);
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		const callbacks = ctx.compact.mock.calls[0][0];
		handlers.sessionCompact({
			type: "session_compact",
			compactionEntry: fixture.entry,
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		}, ctx);
		callbacks.onComplete(fixture.result);
		await Promise.resolve();

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			{
				customType: "om.compaction.continue",
				content: "Continue the interrupted work from the compacted context.",
				display: false,
				details: {
					token: expect.any(String),
					compactionEntryId: "cmp-new",
				},
			},
			{ triggerTurn: true },
		);
		let parentSettled = false;
		void originalSettlement.then(() => {
			parentSettled = true;
		});
		await Promise.resolve();
		expect(parentSettled).toBe(false);

		handlers.messageStart(continuationMessageStart(pi), ctx);
		expect(runtime.compactInFlight).toBe(false);
		await handlers.agentSettled({ type: "agent_settled" }, ctx);
		await originalSettlement;
		expect(parentSettled).toBe(true);
	});
});
