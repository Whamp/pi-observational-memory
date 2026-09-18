/**
 * TypeSafe System One transport for Jev noul requests.
 *
 * The client owns the wire contract only: one POST to the System One endpoint
 * with `Bearer` auth, bounded retries for transient failures, and strict
 * response validation at the boundary. It never interprets the state, never
 * logs, and never writes the API key anywhere except the Authorization header.
 */

/** Default System One model id used when no override is configured. */
export const DEFAULT_JEV_MODEL_ID = "jev-1.13.0";

const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_JEV_TIMEOUT_MS = 15_000;
const DEFAULT_JEV_MAX_ATTEMPTS = 3;
const DEFAULT_JEV_BACKOFF_BASE_MS = 500;
const DEFAULT_JEV_BACKOFF_MAX_MS = 5_000;

/**
 * JSON-serializable state accepted by the System One API. The client serializes
 * this tree verbatim; the caller owns the shape and meaning of every field.
 */
export type JevStateValue =
	| string
	| number
	| boolean
	| null
	| readonly JevStateValue[]
	| { readonly [key: string]: JevStateValue };

/** Meaning of the noul scale ends, written for Jev's literal reading. */
export interface JevNoulCriteria {
	/** What a noul of 1 means. */
	true?: string;
	/** What a noul of 0 means. */
	false?: string;
}

/** One noul question: a graded [0,1] answer on the stated instructions. */
export interface JevNoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: JevNoulCriteria;
}

/** Noul questions keyed by caller-chosen id, one answer per key. */
export type JevQuestionSet = Record<string, JevNoulQuestion>;

export interface JevAskRequest {
	/** JSON-serializable state; the client serializes it, the caller owns the shape. */
	state: JevStateValue;
	questions: JevQuestionSet;
	signal?: AbortSignal;
}

/** Token usage reported by the API for one request. */
export interface JevUsage {
	inputTokens: number;
	outputTokens: number;
}

/**
 * One noul per requested question id. The map covers every requested id and
 * every value is validated to [0,1] at the boundary.
 */
export interface JevAskResult {
	answers: ReadonlyMap<string, number>;
	usage: JevUsage;
}

/**
 * Jev transport failure kinds. `unexpected` is never produced by the client;
 * it is how a consumer surfaces a throw that is not a {@link JevRequestError}.
 */
export type JevRequestErrorKind =
	| "unauthorized"
	| "invalid_request"
	| "payload_too_large"
	| "rate_limited"
	| "overloaded"
	| "network"
	| "malformed_response"
	| "aborted"
	| "unexpected";

/**
 * Thrown by {@link JevClient.askNouls} when retries are exhausted or on a
 * non-retryable failure. Messages start with the literal `jev.ask_` so a log
 * line greps back to this module, and never contain the API key.
 */
export class JevRequestError extends Error {
	readonly kind: JevRequestErrorKind;
	readonly retryable: boolean;

	constructor(kind: JevRequestErrorKind, message: string, retryable: boolean) {
		super(message);
		this.name = "JevRequestError";
		this.kind = kind;
		this.retryable = retryable;
	}
}

export interface JevClientOptions {
	/** System One API key. Sent only as the Authorization bearer token. */
	apiKey: string;
	/** Pinned System One model id; defaults to {@link DEFAULT_JEV_MODEL_ID}. */
	modelId?: string;
	/** System One endpoint; defaults to the public api.typesafe.ai URL. */
	endpoint?: string;
	/** Per-attempt timeout in milliseconds; defaults to 15_000. */
	timeoutMs?: number;
	/** Total attempts including the first; defaults to 3. */
	maxAttempts?: number;
	/** Base delay for full-jitter exponential backoff in milliseconds; defaults to 500. */
	backoffBaseMs?: number;
	/** Upper bound for backoff waits and clamped Retry-After waits in milliseconds; defaults to 5_000. */
	backoffMaxMs?: number;
	/** Fetch implementation; defaults to the global fetch (test seam). */
	fetchImpl?: typeof fetch;
	/** Backoff wait implementation; defaults to a timed promise (test seam). */
	sleep?: (ms: number) => Promise<void>;
}

export interface JevClient {
	/**
	 * One noul per question id. Retries rate limits (429), overload (529), and
	 * network failures with full-jitter exponential backoff, honoring a 429
	 * Retry-After header clamped to the backoff cap. Throws
	 * {@link JevRequestError}; never throws anything else.
	 */
	askNouls(request: JevAskRequest): Promise<JevAskResult>;
}

/** One classified non-2xx status: the error to keep, plus an optional Retry-After delay. */
interface ClassifiedStatusError {
	error: JevRequestError;
	retryAfterMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the System One 200 body into one noul per requested id. Returns
 * undefined when any requested id is missing, any noul is missing or outside
 * [0,1], or usage is absent/malformed — the boundary refuses partial answers.
 */
function parseJevAnswers(text: string, requestedIds: readonly string[]): JevAskResult | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.answers) || !isRecord(parsed.usage)) return undefined;
	const inputTokens = finiteNumberOrUndefined(parsed.usage.input_tokens);
	const outputTokens = finiteNumberOrUndefined(parsed.usage.output_tokens);
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const answers = new Map<string, number>();
	for (const id of requestedIds) {
		const entry = parsed.answers[id];
		const noul = isRecord(entry) ? finiteNumberOrUndefined(entry.noul) : undefined;
		if (noul === undefined || noul < 0 || noul > 1) return undefined;
		answers.set(id, noul);
	}
	return { answers, usage: { inputTokens, outputTokens } };
}

/** Parse a 429 Retry-After header in seconds; HTTP-date form falls back to backoff. */
function retryAfterMsFromHeader(value: string | null): number | undefined {
	if (value === null) return undefined;
	const seconds = Number.parseInt(value, 10);
	return Number.isInteger(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

/** Map a non-2xx status to its Jev failure kind and retryability. */
function errorForStatus(status: number, body: string, retryAfterHeader: string | null): ClassifiedStatusError {
	if (status === 401) {
		return { error: new JevRequestError("unauthorized", "jev.ask_unauthorized: System One rejected the API key (401)", false) };
	}
	if (status === 429) {
		return {
			error: new JevRequestError("rate_limited", "jev.ask_rate_limited: System One rate limit (429)", true),
			retryAfterMs: retryAfterMsFromHeader(retryAfterHeader),
		};
	}
	if (status === 529) {
		return { error: new JevRequestError("overloaded", "jev.ask_overloaded: System One overloaded (529)", true) };
	}
	if (status >= 500) {
		return { error: new JevRequestError("network", `jev.ask_network: System One server error (${status})`, true) };
	}
	if (status === 400 && body.includes("max_tokens_exceeded")) {
		return {
			error: new JevRequestError(
				"payload_too_large",
				"jev.ask_payload_too_large: state plus questions exceeded the System One limit (400)",
				false,
			),
		};
	}
	return { error: new JevRequestError("invalid_request", `jev.ask_invalid_request: System One rejected the request (${status})`, false) };
}

/** Map a fetch rejection to its Jev failure kind; caller aborts never retry. */
function errorForFetchFailure(error: unknown, callerSignal: AbortSignal | undefined): JevRequestError {
	if (callerSignal?.aborted) {
		return new JevRequestError("aborted", "jev.ask_aborted: caller aborted the System One request", false);
	}
	if (error instanceof Error && error.name === "AbortError") {
		return new JevRequestError("aborted", "jev.ask_aborted: System One request timed out", false);
	}
	const detail = error instanceof Error ? error.message : String(error);
	return new JevRequestError("network", `jev.ask_network: System One request failed (${detail})`, true);
}

/** Delay before the next attempt: clamped Retry-After when present, else full-jitter exponential backoff. */
function nextBackoffMs(retryAfterMs: number | undefined, failedAttempt: number, baseMs: number, maxMs: number): number {
	if (retryAfterMs !== undefined) return Math.min(maxMs, Math.max(0, retryAfterMs));
	return Math.random() * Math.min(maxMs, baseMs * 2 ** failedAttempt);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Create a Jev client bound to one API key. Retries 429/529/network failures
 * with full-jitter exponential backoff; all other failures fail fast.
 */
export function createJevClient(options: JevClientOptions): JevClient {
	const {
		apiKey,
		modelId = DEFAULT_JEV_MODEL_ID,
		endpoint = DEFAULT_JEV_ENDPOINT,
		timeoutMs = DEFAULT_JEV_TIMEOUT_MS,
		maxAttempts = DEFAULT_JEV_MAX_ATTEMPTS,
		backoffBaseMs = DEFAULT_JEV_BACKOFF_BASE_MS,
		backoffMaxMs = DEFAULT_JEV_BACKOFF_MAX_MS,
		fetchImpl = fetch,
		sleep = defaultSleep,
	} = options;

	async function askNouls(request: JevAskRequest): Promise<JevAskResult> {
		const body = JSON.stringify({ state: request.state, model: modelId, questions: request.questions });
		const requestedIds = Object.keys(request.questions);
		let lastError: JevRequestError | undefined;
		let retryAfterMs: number | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0 && lastError) {
				await sleep(nextBackoffMs(retryAfterMs, attempt - 1, backoffBaseMs, backoffMaxMs));
			}
			try {
				const timeoutSignal = AbortSignal.timeout(timeoutMs);
				const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
				const response = await fetchImpl(endpoint, {
					method: "POST",
					headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body,
					signal,
				});
				const text = await response.text();
				if (response.ok) {
					const result = parseJevAnswers(text, requestedIds);
					if (result) return result;
					lastError = new JevRequestError(
						"malformed_response",
						"jev.ask_malformed_response: System One response did not match the noul contract",
						false,
					);
				} else {
					const classified = errorForStatus(response.status, text, response.headers.get("retry-after"));
					lastError = classified.error;
					retryAfterMs = classified.retryAfterMs;
				}
			} catch (error) {
				lastError = errorForFetchFailure(error, request.signal);
				retryAfterMs = undefined;
			}
			if (lastError && !lastError.retryable) throw lastError;
		}
		throw lastError ?? new JevRequestError("unexpected", "jev.ask_unexpected: request loop ended without a response", false);
	}

	return { askNouls };
}
