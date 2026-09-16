import {
	entryIndexById,
	findLastCompactionIndex,
	isSourceEntry,
} from "./progress.js";
import type { CompactionProjection } from "./projection.js";
import {
	isObservationsRecordedEntry,
	type Entry,
	type ObservationsRecordedEntryData,
} from "./types.js";

type RecordedEntry = Entry & { data: ObservationsRecordedEntryData };

/** The participant allowed to provide one prepared compaction summary. */
export interface CompactionAuthorityDecision {
	owner: "observational-memory" | "host";
	reason:
		| "projected-coverage"
		| "uncovered"
		| "projection-incomplete"
		| "boundary-unresolved"
		| "no-pruned-source";
	coverageBoundaryId?: string;
	pruneBoundaryId?: string;
}

function latestPrunedSourceIndex(
	entries: Entry[],
	firstKeptIndex: number,
	indexes: Map<string, number>,
): number {
	const previousCompactionIndex = findLastCompactionIndex(entries);
	const previousFirstKeptIndex = previousCompactionIndex === -1
		? -1
		: indexes.get(entries[previousCompactionIndex].firstKeptEntryId ?? "") ?? -1;
	const pruneRangeStart = previousCompactionIndex === -1
		? 0
		: previousFirstKeptIndex >= 0
			? previousFirstKeptIndex
			: previousCompactionIndex + 1;

	for (let index = firstKeptIndex - 1; index >= pruneRangeStart; index--) {
		if (isSourceEntry(entries[index])) return index;
	}
	return -1;
}

function recordedBatchHasSourceIntegrity(
	entry: RecordedEntry,
	entryIndex: number,
	coveredIndex: number,
	entries: Entry[],
	indexes: Map<string, number>,
): boolean {
	if (!entry || coveredIndex >= entryIndex || !isSourceEntry(entries[coveredIndex])) return false;
	return entry.data.observations.every((observation) =>
		observation.sourceEntryIds.every((sourceEntryId) => {
			const sourceIndex = indexes.get(sourceEntryId);
			return sourceIndex !== undefined
				&& sourceIndex <= coveredIndex
				&& isSourceEntry(entries[sourceIndex]);
		}),
	);
}

function validatedRecordedEntry(entry: Entry): RecordedEntry | undefined {
	return isObservationsRecordedEntry(entry) ? entry : undefined;
}

/**
 * Grants compaction authority only when the exact replacement projection carries
 * a source-valid observation batch whose coverage reaches the last pruned source.
 * Durable Empty markers advance scheduling but never establish replacement
 * completeness by themselves.
 */
export function compactionAuthority(
	entries: Entry[],
	firstKeptEntryId: string,
	projection: CompactionProjection,
): CompactionAuthorityDecision {
	const indexes = entryIndexById(entries);
	const firstKeptIndex = indexes.get(firstKeptEntryId);
	if (firstKeptIndex === undefined) {
		return { owner: "host", reason: "boundary-unresolved" };
	}

	const pruneBoundaryIndex = latestPrunedSourceIndex(entries, firstKeptIndex, indexes);
	if (pruneBoundaryIndex === -1) {
		return { owner: "host", reason: "no-pruned-source" };
	}

	const projectedObservationIds = new Set(projection.observations.map((observation) => observation.id));
	let coverageBoundaryIndex = -1;
	let projectedCoverageBoundaryIndex = -1;
	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = validatedRecordedEntry(entries[entryIndex]);
		if (!entry) continue;
		const coveredIndex = indexes.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (!recordedBatchHasSourceIntegrity(entry, entryIndex, coveredIndex, entries, indexes)) continue;
		coverageBoundaryIndex = Math.max(coverageBoundaryIndex, coveredIndex);
		if (entry.data.observations.every((observation) => projectedObservationIds.has(observation.id))) {
			projectedCoverageBoundaryIndex = Math.max(projectedCoverageBoundaryIndex, coveredIndex);
		}
	}

	const coverageBoundaryId = entries[coverageBoundaryIndex]?.id;
	const pruneBoundaryId = entries[pruneBoundaryIndex].id;
	if (projectedCoverageBoundaryIndex >= pruneBoundaryIndex) {
		return {
			owner: "observational-memory",
			reason: "projected-coverage",
			coverageBoundaryId: entries[projectedCoverageBoundaryIndex]?.id,
			pruneBoundaryId,
		};
	}
	return {
		owner: "host",
		reason: coverageBoundaryIndex >= pruneBoundaryIndex ? "projection-incomplete" : "uncovered",
		coverageBoundaryId,
		pruneBoundaryId,
	};
}
