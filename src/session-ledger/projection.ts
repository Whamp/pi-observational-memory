import {
	OM_FOLDED,
	isMemoryDetails,
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	type Entry,
	type MemoryDetails,
	type Observation,
	type ObservationsRecordedEntryData,
	type Reflection,
} from "./types.js";
import { findLastCompactionIndex, isSourceEntry } from "./progress.js";

export type Projection = {
	observations: Observation[];
	reflections: Reflection[];
};

export type ProjectionDiff = {
	observationsOnlyInFull: Observation[];
	reflectionsOnlyInFull: Reflection[];
	droppedOnlyInFull: Observation[];
};

export type CompactionProjectionConfig = {
	observationsPoolMaxTokens: number;
};

export type CompactionProjection = Projection & {
	fullFold: boolean;
	details: MemoryDetails;
};

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

type RecordedEntry = Entry & { data: ObservationsRecordedEntryData };

type ProjectionBoundary =
	| { kind: "entry"; entryId: string }
	| { kind: "tip" }
	| { kind: "none" };

type ProjectionFoldOptions = {
	observationsBoundary: ProjectionBoundary;
	reflectionsBoundary: ProjectionBoundary;
	dropsBoundary: ProjectionBoundary;
};

function entryIndexById(entries: Entry[]): Map<string, number> {
	const indexes = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) indexes.set(entries[i].id, i);
	return indexes;
}

function entryBoundary(entryId: string): ProjectionBoundary {
	return { kind: "entry", entryId };
}

function tipBoundary(): ProjectionBoundary {
	return { kind: "tip" };
}

function noneBoundary(): ProjectionBoundary {
	return { kind: "none" };
}

function boundaryIndex(entries: Entry[], indexes: Map<string, number>, boundary: ProjectionBoundary): number {
	if (boundary.kind === "tip") return entries.length - 1;
	if (boundary.kind === "none") return -1;
	return indexes.get(boundary.entryId) ?? -1;
}

function coverageIndex(entry: Entry & { data: { coversUpToId: string } }, indexes: Map<string, number>): number {
	return indexes.get(entry.data.coversUpToId) ?? -1;
}

function isAtOrBefore(index: number, boundaryIndex: number): boolean {
	return index >= 0 && boundaryIndex >= 0 && index <= boundaryIndex;
}

function isCoveredAtOrBefore(
	entry: Entry & { data: { coversUpToId: string } },
	indexes: Map<string, number>,
	boundaryIndex: number,
): boolean {
	return isAtOrBefore(coverageIndex(entry, indexes), boundaryIndex);
}

function foldProjection(entries: Entry[], options: ProjectionFoldOptions): Projection {
	const indexes = entryIndexById(entries);
	const observationsBoundary = boundaryIndex(entries, indexes, options.observationsBoundary);
	const reflectionsBoundary = boundaryIndex(entries, indexes, options.reflectionsBoundary);
	const dropsBoundary = boundaryIndex(entries, indexes, options.dropsBoundary);
	const observations: Observation[] = [];
	const reflections: Reflection[] = [];
	const observationsById = new Set<string>();
	const reflectionsById = new Set<string>();
	const droppedObservationIds = new Set<string>();

	for (const entry of entries) {
		if (isObservationsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, observationsBoundary)) {
			for (const observation of entry.data.observations) {
				if (observationsById.has(observation.id)) continue;
				observationsById.add(observation.id);
				observations.push(observation);
			}
			continue;
		}

		if (isReflectionsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, reflectionsBoundary)) {
			for (const reflection of entry.data.reflections) {
				if (reflectionsById.has(reflection.id)) continue;
				reflectionsById.add(reflection.id);
				reflections.push(reflection);
			}
			continue;
		}

		if (isObservationsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
			for (const observationId of entry.data.observationIds) droppedObservationIds.add(observationId);
		}
	}

	return {
		observations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
		reflections,
	};
}

function projectionFromMemoryDetails(details: MemoryDetails): Projection {
	return {
		observations: [...details.observations],
		reflections: [...details.reflections],
	};
}

function latestCompactionMemoryDetails(entries: Entry[]): MemoryDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		return isMemoryDetails(entry.details) ? entry.details : undefined;
	}
	return undefined;
}

export function fullProjection(entries: Entry[], upToEntryId?: string): Projection {
	const boundary = upToEntryId ? entryBoundary(upToEntryId) : tipBoundary();
	return foldProjection(entries, {
		observationsBoundary: boundary,
		reflectionsBoundary: boundary,
		dropsBoundary: boundary,
	});
}

export function visibleProjection(entries: Entry[], upToEntryId?: string): Projection {
	if (!upToEntryId) {
		const details = latestCompactionMemoryDetails(entries);
		return details ? projectionFromMemoryDetails(details) : { observations: [], reflections: [] };
	}

	return buildCompactionProjection(entries, upToEntryId, { observationsPoolMaxTokens: Number.POSITIVE_INFINITY });
}

export function latestFullFoldBoundaryId(entries: Entry[]): string | undefined {
	const indexes = entryIndexById(entries);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		if (!isMemoryDetails(entry.details)) continue;
		if (!entry.details.fullFold) continue;
		if (!entry.firstKeptEntryId) continue;
		if (!indexes.has(entry.firstKeptEntryId)) continue;
		return entry.firstKeptEntryId;
	}
	return undefined;
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

export function buildCompactionProjection(
	entries: Entry[],
	firstKeptEntryId: string,
	config: CompactionProjectionConfig,
): CompactionProjection {
	const fullFoldBoundaryId = latestFullFoldBoundaryId(entries);
	const maintenanceBoundary = fullFoldBoundaryId ? entryBoundary(fullFoldBoundaryId) : noneBoundary();
	const normalProjection = foldProjection(entries, {
		observationsBoundary: entryBoundary(firstKeptEntryId),
		reflectionsBoundary: maintenanceBoundary,
		dropsBoundary: maintenanceBoundary,
	});
	const observationTokens = normalProjection.observations.reduce(
		(total, observation) => total + observation.tokenCount,
		0,
	);
	const fullFold = observationTokens >= config.observationsPoolMaxTokens;
	const projection = fullFold
		? fullProjection(entries, firstKeptEntryId)
		: normalProjection;

	const details: MemoryDetails = {
		type: OM_FOLDED,
		version: 1,
		fullFold,
		observations: projection.observations,
		reflections: projection.reflections,
	};

	return {
		fullFold,
		observations: projection.observations,
		reflections: projection.reflections,
		details,
	};
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

export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
	const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id));
	const fullObservationIds = new Set(full.observations.map((observation) => observation.id));
	const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));

	return {
		observationsOnlyInFull: full.observations.filter((observation) => !visibleObservationIds.has(observation.id)),
		reflectionsOnlyInFull: full.reflections.filter((reflection) => !visibleReflectionIds.has(reflection.id)),
		droppedOnlyInFull: visible.observations.filter((observation) => !fullObservationIds.has(observation.id)),
	};
}
