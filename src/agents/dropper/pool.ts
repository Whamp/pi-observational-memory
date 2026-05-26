import type { Observation } from "../../session-ledger/index.js";

const DROP_SKIP_FULLNESS = 0.10;
const DROP_LOW_URGENCY_FULLNESS = 0.30;
const DROP_MEDIUM_URGENCY_FULLNESS = 0.60;
const DROP_MAX_FULLNESS = 1.00;
const DROP_MIN_RATIO = 0.10;
const DROP_MAX_RATIO = 0.50;

export type DropUrgency = "low" | "medium" | "high";

export type ObservationPoolMetrics = {
	observationTokens: number;
	budgetTokens: number;
	fullness: number;
	droppableCount: number;
	maxDropsAllowed: number;
	overBudget: boolean;
	ready: boolean;
};

export function observationTokenSum(observations: readonly { tokenCount: number }[]): number {
	return observations.reduce((sum, observation) => sum + observation.tokenCount, 0);
}

export function observationPoolFullness(observationTokens: number, budgetTokens: number): number {
	if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
	if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
	return observationTokens / budgetTokens;
}

export function dropUrgencyForFullness(fullness: number): DropUrgency {
	if (fullness < DROP_LOW_URGENCY_FULLNESS) return "low";
	if (fullness < DROP_MEDIUM_URGENCY_FULLNESS) return "medium";
	return "high";
}

export function droppableObservationCount(observations: readonly Observation[]): number {
	return observations.filter((observation) => observation.relevance !== "critical").length;
}

export function maxDropCountForPool(observations: readonly Observation[], observationTokens: number, budgetTokens: number): number {
	const droppableCount = droppableObservationCount(observations);
	if (droppableCount === 0) return 0;

	const fullness = observationPoolFullness(observationTokens, budgetTokens);
	if (fullness < DROP_SKIP_FULLNESS) return 0;

	const cappedFullness = Math.min(DROP_MAX_FULLNESS, Math.max(DROP_SKIP_FULLNESS, fullness));
	const dropRatio = DROP_MIN_RATIO
		+ ((cappedFullness - DROP_SKIP_FULLNESS) / (DROP_MAX_FULLNESS - DROP_SKIP_FULLNESS))
		* (DROP_MAX_RATIO - DROP_MIN_RATIO);
	return Math.max(1, Math.floor(droppableCount * dropRatio));
}

export function observationPoolMetrics(
	observations: readonly Observation[],
	budgetTokens: number,
): ObservationPoolMetrics {
	const observationTokens = observationTokenSum(observations);
	const fullness = observationPoolFullness(observationTokens, budgetTokens);
	const droppableCount = droppableObservationCount(observations);
	const maxDropsAllowed = maxDropCountForPool(observations, observationTokens, budgetTokens);
	const overBudget = Number.isFinite(budgetTokens) && budgetTokens > 0 && observationTokens >= budgetTokens;
	return {
		observationTokens,
		budgetTokens,
		fullness,
		droppableCount,
		maxDropsAllowed,
		overBudget,
		ready: overBudget && maxDropsAllowed > 0,
	};
}
