import { describe, expect, it } from "vitest";
import {
	buildJevDropperState,
	buildJevDropQuestions,
	chunkJevDropperState,
	JEV_CHUNK_TARGET_TOKENS,
	JEV_DROP_NOUL_THRESHOLD,
	JEV_UNPARSEABLE_AGE_MINUTES,
	jevChunkStateValue,
	runJevDropper,
	selectJevDropIds,
	type JevClient,
	type JevDropperChunk,
	type JevDropperState,
} from "../src/agents/dropper/jev.js";
import { DROPPER_SYSTEM, JEV_DROP_CONTEXT, JEV_DROP_CRITERIA } from "../src/agents/dropper/prompts.js";
import { DEFAULT_JEV_MODEL_ID, JevRequestError, type JevAskRequest } from "../src/jev/client.js";
import { observation, reflection } from "./fixtures/session.js";

interface ClientHarness {
	client: JevClient;
	calls: JevAskRequest[];
}

function fakeClient(answersFor: (request: JevAskRequest) => ReadonlyMap<string, number>): ClientHarness {
	const calls: JevAskRequest[] = [];
	const client: JevClient = {
		askNouls: async (request) => {
			calls.push(request);
			return { answers: answersFor(request), usage: { inputTokens: 100, outputTokens: 0 } };
		},
	};
	return { client, calls };
}

function scriptedClient(script: (ReadonlyMap<string, number> | Error)[]): ClientHarness {
	const calls: JevAskRequest[] = [];
	const client: JevClient = {
		askNouls: async (request) => {
			calls.push(request);
			const next = script.shift();
			if (next instanceof Error) throw next;
			return { answers: next ?? new Map(), usage: { inputTokens: 100, outputTokens: 0 } };
		},
	};
	return { client, calls };
}

function alwaysFailingClient(error: unknown): JevClient {
	return {
		askNouls: async () => {
			throw error;
		},
	};
}

describe("Jev dropper state", () => {
	it("sorts observations oldest-first with coverage and age in minutes", () => {
		const newer = observation("aaaaaaaaaaaa", { timestamp: "2026-05-02T10:00:00.000Z" });
		const older = observation("bbbbbbbbbbbb", { timestamp: "2026-05-02T09:00:00.000Z" });
		const partialRef = reflection("rrrrrrrrrrrr", ["bbbbbbbbbbbb"]);
		const strongRefA = reflection("sssssssssssa", ["aaaaaaaaaaaa"]);
		const strongRefB = reflection("sssssssssssb", ["aaaaaaaaaaaa"]);

		const state = buildJevDropperState([newer, older], [partialRef, strongRefA, strongRefB], Date.parse("2026-05-02T12:00:00.000Z"));

		expect(state.observations.map((fact) => fact.id)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
		expect(state.observations[0]).toMatchObject({ id: "bbbbbbbbbbbb", coverage: "partial", ageMinutes: 180 });
		expect(state.observations[1]).toMatchObject({ id: "aaaaaaaaaaaa", coverage: "strong", ageMinutes: 120 });
		expect(state.context).toBe(JEV_DROP_CONTEXT);
		expect(state.reflections).toEqual([
			`[rrrrrrrrrrrr] ${partialRef.content}`,
			`[sssssssssssa] ${strongRefA.content}`,
			`[sssssssssssb] ${strongRefB.content}`,
		]);
	});

	it("clamps future timestamps to zero minutes and treats unparseable ones as ancient", () => {
		const future = observation("aaaaaaaaaaaa", { timestamp: "2026-05-02T13:00:00.000Z" });
		const broken = observation("bbbbbbbbbbbb", { timestamp: "not-a-date" });

		const state = buildJevDropperState([future, broken], [], Date.parse("2026-05-02T12:00:00.000Z"));

		expect(state.observations[0]).toMatchObject({ id: "bbbbbbbbbbbb", ageMinutes: JEV_UNPARSEABLE_AGE_MINUTES });
		expect(state.observations[1]).toMatchObject({ id: "aaaaaaaaaaaa", ageMinutes: 0 });
	});
});

describe("Jev dropper questions", () => {
	it("builds one shared-criteria noul question per observation id", () => {
		const questions = buildJevDropQuestions(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);

		expect(Object.keys(questions)).toEqual(["drop_aaaaaaaaaaaa", "drop_bbbbbbbbbbbb"]);
		expect(questions["drop_aaaaaaaaaaaa"].criteria).toBe(JEV_DROP_CRITERIA);
		expect(questions["drop_bbbbbbbbbbbb"].criteria).toBe(JEV_DROP_CRITERIA);
		expect(questions["drop_bbbbbbbbbbbb"].instructions).toBe(
			"Observation `bbbbbbbbbbbb` can be dropped from active durable memory without losing value for the ongoing work.",
		);
	});
});

describe("Jev dropper chunking", () => {
	it("packs a small pool into one chunk under the default budget", () => {
		const state = buildJevDropperState([
			observation("aaaaaaaaaaaa", { content: "keep the build green" }),
			observation("bbbbbbbbbbbb", { content: "watch the flaky test" }),
		], []);

		const plan = chunkJevDropperState(state);

		expect(plan.oversized).toBe(false);
		expect(plan.chunks).toHaveLength(1);
		expect(plan.chunks[0].observationIds).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
	});

	it("splits into one observation per chunk when the budget forces it", () => {
		const state = buildJevDropperState([
			observation("aaaaaaaaaaaa", { content: "x".repeat(6_000) }),
			observation("bbbbbbbbbbbb", { content: "y".repeat(6_000) }),
		], []);

		const plan = chunkJevDropperState(state, 2_000);

		expect(plan.oversized).toBe(false);
		expect(plan.chunks.map((chunk) => chunk.observationIds)).toEqual([["aaaaaaaaaaaa"], ["bbbbbbbbbbbb"]]);
	});

	it("flags an oversized pool when one observation cannot fit with the globals", () => {
		const state = buildJevDropperState([observation("aaaaaaaaaaaa", { content: "x".repeat(200_000) })], []);

		expect(chunkJevDropperState(state).oversized).toBe(true);
	});

	it("plans zero chunks for an empty pool", () => {
		const state = buildJevDropperState([], []);

		expect(chunkJevDropperState(state)).toEqual({ chunks: [], oversized: false });
	});

	it("sends each chunk only its own observations on the wire", () => {
		const state = buildJevDropperState([
			observation("aaaaaaaaaaaa", { content: "x".repeat(6_000) }),
			observation("bbbbbbbbbbbb", { content: "y".repeat(6_000) }),
		], []);
		const plan = chunkJevDropperState(state, 2_000);

		expect(plan.chunks).toHaveLength(2);
		expect(jevChunkStateValue(state, plan.chunks[0])).toMatchObject({ observations: [{ id: "aaaaaaaaaaaa" }] });
		expect(jevChunkStateValue(state, plan.chunks[1])).toMatchObject({ observations: [{ id: "bbbbbbbbbbbb" }] });
	});
});

describe("Jev dropper selection", () => {
	const obsA = observation("aaaaaaaaaaaa", { timestamp: "2026-05-02T10:00:00.000Z" });
	const obsB = observation("bbbbbbbbbbbb", { timestamp: "2026-05-02T10:00:00.000Z" });
	const obsC = observation("cccccccccccc", { timestamp: "2026-05-02T10:00:00.000Z" });

	it("drops only verdicts at or above the threshold, ordered by noul", () => {
		const verdicts = new Map([
			["aaaaaaaaaaaa", 0.799],
			["bbbbbbbbbbbb", 0.8],
			["cccccccccccc", 0.95],
		]);

		expect(selectJevDropIds(verdicts, [obsA, obsB, obsC], 3, [])).toEqual(["cccccccccccc", "bbbbbbbbbbbb"]);
	});

	it("keeps observations with no verdict and honors the drop cap", () => {
		const verdicts = new Map([
			["aaaaaaaaaaaa", 0.9],
			["bbbbbbbbbbbb", 0.85],
			["cccccccccccc", 0.99],
		]);

		expect(selectJevDropIds(verdicts, [obsA, obsB, obsC], 2, [])).toEqual(["cccccccccccc", "aaaaaaaaaaaa"]);
		expect(selectJevDropIds(verdicts, [obsA, obsB, obsC], 0, [])).toBeUndefined();
		expect(selectJevDropIds(new Map(), [obsA], 1, [])).toBeUndefined();
	});

	it("prefers the higher noul within otherwise-tied candidates", () => {
		const verdicts = new Map([
			["aaaaaaaaaaaa", 0.81],
			["bbbbbbbbbbbb", 0.99],
		]);

		expect(selectJevDropIds(verdicts, [obsA, obsB], 1, [])).toEqual(["bbbbbbbbbbbb"]);
	});
});

describe("runJevDropper", () => {
	it("succeeds without calling the client for an empty pool", async () => {
		const { client, calls } = fakeClient(() => new Map());

		const outcome = await runJevDropper({ client, observations: [], reflections: [], targetTokens: 100 });

		expect(outcome).toEqual({ outcome: "dropped" });
		expect(calls).toHaveLength(0);
	});

	it("succeeds without calling the client when no drops are allowed", async () => {
		const { client, calls } = fakeClient(() => new Map());

		const outcome = await runJevDropper({ client, observations: [observation("aaaaaaaaaaaa")], reflections: [], targetTokens: 100 });

		expect(outcome).toEqual({ outcome: "dropped" });
		expect(calls).toHaveLength(0);
	});

	it("returns a zero-drop success when nothing clears the threshold", async () => {
		const { client, calls } = fakeClient(() => new Map([["drop_aaaaaaaaaaaa", 0.3]]));

		const outcome = await runJevDropper({
			client,
			observations: [observation("aaaaaaaaaaaa")],
			reflections: [],
			targetTokens: 5,
		});

		expect(outcome).toEqual({ outcome: "dropped" });
		expect(calls).toHaveLength(1);
	});

	it("returns selected drop ids when nouls clear the threshold", async () => {
		const { client } = fakeClient(() => new Map([["drop_aaaaaaaaaaaa", 0.95]]));

		const outcome = await runJevDropper({
			client,
			observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
			reflections: [],
			targetTokens: 5,
		});

		expect(outcome).toEqual({ outcome: "dropped", droppedIds: ["aaaaaaaaaaaa"] });
	});

	it("sends one request per chunk for a pool that outgrows the budget", async () => {
		const huge = (id: string) => observation(id, { content: "x".repeat(80_000), tokenCount: 10 });
		const { client, calls } = fakeClient(() => new Map());

		const outcome = await runJevDropper({
			client,
			observations: [huge("aaaaaaaaaaaa"), huge("bbbbbbbbbbbb")],
			reflections: [],
			targetTokens: 5,
		});

		expect(outcome).toEqual({ outcome: "dropped" });
		expect(calls).toHaveLength(2);
		expect(Object.keys(calls[0].questions)).toEqual(["drop_aaaaaaaaaaaa"]);
		expect(Object.keys(calls[1].questions)).toEqual(["drop_bbbbbbbbbbbb"]);
		expect(calls[0].state).toMatchObject({ observations: [{ id: "aaaaaaaaaaaa" }] });
		expect(calls[1].state).toMatchObject({ observations: [{ id: "bbbbbbbbbbbb" }] });
	});

	it("fails the whole run when a later chunk throws, never using partial verdicts", async () => {
		const huge = (id: string) => observation(id, { content: "x".repeat(80_000), tokenCount: 10 });
		const { client, calls } = scriptedClient([
			new Map([["drop_aaaaaaaaaaaa", 0.99]]),
			new JevRequestError("rate_limited", "jev.ask_rate_limited: exhausted", true),
		]);

		const outcome = await runJevDropper({
			client,
			observations: [huge("aaaaaaaaaaaa"), huge("bbbbbbbbbbbb")],
			reflections: [],
			targetTokens: 5,
		});

		expect(outcome).toEqual({ outcome: "failed", reason: "rate_limited" });
		expect(calls).toHaveLength(2);
	});

	it("surfaces a non-JevRequestError throw as unexpected", async () => {
		const outcome = await runJevDropper({
			client: alwaysFailingClient(new TypeError("boom")),
			observations: [observation("aaaaaaaaaaaa")],
			reflections: [],
			targetTokens: 5,
		});

		expect(outcome).toEqual({ outcome: "failed", reason: "unexpected" });
	});

	it("fails with state_too_large without calling the client", async () => {
		const { client, calls } = fakeClient(() => new Map());

		const outcome = await runJevDropper({
			client,
			observations: [observation("aaaaaaaaaaaa", { content: "x".repeat(200_000) })],
			reflections: [],
			targetTokens: 5,
		});

		expect(outcome).toEqual({ outcome: "failed", reason: "state_too_large" });
		expect(calls).toHaveLength(0);
	});
});

describe("Jev dropper budget sanity", () => {
	it("keeps the default budget with margin under the API state ceiling", () => {
		expect(JEV_CHUNK_TARGET_TOKENS).toBeLessThan(32_000);
		expect(JEV_CHUNK_TARGET_TOKENS).toBeGreaterThan(0);
	});
});

describe("jevChunkStateValue", () => {
	it("carries the globals plus only the chunk's facts", () => {
		const state: JevDropperState = buildJevDropperState([
			observation("aaaaaaaaaaaa"),
			observation("bbbbbbbbbbbb"),
		], [reflection("rrrrrrrrrrrr", ["aaaaaaaaaaaa"])]);
		const chunk: JevDropperChunk = { observationIds: ["bbbbbbbbbbbb"], observations: [state.observations[1]] };

		const wire = jevChunkStateValue(state, chunk);

		expect(wire).toMatchObject({ context: JEV_DROP_CONTEXT, observations: [{ id: "bbbbbbbbbbbb" }] });
		expect(wire).toHaveProperty("reflections");
	});
});

describe("Jev alignment", () => {
	it("pins the drop threshold to the model it was tuned against", () => {
		// Tuned as a pair against docs/adr/0004-jev-dropper-decision-engine.md; changing either literal without re-tuning fails here.
		expect(JEV_DROP_NOUL_THRESHOLD).toBe(0.8);
		expect(DEFAULT_JEV_MODEL_ID).toBe("jev-1.13.0");
	});

	it("keeps JEV_DROP_CRITERIA aligned with DROPPER_SYSTEM's preservation floor", () => {
		const preservationFloorPhrases = [
			"user preference",
			"constraint",
			"correction",
			"decision",
			"concrete completion",
			"identifier",
			"file path",
			"exact error",
			"date",
			"deadline",
			"blocker",
			"TODO",
			"non-standard",
		] as const;
		const system = DROPPER_SYSTEM.toLowerCase();
		const criteria = JSON.stringify(JEV_DROP_CRITERIA).toLowerCase();

		for (const phrase of preservationFloorPhrases) {
			const lowered = phrase.toLowerCase();
			expect(system).toContain(lowered);
			expect(criteria).toContain(lowered);
		}
	});
});
