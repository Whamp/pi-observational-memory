import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	buildJevDropperState,
	buildJevDropQuestions,
	chunkJevDropperState,
	JEV_DROP_NOUL_THRESHOLD,
	JEV_UNPARSEABLE_AGE_MINUTES,
	jevChunkStateValue,
	selectJevDropIds,
} from "../src/agents/dropper/jev.js";
import { estimateJevTokens } from "../src/jev/token-estimate.js";
import type { Observation, Reflection } from "../src/session-ledger/index.js";
import { PROPERTY_OPTIONS, entryIdArb, observationArb, reflectionArb } from "./fixtures/property.js";

const observationsArb = fc
	.uniqueArray(entryIdArb, { minLength: 1, maxLength: 6 })
	.chain((sourceIds) => fc.uniqueArray(observationArb(sourceIds), { minLength: 0, maxLength: 16, selector: (candidate) => candidate.id }));

function reflectionsForArb(observations: readonly Observation[]): fc.Arbitrary<Reflection[]> {
	const ids = observations.map((observation) => observation.id);
	return ids.length === 0
		? fc.constant([])
		: fc.uniqueArray(reflectionArb(ids), { maxLength: 8, selector: (reflection) => reflection.id });
}

const poolArb = observationsArb.chain((observations) =>
	fc.record({ reflections: reflectionsForArb(observations), referenceTimeMs: fc.integer({ min: 0, max: 2_000_000_000_000 }) })
		.map(({ reflections, referenceTimeMs }) => ({ observations, reflections, referenceTimeMs })));

const poolWithVerdictsArb = observationsArb.chain((observations) =>
	fc.array(fc.integer({ min: 0, max: 100 }), { minLength: observations.length, maxLength: observations.length })
		.map((percents) => ({
			observations,
			verdicts: new Map(observations.map((observation, index) => [observation.id, percents[index] / 100] as const)),
		})));

/** The exact request body the transport serializes for one chunk (state plus questions, the API's billing basis). */
function chunkBodyTokens(state: ReturnType<typeof buildJevDropperState>, chunk: Parameters<typeof jevChunkStateValue>[1]): number {
	return estimateJevTokens(JSON.stringify({
		state: jevChunkStateValue(state, chunk),
		questions: buildJevDropQuestions(chunk.observationIds),
	}));
}

describe("Jev dropper property invariants", () => {
	it("keeps every chunk under its budget whenever the plan is not oversized", () => {
		fc.assert(
			fc.property(
				poolArb,
				fc.integer({ min: 64, max: 24_000 }),
				(pool, budget) => {
					// Arrange
					const state = buildJevDropperState(pool.observations, pool.reflections, pool.referenceTimeMs);
					const plan = chunkJevDropperState(state, budget);
					const chunkIds = plan.chunks.flatMap((chunk) => chunk.observationIds);

					// Assert
					if (plan.oversized) {
						// An oversized plan must have stopped on an observation that alone cannot fit.
						const unplaced = state.observations.filter((fact) => !chunkIds.includes(fact.id));
						expect(
							unplaced.some((fact) => chunkBodyTokens(state, { observationIds: [fact.id], observations: [fact] }) > budget),
						).toBe(true);
						return;
					}

					// Chunks partition the pool in oldest-first order...
					expect(chunkIds).toEqual(state.observations.map((fact) => fact.id));

					// ...and every chunk fits the budget as the transport would measure it.
					for (const chunk of plan.chunks) {
						expect(chunkBodyTokens(state, chunk)).toBeLessThanOrEqual(budget);
					}
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("drops only verdicts that clear the threshold, within the cap", () => {
		fc.assert(
			fc.property(
				poolWithVerdictsArb,
				fc.integer({ min: 0, max: 8 }),
				(pool, maxDropsAllowed) => {
					// Arrange
					const clearedIds = pool.observations
						.filter((observation) => (pool.verdicts.get(observation.id) ?? -1) >= JEV_DROP_NOUL_THRESHOLD)
						.map((observation) => observation.id);
					const dropped = selectJevDropIds(pool.verdicts, pool.observations, maxDropsAllowed, []);

					// Assert
					if (dropped === undefined) {
						expect(maxDropsAllowed <= 0 || clearedIds.length === 0).toBe(true);
						return;
					}
					expect(dropped.every((id) => clearedIds.includes(id))).toBe(true);
					expect(dropped.length).toBeLessThanOrEqual(maxDropsAllowed);
					for (const id of dropped) {
						expect(pool.verdicts.get(id)).toBeGreaterThanOrEqual(JEV_DROP_NOUL_THRESHOLD);
					}
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("selects deterministically for identical inputs", () => {
		fc.assert(
			fc.property(
				poolWithVerdictsArb,
				fc.integer({ min: 0, max: 8 }),
				(pool, maxDropsAllowed) => {
					// Arrange
					const first = selectJevDropIds(pool.verdicts, pool.observations, maxDropsAllowed, []);
					const second = selectJevDropIds(pool.verdicts, pool.observations, maxDropsAllowed, []);

					// Assert
					expect(second).toEqual(first);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("orders state observations oldest-first with unparseable ones as ancient", () => {
		fc.assert(
			fc.property(observationsArb, fc.integer({ min: 0, max: 2_000_000_000_000 }), (observations, referenceTimeMs) => {
				// Arrange
				const state = buildJevDropperState(observations, [], referenceTimeMs);
				const ages = state.observations.map((fact) => fact.ageMinutes);

				// Assert: age non-increasing across the state, oldest first; the sentinel
				// (unparseable timestamp) reports as ancient and may lead.
				for (let index = 1; index < ages.length; index++) {
					expect(ages[index] === JEV_UNPARSEABLE_AGE_MINUTES || ages[index] <= ages[index - 1]).toBe(true);
				}
				expect(ages.every((age) => age >= 0)).toBe(true);
			}),
			PROPERTY_OPTIONS,
		);
	});
});
