import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
	OM_OBSERVER_COMPLETED,
	OM_OBSERVATIONS_RECORDED,
	buildCompactionProjection,
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

function authorityFor(entries: Entry[], firstKeptEntryId: string) {
	const projection = buildCompactionProjection(entries, firstKeptEntryId, {
		observationsPoolMaxTokens: Number.POSITIVE_INFINITY,
	});
	return compactionAuthority(entries, firstKeptEntryId, projection);
}

const boundaryScenarioArb = fc.integer({ min: 2, max: 12 }).chain((count) =>
	fc.record({
		count: fc.constant(count),
		firstKeptIndex: fc.integer({ min: 1, max: count - 1 }),
		coverageIndex: fc.integer({ min: 0, max: count - 1 }),
	}),
);

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

describe("projection-aware Compaction Authority properties", () => {
	it("authorizes exactly when source coverage reaches the prune boundary and its batch is projected", () => {
		fc.assert(
			fc.property(boundaryScenarioArb, ({ count, firstKeptIndex, coverageIndex }) => {
				const ids = sourceIds(count);
				const decision = authorityFor(
					entriesWithRecordedCoverage(ids, coverageIndex),
					ids[firstKeptIndex],
				);
				const reachesPrunedSource = coverageIndex >= firstKeptIndex - 1;
				const batchIsProjected = coverageIndex <= firstKeptIndex;

				expect(decision.owner).toBe(
					reachesPrunedSource && batchIsProjected ? "observational-memory" : "host",
				);
				expect(decision.pruneBoundaryId).toBe(ids[firstKeptIndex - 1]);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("rejects every cross-boundary batch excluded from the projection", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 12 }),
				fc.integer({ min: 1, max: 10 }),
				(count, rawOffset) => {
					const firstKeptIndex = 1 + (rawOffset % (count - 2));
					const coverageIndex = firstKeptIndex + 1;
					const ids = sourceIds(count);
					const decision = authorityFor(
						entriesWithRecordedCoverage(ids, coverageIndex),
						ids[firstKeptIndex],
					);

					expect(decision).toMatchObject({
						owner: "host",
						reason: "projection-incomplete",
						pruneBoundaryId: ids[firstKeptIndex - 1],
					});
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
					const expected = authorityFor(entries, ids[firstKeptIndex]);
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

					expect(authorityFor(withMetadata, ids[firstKeptIndex])).toEqual(expected);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("never grants authority to malformed, orphaned, or Empty coverage", () => {
		fc.assert(
			fc.property(invalidCoverageMarkerArb, (marker) => {
				const entries: Entry[] = [
					sourceEntry("source-0"),
					{ type: "custom", id: "metadata", customType: "om.test.metadata", data: {} },
					sourceEntry("source-1", 1),
					marker,
				];

				expect(authorityFor(entries, "source-1")).toMatchObject({
					owner: "host",
					pruneBoundaryId: "source-0",
				});
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("scopes authority to source newly pruned after native and OM compactions", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				(previousWasOm) => {
					const ids = sourceIds(4, "live");
					const previous = compactionEntry("previous-compaction", {
						firstKeptEntryId: ids[0],
						details: previousWasOm ? memoryDetails() : undefined,
					});
					const entries: Entry[] = [
						sourceEntry("already-compacted"),
						sourceEntry(ids[0], 0),
						previous,
						sourceEntry(ids[1], 1),
						observationsEntry(
							"current-coverage",
							[observation("aaaaaaaaaaaa", { sourceEntryIds: [ids[1]] })],
							ids[1],
						),
						sourceEntry(ids[2], 2),
						sourceEntry(ids[3], 3),
					];

					expect(authorityFor(entries, ids[2])).toMatchObject({
					owner: "observational-memory",
					pruneBoundaryId: ids[1],
				});
				},
			),
			PROPERTY_OPTIONS,
		);
	});
});
