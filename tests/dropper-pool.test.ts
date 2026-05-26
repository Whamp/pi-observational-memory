import { describe, expect, it } from "vitest";

import { observationPoolMetrics } from "../src/agents/dropper/pool.js";
import { foldLedger } from "../src/session-ledger/index.js";
import { observation, observationsDroppedEntry, observationsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

describe("V3 dropper active observation pool metrics", () => {
	it("reports below-budget pools as not ready", () => {
		const observations = [observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 20 })];

		expect(observationPoolMetrics(observations, 100)).toMatchObject({
			observationTokens: 20,
			budgetTokens: 100,
			fullness: 0.2,
			droppableCount: 1,
			overBudget: false,
			ready: false,
		});
	});

	it("reports at-budget pools with droppable observations as ready", () => {
		const observations = [
			observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 50 }),
			observation("bbbbbbbbbbbb", { relevance: "medium", tokenCount: 50 }),
		];

		const metrics = observationPoolMetrics(observations, 100);

		expect(metrics.observationTokens).toBe(100);
		expect(metrics.fullness).toBe(1);
		expect(metrics.droppableCount).toBe(2);
		expect(metrics.maxDropsAllowed).toBe(1);
		expect(metrics.overBudget).toBe(true);
		expect(metrics.ready).toBe(true);
	});

	it("does not report critical-only pools as ready", () => {
		const observations = [observation("aaaaaaaaaaaa", { relevance: "critical", tokenCount: 100 })];

		expect(observationPoolMetrics(observations, 100)).toMatchObject({
			observationTokens: 100,
			droppableCount: 0,
			maxDropsAllowed: 0,
			overBudget: true,
			ready: false,
		});
	});

	it("uses folded active observations so tombstones reduce readiness", () => {
		const dropped = observation("aaaaaaaaaaaa", { relevance: "low", tokenCount: 100 });
		const active = observation("bbbbbbbbbbbb", { relevance: "low", tokenCount: 20 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [dropped, active], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries as any);
		const metrics = observationPoolMetrics(folded.activeObservations, 100);

		expect(folded.activeObservations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(metrics.observationTokens).toBe(20);
		expect(metrics.overBudget).toBe(false);
		expect(metrics.ready).toBe(false);
	});
});
