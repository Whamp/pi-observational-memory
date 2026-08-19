import { randomUUID } from "node:crypto";
import type {
	CompactionEntry,
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens, resolveEffectiveCompactionTrigger } from "../config.js";
import {
	findLastCompactionIndex,
	rawTokensSinceLastCompaction,
	type Entry,
} from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

const BETWEEN_TURN_CONTINUATION_TYPE = "om.compaction.continue";
const BETWEEN_TURN_CONTINUATION_INSTRUCTION = "Continue the interrupted work from the compacted context.";
const BETWEEN_TURN_INVARIANT_ERROR =
	"Observational memory: between-turn compaction completed without safe continuation proof; automatic continuation skipped";

type BetweenTurnNotification = (message: string, type: "info" | "error") => void;

interface BetweenTurnCompactionCycle {
	token: string;
	threshold: number;
	sessionId: string;
	previousCompactionId?: string;
	notify?: BetweenTurnNotification;
}

interface BetweenTurnDeferred<T> {
	settled: Promise<T>;
	release(value: T): void;
}

interface BetweenTurnContinuation {
	token: string;
	settled: Promise<void>;
	release(): void;
}

type BetweenTurnCompactionOutcome =
	| { kind: "complete"; result: CompactionResult }
	| { kind: "error"; error: Error }
	| { kind: "invalidated" };

type BetweenTurnTriggerPhase =
	| { kind: "idle" }
	| { kind: "abortRequested"; cycle: BetweenTurnCompactionCycle }
	| {
		kind: "compacting";
		cycle: BetweenTurnCompactionCycle;
		outcome: BetweenTurnDeferred<BetweenTurnCompactionOutcome>;
		compactEvent?: SessionCompactEvent;
	}
	| {
		kind: "resuming";
		cycle: BetweenTurnCompactionCycle;
		pending: BetweenTurnContinuation;
	};

function createBetweenTurnDeferred<T>(): BetweenTurnDeferred<T> {
	let released = false;
	let releasePromise: (value: T) => void = () => {};
	const settled = new Promise<T>((resolve) => {
		releasePromise = resolve;
	});
	return {
		settled,
		release(value) {
			if (released) return;
			released = true;
			releasePromise(value);
		},
	};
}

function createBetweenTurnContinuation(token: string): BetweenTurnContinuation {
	const deferred = createBetweenTurnDeferred<void>();
	return {
		token,
		settled: deferred.settled,
		release: () => deferred.release(),
	};
}

function betweenTurnPhaseMatchesCycle(
	phase: BetweenTurnTriggerPhase,
	cycle: BetweenTurnCompactionCycle,
): boolean {
	return phase.kind !== "idle" && phase.cycle.token === cycle.token;
}

function latestBetweenTurnCompaction(entries: SessionEntry[]): CompactionEntry | undefined {
	const index = findLastCompactionIndex(entries);
	if (index < 0) return undefined;
	const entry = entries[index];
	return entry?.type === "compaction" ? entry : undefined;
}

type BetweenTurnContextRead<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown };

function readBetweenTurnContext<T>(read: () => T): BetweenTurnContextRead<T> {
	try {
		return { ok: true, value: read() };
	} catch (error) {
		return { ok: false, error };
	}
}

function isBetweenTurnSessionCurrent(
	cycle: BetweenTurnCompactionCycle,
	ctx: ExtensionContext,
): boolean {
	const sessionId = readBetweenTurnContext(() => ctx.sessionManager.getSessionId());
	return sessionId.ok && sessionId.value === cycle.sessionId;
}

function currentBetweenTurnBranch(
	cycle: BetweenTurnCompactionCycle,
	ctx: ExtensionContext,
): SessionEntry[] | undefined {
	const snapshot = readBetweenTurnContext(() => ({
		sessionId: ctx.sessionManager.getSessionId(),
		entries: ctx.sessionManager.getBranch(),
	}));
	if (!snapshot.ok || snapshot.value.sessionId !== cycle.sessionId) return undefined;
	return snapshot.value.entries;
}

function compactionEntryMatchesResult(
	entry: CompactionEntry,
	result: CompactionResult,
): boolean {
	return (
		entry.summary === result.summary
		&& entry.firstKeptEntryId === result.firstKeptEntryId
		&& entry.tokensBefore === result.tokensBefore
	);
}

function findProvenContinuationCompaction(
	cycle: BetweenTurnCompactionCycle,
	compactEvent: SessionCompactEvent | undefined,
	result: CompactionResult,
	entries: SessionEntry[],
): CompactionEntry | undefined {
	// Pi 0.81 finds the event entry by summary, so repeated summaries can point to an
	// older id and boundary. Use the event only as timed manual-compaction evidence;
	// the latest branch entry below proves the callback result was persisted.
	if (!compactEvent || compactEvent.compactionEntry.summary !== result.summary) return undefined;

	const latestCompaction = latestBetweenTurnCompaction(entries);
	if (!latestCompaction || latestCompaction.id === cycle.previousCompactionId) return undefined;
	if (!compactionEntryMatchesResult(latestCompaction, result)) return undefined;
	if (rawTokensSinceLastCompaction(entries) >= cycle.threshold) return undefined;
	return latestCompaction;
}

function matchingContinuationToken(event: { message: unknown }): string | undefined {
	const message = event.message;
	if (typeof message !== "object" || message === null) return undefined;
	if (!("role" in message) || message.role !== "custom") return undefined;
	if (!("customType" in message) || message.customType !== BETWEEN_TURN_CONTINUATION_TYPE) return undefined;
	if (!("details" in message) || typeof message.details !== "object" || message.details === null) {
		return undefined;
	}
	if (!("token" in message.details) || typeof message.details.token !== "string") return undefined;
	return message.details.token;
}

/** Registers proactive compaction policies without changing Compaction Authority. */
export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	let phase: BetweenTurnTriggerPhase = { kind: "idle" };
	const activeContinuations: BetweenTurnContinuation[] = [];

	const invalidateBetweenTurnPhase = (): void => {
		const invalidatedPhase = phase;
		phase = { kind: "idle" };
		runtime.compactInFlight = false;
		if (invalidatedPhase.kind === "compacting") {
			invalidatedPhase.outcome.release({ kind: "invalidated" });
		}
		if (invalidatedPhase.kind === "resuming") {
			invalidatedPhase.pending.release();
		}
	};

	const clearBetweenTurnCycle = (cycle: BetweenTurnCompactionCycle): void => {
		if (!betweenTurnPhaseMatchesCycle(phase, cycle)) return;
		invalidateBetweenTurnPhase();
	};

	const releaseActiveContinuation = (continuation: BetweenTurnContinuation | undefined): void => {
		if (!continuation) return;
		const index = activeContinuations.lastIndexOf(continuation);
		if (index >= 0) activeContinuations.splice(index, 1);
		continuation.release();
	};

	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;
		if (resolveEffectiveCompactionTrigger(runtime.config, ctx.mode) !== "agentEnd") return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const progress = rawTokensSinceLastCompaction(entries);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${progress.toLocaleString()} estimated source tokens); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		setTimeout(() => {
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
				if (!currentEntries) {
					runtime.compactInFlight = false;
					return;
				}
				const currentProgress = rawTokensSinceLastCompaction(currentEntries);
				if (currentProgress < threshold) {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						runtime.compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});

	pi.on("turn_end", (event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (resolveEffectiveCompactionTrigger(runtime.config, ctx.mode) !== "betweenTurns") return;
		if (runtime.config.passive === true) return;
		if (phase.kind !== "idle" || runtime.compactInFlight) return;
		if (event.toolResults.length === 0) return;
		if (ctx.hasPendingMessages()) return;

		const entries = ctx.sessionManager.getBranch();
		const tokens = rawTokensSinceLastCompaction(entries);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (tokens < threshold) return;

		const previousCompaction = latestBetweenTurnCompaction(entries);
		let notify: BetweenTurnNotification | undefined;
		if (ctx.hasUI) {
			const ui = ctx.ui;
			notify = (message, type) => ui.notify(message, type);
		}
		const cycle: BetweenTurnCompactionCycle = {
			token: randomUUID(),
			threshold,
			sessionId: ctx.sessionManager.getSessionId(),
			previousCompactionId: previousCompaction?.id,
			notify,
		};

		phase = { kind: "abortRequested", cycle };
		runtime.compactInFlight = true;
		notify?.(
			`Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
			"info",
		);
		try {
			ctx.abort();
		} catch {
			clearBetweenTurnCycle(cycle);
		}
	});

	pi.on("session_compact", (event) => {
		if (phase.kind !== "compacting") return;
		if (event.reason !== "manual" || event.willRetry) return;
		phase = { ...phase, compactEvent: event };
	});

	pi.on("message_start", (event, ctx) => {
		if (phase.kind !== "resuming") return;
		if (matchingContinuationToken(event) !== phase.pending.token) return;
		const { cycle, pending } = phase;
		if (!isBetweenTurnSessionCurrent(cycle, ctx)) {
			clearBetweenTurnCycle(cycle);
			return;
		}
		activeContinuations.push(pending);
		phase = { kind: "idle" };
		runtime.compactInFlight = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const settlingContinuation = activeContinuations.at(-1);
		const settlementCycle = phase.kind === "idle" ? undefined : phase.cycle;
		try {
			if (phase.kind === "resuming") {
				clearBetweenTurnCycle(phase.cycle);
				return;
			}
			if (phase.kind !== "abortRequested") return;
			const cycle = phase.cycle;
			if (!isBetweenTurnSessionCurrent(cycle, ctx)) {
				clearBetweenTurnCycle(cycle);
				return;
			}
			try {
				if (!ctx.isIdle()) {
					clearBetweenTurnCycle(cycle);
					return;
				}
			} catch {
				clearBetweenTurnCycle(cycle);
				return;
			}

			const outcome = createBetweenTurnDeferred<BetweenTurnCompactionOutcome>();
			phase = { kind: "compacting", cycle, outcome };
			ctx.compact({
				onComplete: (result) => outcome.release({ kind: "complete", result }),
				onError: (error) => outcome.release({ kind: "error", error }),
			});

			const compactOutcome = await outcome.settled;
			if (compactOutcome.kind === "invalidated") return;
			if (!betweenTurnPhaseMatchesCycle(phase, cycle) || phase.kind !== "compacting") return;
			if (compactOutcome.kind === "error") {
				clearBetweenTurnCycle(cycle);
				if (compactOutcome.error.message !== "Compaction cancelled") {
					cycle.notify?.(`Observational memory: ${compactOutcome.error.message}`, "error");
				}
				return;
			}

			cycle.notify?.("Observational memory: compaction complete", "info");
			const entries = currentBetweenTurnBranch(cycle, ctx);
			if (!entries) {
				clearBetweenTurnCycle(cycle);
				return;
			}
			const provenCompaction = findProvenContinuationCompaction(
				cycle,
				phase.compactEvent,
				compactOutcome.result,
				entries,
			);
			if (!provenCompaction) {
				clearBetweenTurnCycle(cycle);
				cycle.notify?.(BETWEEN_TURN_INVARIANT_ERROR, "error");
				return;
			}

			const pending = createBetweenTurnContinuation(cycle.token);
			phase = { kind: "resuming", cycle, pending };
			try {
				pi.sendMessage(
					{
						customType: BETWEEN_TURN_CONTINUATION_TYPE,
						content: BETWEEN_TURN_CONTINUATION_INSTRUCTION,
						display: false,
						details: {
							token: cycle.token,
							compactionEntryId: provenCompaction.id,
						},
					},
					{ triggerTurn: true },
				);
			} catch {
				clearBetweenTurnCycle(cycle);
				return;
			}
			await pending.settled;
		} catch (error) {
			if (settlementCycle) clearBetweenTurnCycle(settlementCycle);
			throw error;
		} finally {
			releaseActiveContinuation(settlingContinuation);
		}
	});

	pi.on("session_shutdown", () => {
		invalidateBetweenTurnPhase();
		while (activeContinuations.length > 0) {
			activeContinuations.pop()?.release();
		}
	});
}
