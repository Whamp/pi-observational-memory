import { describe, expect, it } from "vitest";
import {
	createJevClient,
	DEFAULT_JEV_MODEL_ID,
	JevRequestError,
	type JevAskRequest,
	type JevClient,
	type JevClientOptions,
} from "../src/jev/client.js";

const REQUEST: JevAskRequest = {
	state: { context: "compacting durable memory", reflections: ["[ref-1] user prefers vitest"] },
	questions: {
		drop_aaaaaaaaaaaa: { type: "noul", instructions: "Observation `aaaaaaaaaaaa` can be dropped from active memory." },
		drop_bbbbbbbbbbbb: { type: "noul", instructions: "Observation `bbbbbbbbbbbb` can be dropped from active memory." },
	},
};

function okResponse(answers: Record<string, number>): Response {
	return new Response(
		JSON.stringify({
			model: DEFAULT_JEV_MODEL_ID,
			answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: "noul", noul }])),
			usage: { input_tokens: 120, output_tokens: 0 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function rawResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers });
}

function fakeFetch(
	responses: (Response | Error)[],
	abortOnSignal = false,
): { fetch: typeof fetch; calls: RequestInit[] } {
	const calls: RequestInit[] = [];
	const fetchImpl: typeof fetch = (_input, init) => {
		calls.push(init ?? {});
		if (abortOnSignal && init?.signal?.aborted) {
			return Promise.reject(new DOMException("This operation was aborted", "AbortError"));
		}
		const next = responses.shift();
		if (next instanceof Error) return Promise.reject(next);
		if (next === undefined) throw new Error("jev-client.test: fakeFetch script exhausted");
		return Promise.resolve(next);
	};
	return { fetch: fetchImpl, calls };
}

function recordingSleep(sleeps: number[]): (ms: number) => Promise<void> {
	return async (ms) => {
		sleeps.push(ms);
	};
}

function makeClient(fetchImpl: typeof fetch, sleep?: (ms: number) => Promise<void>): JevClient {
	const options: JevClientOptions = { apiKey: "sk-test-key", fetchImpl, sleep: sleep ?? (async () => {}) };
	return createJevClient(options);
}

describe("Jev System One client", () => {
	it("posts the pinned model, state, and questions with bearer auth", async () => {
		const { fetch: fetchImpl, calls } = fakeFetch([okResponse({ drop_aaaaaaaaaaaa: 0.9, drop_bbbbbbbbbbbb: 0.25 })]);

		const result = await makeClient(fetchImpl).askNouls(REQUEST);

		expect(result.answers.get("drop_aaaaaaaaaaaa")).toBe(0.9);
		expect(result.answers.get("drop_bbbbbbbbbbbb")).toBe(0.25);
		expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 0 });
		expect(calls).toHaveLength(1);
		expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer sk-test-key");
		expect(new Headers(calls[0]?.headers).get("content-type")).toBe("application/json");
		expect(String(calls[0]?.body ?? "")).toContain("jev-1.13.0");
		expect(JSON.parse(String(calls[0]?.body ?? "{}"))).toMatchObject({
			state: REQUEST.state,
			questions: REQUEST.questions,
		});
	});

	const repeated = (status: number, body: string): Response[] => [1, 2, 3].map(() => rawResponse(status, body));

	it.each([
		[401, "bad key", "unauthorized", false],
		[422, '{"detail":"questions invalid"}', "invalid_request", false],
		[400, '{"detail":"nope"}', "invalid_request", false],
		[500, "boom", "network", true],
		[503, "unavailable", "network", true],
		[529, "overloaded", "overloaded", true],
	])("maps status %i to kind %s, retryable %s", async (status, body, kind, retryable) => {
		const { fetch: fetchImpl, calls } = fakeFetch(retryable ? repeated(status, body) : [rawResponse(status, body)]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({ kind, retryable });
		expect(calls).toHaveLength(retryable ? 3 : 1);
	});

	it("maps a 400 max_tokens_exceeded body to payload_too_large", async () => {
		const { fetch: fetchImpl, calls } = fakeFetch([
			rawResponse(400, '{"detail":{"error_type":"max_tokens_exceeded"}}'),
		]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({
			kind: "payload_too_large",
			retryable: false,
		});
		expect(calls).toHaveLength(1);
	});

	it("treats a 200 with an unparseable body as malformed_response", async () => {
		const { fetch: fetchImpl } = fakeFetch([rawResponse(200, "not json")]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({
			kind: "malformed_response",
			retryable: false,
		});
	});

	it("treats a 200 without usage as malformed_response", async () => {
		const { fetch: fetchImpl } = fakeFetch([
			rawResponse(200, JSON.stringify({ model: DEFAULT_JEV_MODEL_ID, answers: {} })),
		]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({ kind: "malformed_response" });
	});

	it("treats a 200 missing one requested answer id as malformed_response", async () => {
		const { fetch: fetchImpl } = fakeFetch([okResponse({ drop_aaaaaaaaaaaa: 0.9 })]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({ kind: "malformed_response" });
	});

	it("treats a noul outside [0,1] as malformed_response", async () => {
		const { fetch: fetchImpl } = fakeFetch([okResponse({ drop_aaaaaaaaaaaa: 1.5, drop_bbbbbbbbbbbb: 0.5 })]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({ kind: "malformed_response" });
	});

	it("retries a rate limit and succeeds with full-jitter backoff", async () => {
		const { fetch: fetchImpl, calls } = fakeFetch([rawResponse(429, "slow down"), okResponse({ drop_aaaaaaaaaaaa: 0.9, drop_bbbbbbbbbbbb: 0.2 })]);
		const sleeps: number[] = [];

		const result = await makeClient(fetchImpl, recordingSleep(sleeps)).askNouls(REQUEST);

		expect(result.answers.get("drop_aaaaaaaaaaaa")).toBe(0.9);
		expect(calls).toHaveLength(2);
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThanOrEqual(0);
		expect(sleeps[0]).toBeLessThanOrEqual(500);
	});

	it("honors a Retry-After header within the backoff cap", async () => {
		const { fetch: fetchImpl, calls } = fakeFetch([
			rawResponse(429, "slow down", { "retry-after": "2" }),
			okResponse({ drop_aaaaaaaaaaaa: 0.9, drop_bbbbbbbbbbbb: 0.2 }),
		]);
		const sleeps: number[] = [];

		await makeClient(fetchImpl, recordingSleep(sleeps)).askNouls(REQUEST);

		expect(calls).toHaveLength(2);
		expect(sleeps[0]).toBe(2_000);
	});

	it("clamps an oversized Retry-After to the backoff cap", async () => {
		const { fetch: fetchImpl } = fakeFetch([
			rawResponse(429, "slow down", { "retry-after": "3600" }),
			okResponse({ drop_aaaaaaaaaaaa: 0.9, drop_bbbbbbbbbbbb: 0.2 }),
		]);
		const sleeps: number[] = [];

		await makeClient(fetchImpl, recordingSleep(sleeps)).askNouls(REQUEST);

		expect(sleeps[0]).toBe(5_000);
	});

	it("falls back to jitter when Retry-After is unparseable", async () => {
		const { fetch: fetchImpl } = fakeFetch([
			rawResponse(429, "slow down", { "retry-after": "soon" }),
			okResponse({ drop_aaaaaaaaaaaa: 0.9, drop_bbbbbbbbbbbb: 0.2 }),
		]);
		const sleeps: number[] = [];

		await makeClient(fetchImpl, recordingSleep(sleeps)).askNouls(REQUEST);

		expect(sleeps[0]).toBeGreaterThanOrEqual(0);
		expect(sleeps[0]).toBeLessThanOrEqual(500);
	});

	it("exhausts attempts and throws the last retryable error", async () => {
		const { fetch: fetchImpl } = fakeFetch([rawResponse(429, "slow"), rawResponse(529, "over"), rawResponse(500, "boom")]);
		const sleeps: number[] = [];

		await expect(makeClient(fetchImpl, recordingSleep(sleeps)).askNouls(REQUEST)).rejects.toMatchObject({ kind: "network" });
		expect(sleeps).toHaveLength(2);
	});

	it("keeps fetch failure details in the network error message", async () => {
		const { fetch: fetchImpl } = fakeFetch([new Error("network down"), new Error("network down"), new Error("network down")]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({
			kind: "network",
			message: expect.stringContaining("network down"),
		});
	});

	it("reports a caller abort as aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetch: fetchImpl, calls } = fakeFetch([new Error("unused")], true);

		await expect(
			makeClient(fetchImpl).askNouls({ ...REQUEST, signal: controller.signal }),
		).rejects.toMatchObject({ kind: "aborted", retryable: false });
		expect(calls).toHaveLength(1);
	});

	it("reports a timeout abort as aborted", async () => {
		const { fetch: fetchImpl } = fakeFetch([new DOMException("This operation was aborted", "AbortError")]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toMatchObject({
			kind: "aborted",
			retryable: false,
		});
	});

	it("never writes the API key outside the Authorization header", async () => {
		const key = "sk-super-secret-42";
		const { fetch: fetchImpl, calls } = fakeFetch([rawResponse(429, "slow"), rawResponse(500, "boom"), rawResponse(401, "bad")]);

		const caught: unknown = await createJevClient({ apiKey: key, fetchImpl, sleep: async () => {} })
			.askNouls(REQUEST)
			.catch(async (error: unknown) => error);

		expect(caught).toBeInstanceOf(JevRequestError);
		const message = caught instanceof JevRequestError ? caught.message : "";
		expect(message).not.toContain(key);
		for (const call of calls) {
			expect(new Headers(call.headers).get("authorization")).toBe(`Bearer ${key}`);
			expect(String(call.body ?? "")).not.toContain(key);
		}
	});

	it("starts error messages with the jev.ask_ literal prefix", async () => {
		const { fetch: fetchImpl } = fakeFetch([rawResponse(401, "bad key")]);

		await expect(makeClient(fetchImpl).askNouls(REQUEST)).rejects.toSatisfy((error: unknown) => {
			return error instanceof JevRequestError && error.message.startsWith("jev.ask_");
		});
	});
});
