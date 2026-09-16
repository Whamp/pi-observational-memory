import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { recallMemorySources } from "../src/session-ledger/index.js";
import {
	PROPERTY_OPTIONS,
	idsOf,
	ledgerScenarioArb,
	memoryIdArb,
	observationArb,
	observationsEntry,
	reflectionArb,
	reflectionsEntry,
	sorted,
	sourceEntry,
} from "./fixtures/property.js";

describe("recall property invariants", () => {
	it("should return not_found for ids absent from generated ledgers", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, (scenario) => {
				// Act
				const result = recallMemorySources(scenario.entries, "not-present-in-ledger");

				// Assert
				expect(result.status).toBe("not_found");
				expect(result.collision).toBe(false);
				expect(result.partial).toBe(false);
				expect(result.observations).toEqual([]);
				expect(result.reflections).toEqual([]);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should report mixed collisions and partial provenance instead of hiding missing evidence", () => {
		fc.assert(
			fc.property(memoryIdArb, observationArb(["source-ok"]), reflectionArb(["000000000000"]), (sharedId, rawObservation, rawReflection) => {
				// Arrange
				const validSource = sourceEntry("source-ok", 0);
				const nonSourceEntry = { type: "custom", id: "non-source-memory-entry", customType: "om.unknown", data: {} };
				const observation = {
					...rawObservation,
					id: sharedId,
					sourceEntryIds: [validSource.id, "missing-source-entry", nonSourceEntry.id, validSource.id],
				};
				const reflection = {
					...rawReflection,
					id: sharedId,
					supportingObservationIds: [observation.id, "missing-supporting-observation", observation.id],
				};
				const entries = [
					validSource,
					nonSourceEntry,
					observationsEntry("ledger-observations", [observation], validSource.id),
					reflectionsEntry("ledger-reflections", [reflection], validSource.id),
				];

				// Act
				const result = recallMemorySources(entries, sharedId);

				// Assert
				expect(result.status).toBe("found");
				expect(result.kind).toBe("mixed");
				expect(result.collision).toBe(true);
				expect(result.partial).toBe(true);
				expect(result.missingSourceEntryIds).toEqual(["missing-source-entry"]);
				expect(result.nonSourceEntryIds).toEqual([nonSourceEntry.id]);
				expect(result.missingSupportingObservationIds).toEqual(["missing-supporting-observation"]);
				expect(result.sourceEntries.map((entry) => entry.id)).toEqual([validSource.id]);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should recall generated observations with deduped source entries and drop status", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, fc.nat(), (scenario, rawIndex) => {
				if (scenario.observations.length === 0) return;
				// Arrange
				const observation = scenario.observations[rawIndex % scenario.observations.length];
				const dropped = new Set(scenario.droppedIds);

				// Act
				const result = recallMemorySources(scenario.entries, observation.id);

				// Assert
				expect(result.status).toBe("found");
				expect(result.kind === "observation" || result.kind === "mixed").toBe(true);
				const recalled = result.observations.find((item) => item.observation.id === observation.id);
				expect(recalled).toBeDefined();
				expect(recalled?.status).toBe(dropped.has(observation.id) ? "dropped" : "active");
				expect(recalled?.sourceEntryIds).toEqual(Array.from(new Set(observation.sourceEntryIds)));
				expect(sorted(recalled?.sourceEntries.map((entry) => entry.id) ?? [])).toEqual(sorted(observation.sourceEntryIds));
				expect(recalled?.missingSourceEntryIds).toEqual([]);
				expect(recalled?.nonSourceEntryIds).toEqual([]);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should recall generated reflections with their supporting observations plus any direct id collision", () => {
		fc.assert(
			fc.property(ledgerScenarioArb, fc.nat(), (scenario, rawIndex) => {
				if (scenario.reflections.length === 0) return;
				// Arrange
				const reflection = scenario.reflections[rawIndex % scenario.reflections.length];
				const expectedObservationIds = new Set(reflection.supportingObservationIds);
				for (const observation of scenario.observations) {
					if (observation.id === reflection.id) expectedObservationIds.add(observation.id);
				}

				// Act
				const result = recallMemorySources(scenario.entries, reflection.id);

				// Assert
				expect(result.status).toBe("found");
				expect(result.kind === "reflection" || result.kind === "mixed").toBe(true);
				expect(idsOf(result.reflections.map((item) => item.reflection))).toContain(reflection.id);
				expect(sorted(idsOf(result.observations.map((item) => item.observation)))).toEqual(sorted(expectedObservationIds));
				expect(result.missingSupportingObservationIds).toEqual([]);
				expect(result.missingSourceEntryIds).toEqual([]);
				expect(result.nonSourceEntryIds).toEqual([]);
			}),
			PROPERTY_OPTIONS,
		);
	});
});
