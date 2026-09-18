import { debugLog } from "../../debug-log.js";
import {
	JevRequestError,
	type JevClient,
	type JevQuestionSet,
	type JevRequestErrorKind,
	type JevStateValue,
} from "../../jev/client.js";
import { estimateJevTokens } from "../../jev/token-estimate.js";
import { reflectionToSummaryLine, type Observation, type Reflection } from "../../session-ledger/index.js";
import { selectDropCandidates } from "./agent.js";
import { reflectionCoverageMap, type ReflectionCoverageTier } from "./coverage.js";
import { observationPoolMetrics } from "./pool.js";
import { JEV_DROP_CONTEXT, JEV_DROP_CRITERIA, jevDropInstruction } from "./prompts.js";

/**
 * Noul score at or above which an observation joins the drop proposal set.
 * Tuned against jev-1.13.0 in phase 0; a code constant, not a config knob.
 */
export const JEV_DROP_NOUL_THRESHOLD = 0.8;

/**
 * Estimated-token budget per Jev chunk (state plus questions), with margin
 * under the API's 32k state ceiling. The API bills state + questions, so the
 * budget is checked against exactly that serialized body.
 */
export const JEV_CHUNK_TARGET_TOKENS = 24_000;

/**
 * ageMinutes value reported for observations whose timestamp cannot be parsed.
 * It is the largest age, so unparseable observations lead the oldest-first state
 * as ancient.
 */
export const JEV_UNPARSEABLE_AGE_MINUTES = 1_000_000_000;

/** One active observation rendered as a Jev state fact: id, content, relevance, coverage tier, and age in minutes. */
export interface JevObservationFacts {
	id: string;
	content: string;
	relevance: Observation["relevance"];
	coverage: ReflectionCoverageTier;
	ageMinutes: number;
}

/**
 * State sent to Jev for the drop decision: the shared briefing, reflection
 * summary lines, and one fact per active observation, oldest-first.
 */
export interface JevDropperState {
	context: string;
	reflections: string[];
	observations: JevObservationFacts[];
}

/** Minutes since an observation was recorded; clamped at zero, sentinel when the timestamp cannot be parsed. */
function observationAgeMinutes(timestamp: string, referenceTimeMs: number): number {
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) return JEV_UNPARSEABLE_AGE_MINUTES;
	return Math.max(0, Math.floor((referenceTimeMs - parsed) / 60_000));
}

/**
 * Build the Jev dropper state from the active pool: observations sorted
 * oldest-first (unparseable timestamps last), reflection coverage tiers from
 * the current reflections, and age in whole minutes. Pure apart from the
 * default reference time.
 */
export function buildJevDropperState(
	observations: readonly Observation[],
	reflections: readonly Reflection[],
	referenceTimeMs: number = Date.now(),
): JevDropperState {
	const coverageById = reflectionCoverageMap(observations, reflections);
	const facts: JevObservationFacts[] = observations.map((observation) => ({
		id: observation.id,
		content: observation.content,
		relevance: observation.relevance,
		coverage: coverageById.get(observation.id) ?? "none",
		ageMinutes: observationAgeMinutes(observation.timestamp, referenceTimeMs),
	}));
	// Oldest first: larger age earlier. The unparseable-timestamp sentinel is the
	// largest age, so unparseable observations lead the state as ancient.
	facts.sort((a, b) => b.ageMinutes - a.ageMinutes);
	return {
		context: JEV_DROP_CONTEXT,
		reflections: reflections.map(reflectionToSummaryLine),
		observations: facts,
	};
}

/** Build one noul question per observation id, keyed `drop_<id>`, sharing the preservation-floor criteria. */
export function buildJevDropQuestions(observationIds: readonly string[]): JevQuestionSet {
	const questions: JevQuestionSet = {};
	for (const id of observationIds) {
		questions[dropQuestionKey(id)] = {
			type: "noul",
			instructions: jevDropInstruction(id),
			criteria: JEV_DROP_CRITERIA,
		};
	}
	return questions;
}

/** Question key for one observation id, shared by the question builder and the verdict merge. */
function dropQuestionKey(id: string): string {
	return `drop_${id}`;
}

/** One chunk of the Jev dropper state: the observations packed into a single request. */
export interface JevDropperChunk {
	observationIds: string[];
	observations: JevObservationFacts[];
}

/** Chunking plan: whole-observation chunks, plus oversized=true when the pool cannot fit at all. */
export interface JevDropperPlan {
	chunks: JevDropperChunk[];
	oversized: boolean;
}

/** Exact estimated tokens of the request body for one chunk: the serialized state plus questions. */
function jevChunkBodyTokens(state: JevDropperState, chunk: JevDropperChunk): number {
	return estimateJevTokens(JSON.stringify({
		state: jevChunkStateValue(state, chunk),
		questions: buildJevDropQuestions(chunk.observationIds),
	}));
}

/**
 * Greedy whole-observation pack under the estimated-token budget. Each
 * candidate chunk is measured as the exact serialized body (state plus
 * questions, the same basis the API bills), so the budget cannot be undercounted
 * by envelope or quoting overhead. oversized=true when a single observation
 * cannot fit a chunk by itself; the estimator overcounts by design, so the
 * flag fails the run closed instead of risking an over-limit request.
 */
export function chunkJevDropperState(
	state: JevDropperState,
	chunkTargetTokens: number = JEV_CHUNK_TARGET_TOKENS,
): JevDropperPlan {
	const chunks: JevDropperChunk[] = [];
	let current: JevDropperChunk | undefined;
	for (const fact of state.observations) {
		if (
			current
			&& jevChunkBodyTokens(state, {
				observationIds: [...current.observationIds, fact.id],
				observations: [...current.observations, fact],
			}) <= chunkTargetTokens
		) {
			current.observationIds.push(fact.id);
			current.observations.push(fact);
			continue;
		}
		const fresh: JevDropperChunk = { observationIds: [fact.id], observations: [fact] };
		if (jevChunkBodyTokens(state, fresh) > chunkTargetTokens) {
			return { chunks, oversized: true };
		}
		current = fresh;
		chunks.push(fresh);
	}
	return { chunks, oversized: false };
}

/**
 * Wire value for one chunk's request state: the globals plus only that chunk's
 * observation facts. The conversion to the transport's JSON tree happens here,
 * at the last point that knows both shapes.
 */
export function jevChunkStateValue(state: JevDropperState, chunk: JevDropperChunk): JevStateValue {
	return {
		context: state.context,
		reflections: state.reflections,
		observations: chunk.observations.map((fact) => ({
			id: fact.id,
			content: fact.content,
			relevance: fact.relevance,
			coverage: fact.coverage,
			ageMinutes: fact.ageMinutes,
		})),
	};
}

/** Verdict cleared of the threshold, kept with pool order for the stable tiebreak. */
interface ClearedVerdict {
	id: string;
	noul: number;
	index: number;
}

/**
 * Map threshold-cleared noul verdicts through the shared deterministic ranking.
 * Proposals are ordered noul-desc (stable by pool order) before
 * {@link selectDropCandidates}, so ties in coverage, relevance, and age prefer
 * the most confidently droppable observation. Returns undefined when nothing
 * clears the threshold.
 */
export function selectJevDropIds(
	verdicts: ReadonlyMap<string, number>,
	observations: readonly Observation[],
	maxDropsAllowed: number,
	reflections: readonly Reflection[],
	threshold: number = JEV_DROP_NOUL_THRESHOLD,
): string[] | undefined {
	const cleared: ClearedVerdict[] = [];
	for (let index = 0; index < observations.length; index++) {
		const id = observations[index].id;
		const noul = verdicts.get(id);
		if (noul !== undefined && noul >= threshold) cleared.push({ id, noul, index });
	}
	cleared.sort((a, b) => b.noul - a.noul || a.index - b.index);
	const selected = selectDropCandidates(cleared.map((entry) => entry.id), observations, maxDropsAllowed, reflections);
	return selected.length > 0 ? selected : undefined;
}

/**
 * Transport or state failure surfaced by a Jev dropper run. `unexpected` covers
 * a throw that is not a {@link JevRequestError}.
 */
export type JevDropperFailureReason = JevRequestErrorKind | "state_too_large";

/**
 * Outcome of one Jev dropper run. `dropped` is success, including zero drops
 * (droppedIds undefined); `failed` hands the run to the LLM dropper upstream.
 */
export type JevDropperOutcome =
	| { outcome: "dropped"; droppedIds?: string[] }
	| { outcome: "failed"; reason: JevDropperFailureReason };

export interface RunJevDropperArgs {
	/** Injected Jev transport; production passes the client from createJevClient. */
	client: JevClient;
	observations: Observation[];
	reflections: Reflection[];
	targetTokens: number;
	signal?: AbortSignal;
}

/**
 * Run the Jev dropper decision. All-or-nothing per run: every chunk must answer
 * before anything is dropped, and a transport failure fails the whole run
 * without using partial verdicts. Never throws for API failure.
 */
export async function runJevDropper(args: RunJevDropperArgs): Promise<JevDropperOutcome> {
	const metrics = observationPoolMetrics(args.observations, args.targetTokens);
	if (args.observations.length === 0 || metrics.maxDropsAllowed <= 0) return { outcome: "dropped" };

	debugLog("dropper.jev_start", {
		activeObservationCount: args.observations.length,
		reflectionCount: args.reflections.length,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	const state = buildJevDropperState(args.observations, args.reflections);
	const plan = chunkJevDropperState(state);
	if (plan.oversized) {
		debugLog("dropper.jev_result", {
			outcome: "failed",
			reason: "state_too_large",
			chunkCount: 0,
			verdictCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			droppedIdsCount: 0,
		});
		return { outcome: "failed", reason: "state_too_large" };
	}

	const verdicts = new Map<string, number>();
	let inputTokens = 0;
	let outputTokens = 0;
	for (const [chunkIndex, chunk] of plan.chunks.entries()) {
		debugLog("dropper.jev_chunk", {
			chunkIndex,
			chunkCount: plan.chunks.length,
			chunkObservationCount: chunk.observationIds.length,
		});
		try {
			const result = await args.client.askNouls({
				state: jevChunkStateValue(state, chunk),
				questions: buildJevDropQuestions(chunk.observationIds),
				signal: args.signal,
			});
			for (const id of chunk.observationIds) {
				const noul = result.answers.get(dropQuestionKey(id));
				if (noul !== undefined) verdicts.set(id, noul);
			}
			inputTokens += result.usage.inputTokens;
			outputTokens += result.usage.outputTokens;
		} catch (error) {
			const reason = error instanceof JevRequestError ? error.kind : "unexpected";
			debugLog("dropper.jev_result", {
				outcome: "failed",
				reason,
				chunkIndex,
				chunkCount: plan.chunks.length,
				verdictCount: verdicts.size,
				inputTokens,
				outputTokens,
				droppedIdsCount: 0,
			});
			return { outcome: "failed", reason };
		}
	}

	const droppedIds = selectJevDropIds(verdicts, args.observations, metrics.maxDropsAllowed, args.reflections);
	debugLog("dropper.jev_result", {
		outcome: "dropped",
		droppedIdsCount: droppedIds?.length ?? 0,
		verdictCount: verdicts.size,
		chunkCount: plan.chunks.length,
		inputTokens,
		outputTokens,
	});
	return { outcome: "dropped", droppedIds };
}
