import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
	OM_OBSERVER_COMPLETED,
	OM_OBSERVATIONS_RECORDED,
	compactionAuthority,
	type Entry,
} from "../src/session-ledger/index.js";
import {
	PROPERTY_OPTIONS,
	observationsEntry,
	sourceEntry,
} from "./fixtures/property.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
} from "./fixtures/session.js";

function sourceIds(count: number, prefix = "source"): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

function entriesWithRecordedCoverage(ids: string[], coverageIndex: number): Entry[] {
	return [
		...ids.map((id, index) => sourceEntry(id, index)),
		observationsEntry(
			"om-coverage",
			[observation("aaaaaaaaaaaa", { sourceEntryIds: [ids[coverageIndex]] })],
			ids[coverageIndex],
		),
	];
}

const boundaryScenarioArb = fc.integer({ min: 2, max: 12 }).chain((count) =>
	fc.record({
		count: fc.constant(count),
		firstKeptIndex: fc.integer({ min: 1, max: count - 1 }),
		coverageIndex: fc.integer({ min: 0, max: count - 1 }),
	}),
);

const monotonicScenarioArb = fc.integer({ min: 2, max: 12 }).chain((count) => {
	return fc.integer({ min: 1, max: count - 1 }).chain((firstKeptIndex) => {
		return fc.integer({ min: 0, max: count - 1 }).chain((earlierCoverageIndex) =>
			fc.integer({ min: earlierCoverageIndex, max: count - 1 }).map((laterCoverageIndex) => ({
				count,
				firstKeptIndex,
				earlierCoverageIndex,
				laterCoverageIndex,
			})),
		);
	});
});

const invalidCoverageMarkerArb: fc.Arbitrary<Entry> = fc.oneof(
	fc.anything().map((noise) => ({
		type: "custom",
		id: "invalid-empty",
		customType: OM_OBSERVER_COMPLETED,
		data: { outcome: "recorded", coversUpToId: "source-0", noise },
	})),
	fc.anything().map((noise) => ({
		type: "custom",
		id: "invalid-recorded",
		customType: OM_OBSERVATIONS_RECORDED,
		data: { observations: [], coversUpToId: "source-0", noise },
	})),
	fc.constant({
		type: "custom",
		id: "orphan-recorded",
		customType: OM_OBSERVATIONS_RECORDED,
		data: {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["source-0"] })],
			coversUpToId: "missing",
		},
	}),
	fc.constant({
		type: "custom",
		id: "non-source-empty",
		customType: OM_OBSERVER_COMPLETED,
		data: { outcome: "empty", coversUpToId: "metadata" },
	}),
);

describe("Compaction Authority properties", () => {
	it("authorizes exactly when source-backed coverage reaches the last source before first kept", () => {
		fc.assert(
			fc.property(boundaryScenarioArb, ({ count, firstKeptIndex, coverageIndex }) => {
				const ids = sourceIds(count);
				const decision = compactionAuthority(
					entriesWithRecordedCoverage(ids, coverageIndex),
					ids[firstKeptIndex],
				);

				expect(decision.owner).toBe(
					coverageIndex >= firstKeptIndex - 1 ? "observational-memory" : "host",
				);
				expect(decision.pruneBoundaryId).toBe(ids[firstKeptIndex - 1]);
				expect(decision.coverageBoundaryId).toBe(ids[coverageIndex]);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("never revokes observational-memory authority when valid coverage advances", () => {
		fc.assert(
			fc.property(
				monotonicScenarioArb,
				({ count, firstKeptIndex, earlierCoverageIndex, laterCoverageIndex }) => {
					const ids = sourceIds(count);
					const earlier = compactionAuthority(
						entriesWithRecordedCoverage(ids, earlierCoverageIndex),
						ids[firstKeptIndex],
					);
					const later = compactionAuthority(
						entriesWithRecordedCoverage(ids, laterCoverageIndex),
						ids[firstKeptIndex],
					);

					if (earlier.owner === "observational-memory") {
						expect(later.owner).toBe("observational-memory");
					}
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("is invariant under context-invisible metadata insertion", () => {
		fc.assert(
			fc.property(
				boundaryScenarioArb,
				fc.array(fc.nat(), { maxLength: 12 }),
				({ count, firstKeptIndex, coverageIndex }, insertionPoints) => {
					const ids = sourceIds(count);
					const entries = entriesWithRecordedCoverage(ids, coverageIndex);
					const expected = compactionAuthority(entries, ids[firstKeptIndex]);
					const withMetadata = [...entries];
					for (let index = 0; index < insertionPoints.length; index++) {
						const insertAt = insertionPoints[index] % (withMetadata.length + 1);
						withMetadata.splice(insertAt, 0, {
							type: "custom",
							id: `metadata-${index}`,
							customType: "om.test.metadata",
							data: { index },
						});
					}

					expect(compactionAuthority(withMetadata, ids[firstKeptIndex])).toEqual(expected);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("never grants authority to malformed, orphaned, or non-source coverage", () => {
		fc.assert(
			fc.property(invalidCoverageMarkerArb, (marker) => {
				const entries: Entry[] = [
					sourceEntry("source-0"),
					{ type: "custom", id: "metadata", customType: "om.test.metadata", data: {} },
					sourceEntry("source-1", 1),
					marker,
				];

				expect(compactionAuthority(entries, "source-1")).toMatchObject({
					owner: "host",
					reason: "uncovered",
					pruneBoundaryId: "source-0",
				});
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("scopes authority to source newly pruned after prior native and OM compactions", () => {
		fc.assert(
			fc.property(
				boundaryScenarioArb,
				fc.boolean(),
				({ count, firstKeptIndex, coverageIndex }, previousWasOm) => {
					const ids = sourceIds(count, "live");
					const previous = compactionEntry("previous-compaction", {
						firstKeptEntryId: ids[0],
						details: previousWasOm ? memoryDetails() : undefined,
					});
					const entries: Entry[] = [
						sourceEntry("already-compacted"),
						sourceEntry(ids[0], 0),
						previous,
						...ids.slice(1).map((id, index) => sourceEntry(id, index + 1)),
						observationsEntry(
							"current-coverage",
							[observation("aaaaaaaaaaaa", { sourceEntryIds: [ids[coverageIndex]] })],
							ids[coverageIndex],
						),
					];

					const decision = compactionAuthority(entries, ids[firstKeptIndex]);
					expect(decision.owner).toBe(
						coverageIndex >= firstKeptIndex - 1 ? "observational-memory" : "host",
					);
					expect(decision.pruneBoundaryId).toBe(ids[firstKeptIndex - 1]);
				},
			),
			PROPERTY_OPTIONS,
		);
	});
});
