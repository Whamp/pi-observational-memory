import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "../src/commands/status.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: { entries: TestEntry[]; runtime?: Partial<any> }) {
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om-status");
			handler = command.handler;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			observeAfterTokens: 10,
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			passive: false,
		},
		observerInFlight: false,
		reflectDropInFlight: false,
		compactInFlight: false,
		compactHookInFlight: false,
		lastObserverError: undefined,
		lastReflectDropError: undefined,
		...args.runtime,
	};
	registerStatusCommand(pi as any, runtime as any);
	if (!handler) throw new Error("status handler not registered");
	const notify = vi.fn();
	const ctx = { cwd: "/tmp/project", ui: { notify }, sessionManager: { getBranch: () => args.entries } };
	const run = async () => {
		await handler!(undefined, ctx);
		return notify.mock.calls.at(-1)?.[0] as string;
	};
	return { run, notify };
}

describe("V3 /om-status", () => {
	it("renders concise no-memory status without V2 committed/pending language", async () => {
		const output = await setup({ entries: [] }).run();

		expect(output).toContain("── Memory ──");
		expect(output).toContain("Observations: 0 recorded / 0 dropped / 0 visible");
		expect(output).toContain("Reflections:  0 recorded / 0 visible");
		expect(output).toContain("Next observation:");
		expect(output).toContain("Next compaction:");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("committed");
		expect(output).not.toContain("pending");
	});

	it("reports V3 ledger counts, visible/full drift, and ignores old V2 memory", async () => {
		const obsA = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obsB = observation("bbbbbbbbbbbb", { tokenCount: 7 });
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
			compactionEntry("cmp-visible", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obsA], reflections: [] }) }),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ref" }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Observations: 2 recorded / 1 dropped / 1 visible +1 -1");
		expect(output).toContain("Reflections:  1 recorded / 0 visible +1");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("full truth");
		expect(output).not.toContain("v2-obs");
		expect(output).not.toContain("observational-memory");
	});

	it("shows separate progress clocks and observation/reflection pools", async () => {
		const obs = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp", { firstKeptEntryId: "raw-2", details: memoryDetails({ observations: [obs], reflections: [ref] }) }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Next observation:");
		expect(output).toContain("/ 10 tokens");
		expect(output).toContain("Next reflection:");
		expect(output).toContain("/ 20 tokens");
		expect(output).toContain("Next drop:");
		expect(output).toContain("Next compaction:");
		expect(output).toContain("/ 30 tokens");
		expect(output).toContain("Observation pool:");
		expect(output).toContain("~5 / 40 tokens (13%)");
		expect(output).toContain("Reflection pool:  ~3 tokens");
		expect(output).not.toContain("Full fold pool:");
		expect(output).not.toContain("visible observation tokens");
	});

	it("shows passive mode, workers in flight, and last errors", async () => {
		const output = await setup({
			entries: [],
			runtime: {
				config: { observeAfterTokens: 10, reflectAfterTokens: 20, compactAfterTokens: 30, observationsPoolMaxTokens: 40, passive: true },
				observerInFlight: true,
				reflectDropInFlight: true,
				compactInFlight: true,
				compactHookInFlight: true,
				lastObserverError: "observer failed",
				lastReflectDropError: "drop failed",
			},
		}).run();

		expect(output).toContain("Passive: automatic memory workers and auto-compaction disabled");
		expect(output).toContain("Observer: running");
		expect(output).toContain("Reflect/drop: running");
		expect(output).toContain("Auto-compaction: running");
		expect(output).toContain("Compaction hook: running");
		expect(output).toContain("Observer: observer failed");
		expect(output).toContain("Reflect/drop: drop failed");
	});
});
