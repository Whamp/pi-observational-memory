import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { buildDebugLogContext, debugLog, withDebugLogContext } from "../debug-log.js";
import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	compactionAuthority,
	renderSummarySections,
	type Entry,
	type MemoryDetails,
	type RenderedSummary,
	type SummarySize,
} from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

/**
 * The one `compaction.hook_result` outcome for a hook call. Each `reason` is a grep
 * handle shared with docs/configuration.md and the tests, so keep the strings in sync.
 */
type HookOutcome =
	| { reason: "duplicate-suppressed" }
	| {
		reason: "host-owned";
		authorityReason: string;
		tokensBefore: number;
		firstKeptEntryId: string;
	}
	| {
		reason: "empty-summary";
		tokensBefore: number;
		firstKeptEntryId: string;
		observationCount: number;
		reflectionCount: number;
	}
	| {
		reason: "rendered";
		fullFold: boolean;
		tokensBefore: number;
		firstKeptEntryId: string;
		observationCount: number;
		reflectionCount: number;
		size: SummarySize;
		sections: RenderedSummary["sections"];
	};

type HookDecision = {
	/** The reply to Pi. Undefined delegates this compaction to the host. */
	result: { cancel: true } | { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: MemoryDetails } } | undefined;
	outcome: HookOutcome;
};

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => withDebugLogContext(
		buildDebugLogContext(ctx, runtime.config.debugLog === true),
		async () => {
			const decision = await decideCompaction(event, ctx, runtime);
			debugLog("compaction.hook_result", decision.outcome);
			return decision.result;
		},
	));
}

async function decideCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext, runtime: Runtime): Promise<HookDecision> {
	if (runtime.compactHookInFlight) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Observational memory: another compaction is already in progress; cancelling duplicate",
				"warning",
			);
		}
		return { result: { cancel: true }, outcome: { reason: "duplicate-suppressed" } };
	}

	runtime.compactHookInFlight = true;
	try {
		runtime.ensureConfig(ctx.cwd);
		const { preparation, branchEntries } = event;
		const { firstKeptEntryId, tokensBefore } = preparation;
		const entries = branchEntries as Entry[];
		const projection = buildCompactionProjection(
			entries,
			firstKeptEntryId,
			{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
		);
		const authority = compactionAuthority(entries, firstKeptEntryId, projection);
		if (authority.owner === "host") {
			return {
				result: undefined,
				outcome: { reason: "host-owned", authorityReason: authority.reason, tokensBefore, firstKeptEntryId },
			};
		}

		const rendered = renderSummarySections(projection.reflections, projection.observations);
		if (rendered.text.length === 0) {
			return {
				result: undefined,
				outcome: {
					reason: "empty-summary",
					tokensBefore,
					firstKeptEntryId,
					observationCount: projection.observations.length,
					reflectionCount: projection.reflections.length,
				},
			};
		}

		return {
			result: {
				compaction: {
					summary: rendered.text,
					firstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			},
			outcome: {
				reason: "rendered",
				fullFold: projection.fullFold,
				tokensBefore,
				firstKeptEntryId,
				observationCount: projection.observations.length,
				reflectionCount: projection.reflections.length,
				size: rendered.size,
				sections: rendered.sections,
			},
		};
	} finally {
		runtime.compactHookInFlight = false;
	}
}
