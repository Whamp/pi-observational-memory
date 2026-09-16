import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildCompactionProjection,
	diffProjection,
	foldLedger,
	fullProjection,
	isMemoryDetails,
	latestCoverageIndex,
	latestCoverageMarkerId,
	rawTokensAfterIndex,
	visibleProjection,
	type Entry,
	type Projection,
} from "../src/session-ledger/index.js";
import {
	PROPERTY_OPTIONS,
	dropsEntry,
	entryIdArb,
	idsOf,
	ledgerScenarioArb,
	memoryIdArb,
	observationArb,
	observationsEntry,
	sorted,
	sourceEntry,
} from "./fixtures/property.js";

const invalidMemoryEntryArb: fc.Arbitrary<Entry> = fc.record({
	type: fc.constant("custom"),
	id: entryIdArb,
	customType: fc.constantFrom(OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED, OM_OBSERVATIONS_DROPPED, "om.unknown"),
	data: fc.oneof(
		fc.constant({ observations: [], coversUpToId: "" }),
		fc.constant({ reflections: [], coversUpToId: "" }),
		fc.constant({ observationIds: [], coversUpToId: "" }),
		fc.constant({ observations: [{ id: "not-a-valid-observation" }], coversUpToId: "missing" }),
		fc.anything(),
	),
});

describe("session-ledger property invariants", () => {
	it("should fold generated V3 ledger scenarios into active, dropped, and reflection sets", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, (scenario) => {
				// Arrange
				const dropped = new Set(scenario.droppedIds);

				// Act
				const folded = foldLedger(scenario.entries);

				// Assert
				expect(idsOf(folded.observations)).toEqual(idsOf(scenario.observations));
				expect(idsOf(folded.activeObservations)).toEqual(idsOf(scenario.observations.filter((observation) => !dropped.has(observation.id))));
				expect(sorted(folded.droppedObservationIds)).toEqual(sorted(scenario.droppedIds));
				expect(idsOf(folded.reflections)).toEqual(idsOf(scenario.reflections));
				for (const observation of scenario.observations) expect(folded.observationsById.get(observation.id)).toBe(observation);
				for (const reflection of scenario.reflections) expect(folded.reflectionsById.get(reflection.id)).toBe(reflection);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should make upToEntryId folding equivalent to folding the branch prefix", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, fc.nat(), (scenario, rawIndex) => {
				// Arrange
				const index = rawIndex % scenario.entries.length;
				const targetEntry = scenario.entries[index];
				const prefix = scenario.entries.slice(0, index + 1);

				// Act
				const bounded = foldLedger(scenario.entries, { upToEntryId: targetEntry.id });
				const foldedPrefix = foldLedger(prefix);

				// Assert
				expect(idsOf(bounded.observations)).toEqual(idsOf(foldedPrefix.observations));
				expect(idsOf(bounded.activeObservations)).toEqual(idsOf(foldedPrefix.activeObservations));
				expect(idsOf(bounded.reflections)).toEqual(idsOf(foldedPrefix.reflections));
				expect(sorted(bounded.droppedObservationIds)).toEqual(sorted(foldedPrefix.droppedObservationIds));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should keep fullProjection aligned with foldLedger at the branch tip", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, (scenario) => {
				// Arrange
				const folded = foldLedger(scenario.entries);

				// Act
				const full = fullProjection(scenario.entries);

				// Assert
				expect(idsOf(full.observations)).toEqual(idsOf(folded.activeObservations));
				expect(idsOf(full.reflections)).toEqual(idsOf(folded.reflections));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should ignore invalid and unknown custom ledger noise wherever it appears", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, fc.array(invalidMemoryEntryArb, { maxLength: 20 }), fc.nat(), (scenario, noise, rawIndex) => {
				// Arrange
				const insertAt = rawIndex % (scenario.entries.length + 1);
				const noisyEntries = [
					...scenario.entries.slice(0, insertAt),
					...noise,
					...scenario.entries.slice(insertAt),
				];

				// Act
				const expected = foldLedger(scenario.entries);
				const folded = foldLedger(noisyEntries);

				// Assert
				expect(idsOf(folded.observations)).toEqual(idsOf(expected.observations));
				expect(idsOf(folded.activeObservations)).toEqual(idsOf(expected.activeObservations));
				expect(idsOf(folded.reflections)).toEqual(idsOf(expected.reflections));
				expect(sorted(folded.droppedObservationIds)).toEqual(sorted(expected.droppedObservationIds));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should build valid compaction details that mirror the returned projection", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, fc.integer({ min: 0, max: 200_000 }), (scenario, observationsPoolMaxTokens) => {
				// Act
				const projection = buildCompactionProjection(scenario.entries, scenario.coverageId, { observationsPoolMaxTokens });

				// Assert
				expect(isMemoryDetails(projection.details)).toBe(true);
				expect(projection.details.fullFold).toBe(projection.fullFold);
				expect(projection.details.observations).toBe(projection.observations);
				expect(projection.details.reflections).toBe(projection.reflections);
				if (projection.fullFold) {
					const fullAtBoundary = fullProjection(scenario.entries, scenario.coverageId);
					expect(idsOf(projection.observations)).toEqual(idsOf(fullAtBoundary.observations));
					expect(idsOf(projection.reflections)).toEqual(idsOf(fullAtBoundary.reflections));
				}
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should make bounded visibleProjection match buildCompactionProjection with an infinite pool", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, fc.nat(), (scenario, rawIndex) => {
				// Arrange
				const boundary = scenario.entries[rawIndex % scenario.entries.length].id;

				// Act
				const visible = visibleProjection(scenario.entries, boundary);
				const projection = buildCompactionProjection(scenario.entries, boundary, { observationsPoolMaxTokens: Number.POSITIVE_INFINITY });

				// Assert
				expect(idsOf(visible.observations)).toEqual(idsOf(projection.observations));
				expect(idsOf(visible.reflections)).toEqual(idsOf(projection.reflections));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should return the latest V3 compaction details as the visible projection", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, ledgerScenarioArb, (earlier, latest) => {
				// Arrange
				const earlierProjection = buildCompactionProjection(earlier.entries, earlier.coverageId, { observationsPoolMaxTokens: 1 });
				const latestProjection = buildCompactionProjection(latest.entries, latest.coverageId, { observationsPoolMaxTokens: 1 });
				const entries: Entry[] = [
					...earlier.entries,
					{ type: "compaction", id: "compaction-earlier", details: earlierProjection.details },
					...latest.entries,
					{ type: "compaction", id: "compaction-latest", details: latestProjection.details },
				];

				// Act
				const visible = visibleProjection(entries);

				// Assert
				expect(idsOf(visible.observations)).toEqual(idsOf(latestProjection.observations));
				expect(idsOf(visible.reflections)).toEqual(idsOf(latestProjection.reflections));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should partition projection diffs without overlapping visible and full ids", () => {
		const projectionArb: fc.Arbitrary<Projection> = ledgerScenarioArb.map((scenario) => fullProjection(scenario.entries));
		fc.assert(
			fc.property(projectionArb, projectionArb, (visible, full) => {
				// Act
				const diff = diffProjection(visible, full);

				// Assert
				const visibleObservationIds = new Set(idsOf(visible.observations));
				const fullObservationIds = new Set(idsOf(full.observations));
				const visibleReflectionIds = new Set(idsOf(visible.reflections));
				expect(diff.observationsOnlyInFull.every((observation) => fullObservationIds.has(observation.id) && !visibleObservationIds.has(observation.id))).toBe(true);
				expect(diff.droppedOnlyInFull.every((observation) => visibleObservationIds.has(observation.id) && !fullObservationIds.has(observation.id))).toBe(true);
				expect(diff.reflectionsOnlyInFull.every((reflection) => !visibleReflectionIds.has(reflection.id))).toBe(true);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should make raw token counts monotonic as the covered index advances", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, fc.nat(), fc.nat(), (scenario, rawA, rawB) => {
				// Arrange
				const indexA = rawA % scenario.entries.length;
				const indexB = rawB % scenario.entries.length;
				const earlier = Math.min(indexA, indexB);
				const later = Math.max(indexA, indexB);

				// Act
				const tokensAfterEarlier = rawTokensAfterIndex(scenario.entries, earlier);
				const tokensAfterLater = rawTokensAfterIndex(scenario.entries, later);

				// Assert
				expect(tokensAfterEarlier).toBeGreaterThanOrEqual(tokensAfterLater);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should track the greatest covered branch position for each ledger stream", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, (scenario) => {
				// Arrange
				const coverageIndex = scenario.entries.findIndex((entry) => entry.id === scenario.coverageId);
				const expectations: Array<[typeof OM_OBSERVATIONS_RECORDED | typeof OM_REFLECTIONS_RECORDED | typeof OM_OBSERVATIONS_DROPPED, boolean]> = [
					[OM_OBSERVATIONS_RECORDED, scenario.observations.length > 0],
					[OM_REFLECTIONS_RECORDED, scenario.reflections.length > 0],
					[OM_OBSERVATIONS_DROPPED, scenario.droppedIds.length > 0],
				];

				// Act / Assert
				for (const [customType, hasLedgerEntry] of expectations) {
					expect(latestCoverageIndex(scenario.entries, customType)).toBe(hasLedgerEntry ? coverageIndex : -1);
					expect(latestCoverageMarkerId(scenario.entries, customType)).toBe(hasLedgerEntry ? scenario.coverageId : undefined);
				}
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should ignore duplicate observation records after the first valid record for an id", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, (scenario) => {
				if (scenario.observations.length === 0) return;

				// Arrange
				const original = scenario.observations[0];
				const duplicate = { ...original, content: `${original.content} changed`, tokenCount: original.tokenCount + 1 };
				const entries = [
					...scenario.entries,
					observationsEntry("ledger-observations-duplicate", [duplicate], scenario.coverageId),
				];

				// Act
				const folded = foldLedger(entries);

				// Assert
				expect(folded.observationsById.get(original.id)).toBe(original);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should apply tombstone drops even when they appear before observation records", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(entryIdArb, { minLength: 1, maxLength: 6 })
					.chain((sourceIds) => fc.uniqueArray(observationArb(sourceIds), { minLength: 1, maxLength: 10, selector: (observation) => observation.id })
						.chain((observations) => fc.tuple(
							fc.subarray(idsOf(observations), { minLength: 0, maxLength: observations.length }),
							fc.uniqueArray(memoryIdArb, { minLength: 0, maxLength: 4 }),
						).map(([existingDrops, extraDrops]) => ({ sourceIds, observations, dropIds: Array.from(new Set([...existingDrops, ...extraDrops])) })))),
				({ sourceIds, observations, dropIds }) => {
					// Arrange
					const coverageId = sourceIds[sourceIds.length - 1];
					const entries: Entry[] = [
						...sourceIds.map((id, index) => sourceEntry(id, index)),
						dropsEntry("ledger-drops-before-observations", dropIds, coverageId),
						observationsEntry("ledger-observations-after-drops", observations, coverageId),
					];
					const dropped = new Set(dropIds);

					// Act
					const folded = foldLedger(entries);

					// Assert
					expect(sorted(folded.droppedObservationIds)).toEqual(sorted(dropIds));
					expect(idsOf(folded.activeObservations)).toEqual(idsOf(observations.filter((observation) => !dropped.has(observation.id))));
				},
			),
			PROPERTY_OPTIONS,
		);
	});
});
