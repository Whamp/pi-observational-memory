import { describe, expect, it } from "vitest";

import { compactionAuthority } from "../src/session-ledger/index.js";
import {
	compactionEntry,
	observation,
	observerCompletedEntry,
	observationsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("Compaction Authority", () => {
	it("grants observational-memory authority when Recorded coverage reaches the final pruned source", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-observation", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })],
				coversUpToId: "raw-1",
			}),
		];

		expect(compactionAuthority(entries, "raw-2")).toEqual({
			owner: "observational-memory",
			reason: "covered",
			coverageBoundaryId: "raw-1",
			pruneBoundaryId: "raw-1",
		});
	});

	it("grants observational-memory authority when explicit Empty coverage reaches the final pruned source", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			observerCompletedEntry("om-empty", { outcome: "empty", coversUpToId: "raw-1" }),
		];

		expect(compactionAuthority(entries, "raw-2")).toEqual({
			owner: "observational-memory",
			reason: "covered",
			coverageBoundaryId: "raw-1",
			pruneBoundaryId: "raw-1",
		});
	});

	it("does not authorize against source already represented by the previous compaction", () => {
		const entries = [
			textCustomMessage("raw-old", "aaaa"),
			observationsRecordedEntry("om-old", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-old"] })],
				coversUpToId: "raw-old",
			}),
			textCustomMessage("raw-live", "bbbb"),
			compactionEntry("compaction-1", { firstKeptEntryId: "raw-live" }),
		];

		expect(compactionAuthority(entries, "raw-live")).toEqual({
			owner: "host",
			reason: "no-pruned-source",
		});
	});
});
