import { describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observerCompletedEntry,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

type HookApi = Parameters<typeof registerCompactionHook>[0];
type HookHandler = Parameters<HookApi["on"]>[1];
type HookContext = Parameters<HookHandler>[1];
type HookResult = Awaited<ReturnType<HookHandler>>;

function requireCompaction(result: HookResult) {
	if (!result.compaction) {
		throw new Error("expected observational-memory compaction");
	}
	return result.compaction;
}

function setup(args: { entries: TestEntry[]; observationsPoolMaxTokens?: number; compactHookInFlight?: boolean }) {
	let handler: HookHandler | undefined;
	const pi: HookApi = {
		on: vi.fn((eventName, callback) => {
			expect(eventName).toBe("session_before_compact");
			handler = callback;
		}),
	};
	const runtime = new Runtime();
	runtime.config = {
		...runtime.config,
		observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 20_000,
	};
	runtime.configLoaded = true;
	runtime.compactHookInFlight = args.compactHookInFlight ?? false;
	vi.spyOn(runtime, "resolveModel");
	registerCompactionHook(pi, runtime);
	if (!handler) throw new Error("compaction handler was not registered");
	const registeredHandler = handler;
	const ctx: HookContext = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/tmp/test-session.jsonl",
		},
	};
	const run = (firstKeptEntryId = args.entries.at(-1)?.id ?? "missing") => registeredHandler({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
	}, ctx);
	return { runtime, ctx, run };
}

describe("V3 compaction hook", () => {
	it("relinquishes authority when fresh source is uncovered", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { run, runtime } = setup({ entries });

		const result = await run("raw-2");

		expect(result).toEqual({});
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it.each([
		{
			name: "partial coverage",
			entries: [
				textCustomMessage("raw-1", "aaaa"),
				textCustomMessage("raw-2", "bbbb"),
				textCustomMessage("raw-3", "cccc"),
				observationsRecordedEntry("om-partial", {
					observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })],
					coversUpToId: "raw-1",
				}),
			],
			firstKeptEntryId: "raw-3",
		},
		{
			name: "Failed or absent coverage",
			entries: [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")],
			firstKeptEntryId: "raw-2",
		},
		{
			name: "malformed Empty coverage",
			entries: [
				textCustomMessage("raw-1", "aaaa"),
				observerCompletedEntry("om-malformed", { outcome: "empty", coversUpToId: "raw-1" }, {
					data: { outcome: "recorded", coversUpToId: "raw-1" },
				}),
				textCustomMessage("raw-2", "bbbb"),
			],
			firstKeptEntryId: "raw-2",
		},
		{
			name: "orphaned coverage",
			entries: [
				textCustomMessage("raw-1", "aaaa"),
				observerCompletedEntry("om-orphan", { outcome: "empty", coversUpToId: "missing" }),
				textCustomMessage("raw-2", "bbbb"),
			],
			firstKeptEntryId: "raw-2",
		},
		{
			name: "non-source coverage",
			entries: [
				textCustomMessage("raw-1", "aaaa"),
				oldV2ObservationEntry("metadata-boundary"),
				observerCompletedEntry("om-non-source", { outcome: "empty", coversUpToId: "metadata-boundary" }),
				textCustomMessage("raw-2", "bbbb"),
			],
			firstKeptEntryId: "raw-2",
		},
		{
			name: "unresolved first-kept boundary",
			entries: [textCustomMessage("raw-1", "aaaa")],
			firstKeptEntryId: "missing",
		},
	])("relinquishes authority for $name", async ({ entries, firstKeptEntryId }) => {
		const { run, runtime, ctx } = setup({ entries });

		await expect(run(firstKeptEntryId)).resolves.toEqual({});
		expect(runtime.compactHookInFlight).toBe(false);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("keeps Empty completion metadata out of compaction details and summaries", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observerCompletedEntry("om-empty", { outcome: "empty", coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { run } = setup({ entries });

		const compaction = requireCompaction(await run("raw-2"));

		expect(compaction).toMatchObject({
			details: { observations: [], reflections: [] },
			summary: "",
		});
	});

	it("first normal compaction writes covered observations without orphan reflections", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const compaction = requireCompaction(await run("raw-2"));

		expect(compaction.details.fullFold).toBe(false);
		expect(compaction.details.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(compaction.details.reflections).toEqual([]);
		expect(compaction.summary).toContain("## Observations");
		expect(compaction.summary).not.toContain("## Reflections");
	});

	it("writes a normal V3 projection without applying new reflections or drops", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const compaction = requireCompaction(await run("raw-2"));

		expect(compaction.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
		expect(compaction.details.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(compaction.details.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(compaction.summary).toContain("## Reflections\n[eeeeeeeeeeee]");
		expect(compaction.summary).toContain("## Observations");
	});

	it("writes a full V3 projection when observation pool pressure reaches the threshold", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const compaction = requireCompaction(await run("raw-2"));

		expect(compaction.details.fullFold).toBe(true);
		expect(compaction.details.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(compaction.details.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
	});

	it("ignores old V2 memory entries and details", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
			observerCompletedEntry("om-empty", { outcome: "empty", coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { run } = setup({ entries });

		const compaction = requireCompaction(await run("raw-2"));

		expect(compaction.details).toMatchObject({
			type: "om.folded",
			observations: [],
			reflections: [],
		});
	});

	it("does not wait for worker promises or call model resolution", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observerCompletedEntry("om-empty", { outcome: "empty", coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { run, runtime } = setup({ entries });

		const result = await Promise.race([
			run("raw-2"),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 50)),
		]);

		expect(result).toMatchObject({ compaction: { details: { type: "om.folded" } } });
		expect(runtime.resolveModel).not.toHaveBeenCalled();
	});

	it("cancels duplicate in-flight compaction and notifies the UI", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, ctx } = setup({ entries, compactHookInFlight: true });

		await expect(run("raw-1")).resolves.toEqual({ cancel: true });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: another compaction is already in progress; cancelling duplicate",
			"warning",
		);
	});
});
