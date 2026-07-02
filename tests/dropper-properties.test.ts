import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	coverageTierForObservation,
	maxDropCountForPool,
	normalizeDropObservationIds,
	observationPoolMetrics,
	reflectionCoverageMap,
	reflectionCoverageTierForCount,
	reflectionSupportCounts,
	selectDropCandidates,
	summarizeCoverageByRelevance,
	summarizeCoverageTransitionsByRelevance,
	type ReflectionCoverageTier,
} from "../src/agents/dropper/agent.js";
import { summarizeSupportIdCounts } from "../src/agents/reflector/agent.js";
import type { Observation, Reflection } from "../src/session-ledger/index.js";
import {
	PROPERTY_OPTIONS,
	entryIdArb,
	idsOf,
	memoryIdArb,
	observationArb,
	reflectionArb,
	sorted,
} from "./fixtures/property.js";

const observationsArb = fc
	.uniqueArray(entryIdArb, { minLength: 1, maxLength: 6 })
	.chain((sourceIds) => fc.uniqueArray(observationArb(sourceIds), { minLength: 0, maxLength: 16, selector: (observation) => observation.id }));

const COVERAGE_DROP_RANK: Record<ReflectionCoverageTier, number> = { strong: 0, partial: 1, none: 2 };
const RELEVANCE_DROP_RANK: Record<Observation["relevance"], number> = { low: 0, medium: 1, high: 2, critical: 3 };

function timestampRank(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function reflectionsForObservationsArb(observations: readonly Observation[]): fc.Arbitrary<Reflection[]> {
	const observationIds = idsOf(observations);
	return observationIds.length === 0
		? fc.constant([])
		: fc.uniqueArray(reflectionArb(observationIds), { minLength: 0, maxLength: 10, selector: (reflection) => reflection.id });
}

describe("dropper property invariants", () => {
	it("should keep observation pool metrics internally consistent", () => {
		fc.assert(
			fc.property(observationsArb, fc.integer({ min: -100, max: 5_000 }), (observations, targetTokens) => {
				// Arrange
				const expectedTokens = observations.reduce((sum, observation) => sum + observation.tokenCount, 0);

				// Act
				const metrics = observationPoolMetrics(observations, targetTokens);

				// Assert
				expect(metrics.observationTokens).toBe(expectedTokens);
				expect(metrics.activeObservationCount).toBe(observations.length);
				expect(metrics.droppableCount).toBe(observations.length);
				expect(metrics.tokensOverTarget).toBe(Math.max(0, expectedTokens - targetTokens));
				expect(metrics.maxDropsAllowed).toBeGreaterThanOrEqual(0);
				expect(metrics.maxDropsAllowed).toBeLessThanOrEqual(observations.length);
				expect(metrics.overTarget).toBe(Number.isFinite(targetTokens) && targetTokens >= 0 && expectedTokens > targetTokens);
				expect(metrics.ready).toBe(metrics.overTarget && metrics.maxDropsAllowed > 0);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should never increase allowed drops as the target token budget increases", () => {
		fc.assert(
			fc.property(observationsArb, fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 200_000 }), (observations, a, b) => {
				// Arrange
				const lowerTarget = Math.min(a, b);
				const higherTarget = Math.max(a, b);
				const observationTokens = observations.reduce((sum, observation) => sum + observation.tokenCount, 0);

				// Act
				const lowerTargetDrops = maxDropCountForPool(observations, observationTokens, lowerTarget);
				const higherTargetDrops = maxDropCountForPool(observations, observationTokens, higherTarget);

				// Assert
				expect(lowerTargetDrops).toBeGreaterThanOrEqual(higherTargetDrops);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should flip pool readiness exactly at finite target boundaries", () => {
		fc.assert(
			fc.property(observationsArb, (observations) => {
				// Arrange
				const observationTokens = observations.reduce((sum, observation) => sum + observation.tokenCount, 0);
				const targets = [
					-1,
					0,
					Math.max(0, observationTokens - 1),
					observationTokens,
					observationTokens + 1,
					Number.POSITIVE_INFINITY,
				];

				for (const target of targets) {
					// Act
					const metrics = observationPoolMetrics(observations, target);

					// Assert
					const expectedOverTarget = Number.isFinite(target) && target >= 0 && observationTokens > target;
					expect(metrics.overTarget).toBe(expectedOverTarget);
					expect(metrics.ready).toBe(expectedOverTarget && metrics.maxDropsAllowed > 0);
					expect(metrics.maxDropsAllowed).toBeGreaterThanOrEqual(0);
					expect(metrics.maxDropsAllowed).toBeLessThanOrEqual(observations.length);
				}
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should count each supporting observation at most once per reflection", () => {
		fc.assert(
			fc.property(observationsArb.chain((observations) => reflectionsForObservationsArb(observations).map((reflections) => ({ observations, reflections }))), ({ observations, reflections }) => {
				// Act
				const supportCounts = reflectionSupportCounts(reflections);

				// Assert
				for (const observation of observations) {
					const expected = reflections.filter((reflection) => new Set(reflection.supportingObservationIds).has(observation.id)).length;
					expect(supportCounts.get(observation.id) ?? 0).toBe(expected);
				}
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should derive coverage tiers from support counts for every active observation", () => {
		fc.assert(
			fc.property(observationsArb.chain((observations) => reflectionsForObservationsArb(observations).map((reflections) => ({ observations, reflections }))), ({ observations, reflections }) => {
				// Arrange
				const supportCounts = reflectionSupportCounts(reflections);

				// Act
				const coverage = reflectionCoverageMap(observations, reflections);

				// Assert
				expect(sorted(coverage.keys())).toEqual(sorted(idsOf(observations)));
				for (const observation of observations) {
					expect(coverage.get(observation.id)).toBe(reflectionCoverageTierForCount(supportCounts.get(observation.id) ?? 0));
					expect(coverageTierForObservation(observation, coverage)).toBe(coverage.get(observation.id));
				}
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should summarize coverage by relevance without losing counts or tokens", () => {
		fc.assert(
			fc.property(observationsArb.chain((observations) => reflectionsForObservationsArb(observations).map((reflections) => ({ observations, reflections }))), ({ observations, reflections }) => {
				// Arrange
				const coverage = reflectionCoverageMap(observations, reflections);

				// Act
				const summary = summarizeCoverageByRelevance(observations, coverage);

				// Assert
				let summarizedCount = 0;
				let summarizedTokens = 0;
				for (const relevance of ["low", "medium", "high", "critical"] as const) {
					for (const tier of ["none", "partial", "strong"] as const) {
						summarizedCount += summary[relevance][tier].count;
						summarizedTokens += summary[relevance][tier].tokens;
					}
				}
				expect(summarizedCount).toBe(observations.length);
				expect(summarizedTokens).toBe(observations.reduce((sum, observation) => sum + observation.tokenCount, 0));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should summarize only coverage transitions that actually changed", () => {
		fc.assert(
			fc.property(observationsArb.chain((observations) => fc.tuple(reflectionsForObservationsArb(observations), reflectionsForObservationsArb(observations)).map(([before, after]) => ({ observations, before, after }))), ({ observations, before, after }) => {
				// Arrange
				const beforeCoverage = reflectionCoverageMap(observations, before);
				const afterCoverage = reflectionCoverageMap(observations, after);

				// Act
				const transitions = summarizeCoverageTransitionsByRelevance(observations, beforeCoverage, afterCoverage);

				// Assert
				let changedCount = 0;
				let changedTokens = 0;
				for (const observation of observations) {
					if ((beforeCoverage.get(observation.id) ?? "none") !== (afterCoverage.get(observation.id) ?? "none")) {
						changedCount++;
						changedTokens += observation.tokenCount;
					}
				}
				let summarizedCount = 0;
				let summarizedTokens = 0;
				for (const relevance of ["low", "medium", "high", "critical"] as const) {
					for (const bucket of Object.values(transitions[relevance])) {
						summarizedCount += bucket.count;
						summarizedTokens += bucket.tokens;
					}
				}
				expect(summarizedCount).toBe(changedCount);
				expect(summarizedTokens).toBe(changedTokens);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should normalize requested drop ids to a unique in-request subset of active observations", () => {
		fc.assert(
			fc.property(observationsArb, fc.array(fc.oneof(memoryIdArb, fc.constant("not-an-observation")), { minLength: 0, maxLength: 20 }), (observations, extraIds) => {
				// Arrange
				const activeIds = idsOf(observations);
				const requestedIds = [...extraIds, ...activeIds, ...extraIds].sort();
				const active = new Set(activeIds);
				const expected: string[] = [];
				for (const id of requestedIds) {
					if (active.has(id) && !expected.includes(id)) expected.push(id);
				}

				// Act
				const normalized = normalizeDropObservationIds(requestedIds, observations);

				// Assert
				expect(normalized ?? []).toEqual(expected);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should select a unique valid subset of proposed drop candidates within the cap", () => {
		fc.assert(
			fc.property(observationsArb.chain((observations) => reflectionsForObservationsArb(observations).map((reflections) => ({ observations, reflections }))), fc.array(fc.oneof(memoryIdArb, fc.constant("unknown")), { maxLength: 20 }), fc.integer({ min: 0, max: 20 }), ({ observations, reflections }, extraIds, maxDrops) => {
				// Arrange
				const proposedIds = [...extraIds, ...idsOf(observations), ...extraIds];
				const activeIds = new Set(idsOf(observations));

				// Act
				const selected = selectDropCandidates(proposedIds, observations, maxDrops, reflections);

				// Assert
				expect(selected).toHaveLength(new Set(selected).size);
				expect(selected.length).toBeLessThanOrEqual(maxDrops);
				expect(selected.every((id) => activeIds.has(id))).toBe(true);
				if (maxDrops >= activeIds.size) expect(sorted(selected)).toEqual(sorted(activeIds));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should order selected drop candidates by coverage, relevance, age, then first proposal", () => {
		fc.assert(
			fc.property(observationsArb.chain((observations) => reflectionsForObservationsArb(observations).map((reflections) => ({ observations, reflections }))), fc.array(fc.oneof(memoryIdArb, fc.constant("unknown")), { maxLength: 20 }), fc.integer({ min: 0, max: 20 }), ({ observations, reflections }, extraIds, maxDrops) => {
				// Arrange
				const proposedIds = [...extraIds, ...idsOf(observations).reverse(), ...extraIds, ...idsOf(observations)];
				const observationsById = new Map(observations.map((observation) => [observation.id, observation]));
				const coverage = reflectionCoverageMap(observations, reflections);
				const firstProposalIndex = new Map<string, number>();
				for (let i = 0; i < proposedIds.length; i++) {
					if (!firstProposalIndex.has(proposedIds[i])) firstProposalIndex.set(proposedIds[i], i);
				}
				const expected = Array.from(firstProposalIndex.entries())
					.flatMap(([id, index]) => {
						const observation = observationsById.get(id);
						return observation ? [{ id, index, observation }] : [];
					})
					.sort((a, b) => {
						const coverageDelta = COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverage)] - COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverage)];
						const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
						const ageDelta = timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp);
						return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
					})
					.slice(0, Math.max(0, maxDrops))
					.map((candidate) => candidate.id);

				// Act
				const selected = selectDropCandidates(proposedIds, observations, maxDrops, reflections);

				// Assert
				expect(selected).toEqual(expected);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should summarize support-id counts consistently", () => {
		fc.assert(
			fc.property(observationsArb.chain((observations) => reflectionsForObservationsArb(observations)), (reflections) => {
				// Act
				const summary = summarizeSupportIdCounts(reflections);

				// Assert
				const supportCounts = reflections.map((reflection) => reflection.supportingObservationIds.length);
				const total = supportCounts.reduce((sum, count) => sum + count, 0);
				expect(summary.reflectionCount).toBe(reflections.length);
				expect(summary.totalSupportIds).toBe(total);
				expect(summary.averageSupportIds).toBe(reflections.length === 0 ? 0 : total / reflections.length);
				if (reflections.length === 0) {
					expect(summary.minSupportIds).toBe(0);
					expect(summary.maxSupportIds).toBe(0);
				} else {
					expect(summary.minSupportIds).toBe(Math.min(...supportCounts));
					expect(summary.maxSupportIds).toBe(Math.max(...supportCounts));
				}
			}),
			PROPERTY_OPTIONS,
		);
	});
});
