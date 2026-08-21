import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	ModelRegistry,
	type AgentStartEvent,
	type ExtensionAPI,
	type SessionShutdownEvent,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { DEFAULTS } from "../src/config.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
	isObservationsRecordedData,
	OM_OBSERVATIONS_RECORDED,
	type ObservationsRecordedEntryData,
} from "../src/session-ledger/index.js";
import { textCustomMessage } from "./fixtures/session.js";

/**
 * End-to-end coverage for OAuth-authenticated providers: a headers-only auth
 * resolution (no apiKey) must flow from pi's real ModelRegistry through
 * resolveModel into a real observer model request that authenticates with the
 * caller-supplied Authorization header, and the resulting observations must land
 * in the session ledger.
 */

const OAUTH_TOKEN = "Bearer pi-oauth-access-token";

interface RecordedRequest {
	headers: IncomingHttpHeaders;
}

interface AppendedEntry {
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
}

interface ConsolidationTestContext {
	cwd: string;
	hasUI: boolean;
	ui: { notify: (message: string) => void };
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	sessionManager: { getBranch: () => ReturnType<typeof textCustomMessage>[] };
}

type ConsolidationTriggerEvent = AgentStartEvent | TurnEndEvent | SessionShutdownEvent;
type TriggerHandler = (event: ConsolidationTriggerEvent, ctx: ConsolidationTestContext) => void;

function turnEndEvent(): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "user", content: "OAuth integration test", timestamp: 0 },
		toolResults: [],
	};
}

function recordedAppend(customType: string, data: unknown): AppendedEntry {
	if (customType !== OM_OBSERVATIONS_RECORDED || !isObservationsRecordedData(data)) {
		throw new Error(`OAuth test received unexpected ledger entry: ${customType}`);
	}
	return { customType, data };
}

function sse(events: Array<[string, unknown]>): string {
	return events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");
}

function toolUseStream(toolInput: unknown): string {
	return sse([
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_e2e",
					type: "message",
					role: "assistant",
					model: "om-e2e",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 12, output_tokens: 0 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_e2e",
					name: "record_observations",
					input: {},
				},
			},
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 30 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
}

async function startMockAnthropic(
	requests: RecordedRequest[],
): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			requests.push({ headers: req.headers });
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.end(
				toolUseStream({
					observations: [
						{
							timestamp: "2026-05-02 10:30",
							content:
								"User authenticated with an OAuth provider and asked for memory consolidation.",
							relevance: "high",
							sourceEntryIds: ["raw-1"],
						},
					],
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("OAuth test server did not bind a TCP port");
	}
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function modelRuntimeForOAuth(options: {
	headers?: Record<string, string>;
	authHeader: boolean;
	oauthProvider: string;
}): ConstructorParameters<typeof ModelRegistry>[0] {
	const runtime = {
		getAuth: async () => undefined,
		getCompatibilityRequestConfig: () => ({
			headers: options.headers,
			authHeader: options.authHeader,
		}),
		isUsingOAuth: (providerId: string) => providerId === options.oauthProvider,
	};
	// SAFETY: These are the only ModelRuntime methods ModelRegistry calls in this auth test.
	return runtime as ConstructorParameters<typeof ModelRegistry>[0];
}

function oauthModelRegistry(provider: string): ModelRegistry {
	return new ModelRegistry(
		modelRuntimeForOAuth({
			headers: { Authorization: OAUTH_TOKEN },
			authHeader: false,
			oauthProvider: provider,
		}),
	);
}

function expiredOAuthModelRegistry(provider: string): ModelRegistry {
	return new ModelRegistry(modelRuntimeForOAuth({ authHeader: true, oauthProvider: provider }));
}

function oauthTestModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "om-e2e",
		name: "OAuth E2E",
		api: "anthropic-messages",
		provider: "kimi-coding",
		baseUrl: "http://127.0.0.1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
		...overrides,
	};
}

function registerTestTrigger(
	pi: {
		on: (eventName: string, handler: TriggerHandler) => void;
		appendEntry: (customType: string, data: unknown) => void;
	},
	runtime: Runtime,
): void {
	// SAFETY: registerConsolidationTrigger uses only ExtensionAPI.on and appendEntry.
	registerConsolidationTrigger(pi as ExtensionAPI, runtime);
}

let activeServer: Server | undefined;

afterEach(async () => {
	const server = activeServer;
	if (server) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	activeServer = undefined;
});

describe("OAuth provider end-to-end consolidation", () => {
	it("records observations using headers-only OAuth auth on a real model request", async () => {
		const requests: RecordedRequest[] = [];
		const { server, baseUrl } = await startMockAnthropic(requests);
		activeServer = server;

		const model = oauthTestModel({ baseUrl });
		const entries = [
			textCustomMessage("raw-1", "User: please remember that the OAuth login works."),
		];
		const appended: AppendedEntry[] = [];
		const notices: string[] = [];
		const handlers: Record<string, TriggerHandler | undefined> = {};
		const pi = {
			on: vi.fn((eventName: string, handler: TriggerHandler) => {
				handlers[eventName] = handler;
			}),
			appendEntry: vi.fn((customType: string, data: unknown) => {
				appended.push(recordedAppend(customType, data));
			}),
		};

		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = {
			...DEFAULTS,
			observeAfterTokens: 1,
			reflectAfterTokens: 1_000_000,
			agentMaxTurns: 1,
		};

		registerTestTrigger(pi, runtime);
		const turnEnd = handlers.turn_end;
		if (!turnEnd) {
			throw new Error("OAuth test did not register turn_end");
		}
		turnEnd(turnEndEvent(), {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
			model,
			modelRegistry: oauthModelRegistry(model.provider),
			sessionManager: { getBranch: () => entries },
		});
		await runtime.consolidationPromise;

		expect(requests).toHaveLength(1);
		expect(requests[0].headers.authorization).toBe(OAUTH_TOKEN);
		expect(requests[0].headers["x-api-key"]).toBeUndefined();

		expect(appended).toHaveLength(1);
		const recordedData = appended[0].data;
		expect(recordedData.observations[0].content).toContain("OAuth provider");
		expect(recordedData.coversUpToId).toBe("raw-1");
		expect(notices.filter((message) => message.includes("skipped"))).toEqual([]);
	});

	it("tells the user to re-login when OAuth credentials no longer resolve", async () => {
		const model = oauthTestModel({
			id: "gpt-5-codex",
			name: "Codex",
			api: "openai-responses",
			provider: "openai-codex",
		});
		const entries = [
			textCustomMessage("raw-1", "User: please remember that the OAuth login works."),
		];
		const notices: string[] = [];
		const appended: AppendedEntry[] = [];
		const handlers: Record<string, TriggerHandler | undefined> = {};
		const pi = {
			on: vi.fn((eventName: string, handler: TriggerHandler) => {
				handlers[eventName] = handler;
			}),
			appendEntry: vi.fn((customType: string, data: unknown) => {
				appended.push(recordedAppend(customType, data));
			}),
		};

		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = {
			...DEFAULTS,
			observeAfterTokens: 1,
			reflectAfterTokens: 1_000_000,
			agentMaxTurns: 1,
		};

		registerTestTrigger(pi, runtime);
		const turnEnd = handlers.turn_end;
		if (!turnEnd) {
			throw new Error("OAuth test did not register turn_end");
		}
		turnEnd(turnEndEvent(), {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
			model,
			modelRegistry: expiredOAuthModelRegistry(model.provider),
			sessionManager: { getBranch: () => entries },
		});
		await runtime.consolidationPromise;

		const skipped = notices.find((message) => message.includes("skipped"));
		expect(skipped).toBe(
			"Observational memory: observer skipped — authentication failed for provider \"openai-codex\" — OAuth credentials may have expired; run '/login openai-codex' to re-authenticate",
		);
		expect(appended).toEqual([]);
	});
});
