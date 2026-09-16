import * as fc from "fast-check";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	RELEVANCE_VALUES,
	type Entry,
	type Observation,
	type Reflection,
	type Relevance,
} from "../../src/session-ledger/index.js";

export const PROPERTY_RUNS = 300;
export const PROPERTY_OPTIONS = { numRuns: PROPERTY_RUNS };

const HEX_CHARS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"] as const;
const SOURCE_TYPES = ["message", "custom_message", "branch_summary"] as const;

const randomMemoryIdArb = fc
	.array(fc.constantFrom(...HEX_CHARS), { minLength: 12, maxLength: 12 })
	.map((chars) => chars.join(""));

export const memoryIdArb: fc.Arbitrary<string> = fc.oneof(
	fc.constant("000000000000"),
	fc.constant("ffffffffffff"),
	fc.constant("0123456789ab"),
	randomMemoryIdArb,
);

export const entryIdArb: fc.Arbitrary<string> = fc.oneof(
	fc.constant("entry-0"),
	fc.constant("entry-ffffffffffffffff"),
	fc.tuple(fc.constantFrom("entry", "source", "compaction"), fc.stringMatching(/^[a-f0-9]{1,16}$/))
		.map(([prefix, suffix]) => `${prefix}-${suffix}`),
);

const trimmedSingleLineArb = fc
	.string({ minLength: 1, maxLength: 512 })
	.map((text) => text.replace(/\r|\n/g, " ").trim())
	.filter((text) => text.length > 0);

export const nonEmptyTextArb: fc.Arbitrary<string> = fc.oneof(
	trimmedSingleLineArb,
	fc.constant(" ".repeat(32)),
	fc.constant("emoji 🚀 unicode café 漢字"),
	fc.constant("first line\nsecond line\nthird line"),
	fc.string({ minLength: 128, maxLength: 1_024 }),
).map((text) => text || "text");

export const singleLineTextArb: fc.Arbitrary<string> = fc.oneof(
	trimmedSingleLineArb,
	fc.constant("emoji 🚀 unicode café 漢字"),
	fc.string({ minLength: 128, maxLength: 1_024 })
		.map((text) => text.replace(/\r|\n/g, " ").trim())
		.filter((text) => text.length > 0),
);

export const timestampArb: fc.Arbitrary<string> = fc.oneof(
	fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toISOString()),
	fc.constant("not-a-date"),
	fc.constant("9999-99-99T99:99:99.999Z"),
	fc.constant("1970-01-01T00:00:00.000Z"),
	fc.constant("9999-12-31T23:59:59.999Z"),
);

export const tokenCountArb: fc.Arbitrary<number> = fc.oneof(
	fc.constant(0),
	fc.constant(1),
	fc.constant(10_000),
	fc.constant(50_000),
	fc.integer({ min: 0, max: 100_000 }),
);
export const relevanceArb: fc.Arbitrary<Relevance> = fc.constantFrom(...RELEVANCE_VALUES);

export function sourceEntry(id: string, index = 0, type: typeof SOURCE_TYPES[number] = SOURCE_TYPES[index % SOURCE_TYPES.length]): Entry {
	if (type === "message") {
		return {
			type,
			id,
			timestamp: "2026-05-02T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: `source ${id}` }] },
		};
	}
	if (type === "custom_message") {
		return {
			type,
			id,
			timestamp: "2026-05-02T10:00:00.000Z",
			content: `source ${id}`,
		};
	}
	return {
		type,
		id,
		timestamp: "2026-05-02T10:00:00.000Z",
		summary: `source ${id}`,
	};
}

export function observationArb(sourceIds: readonly string[] = ["source-1"]): fc.Arbitrary<Observation> {
	const sourceIdArb = fc.constantFrom(...sourceIds);
	return fc.record({
		id: memoryIdArb,
		content: nonEmptyTextArb,
		timestamp: timestampArb,
		relevance: relevanceArb,
		sourceEntryIds: fc.uniqueArray(sourceIdArb, { minLength: 1, maxLength: Math.max(1, Math.min(5, sourceIds.length)) }),
		tokenCount: tokenCountArb,
	});
}

export function reflectionArb(observationIds: readonly string[] = ["000000000000"]): fc.Arbitrary<Reflection> {
	const observationIdArb = fc.constantFrom(...observationIds);
	return fc.record({
		id: memoryIdArb,
		content: singleLineTextArb,
		supportingObservationIds: fc.array(observationIdArb, { minLength: 1, maxLength: Math.max(1, Math.min(10, observationIds.length * 3)) }),
		tokenCount: tokenCountArb,
	});
}

export function observationsEntry(id: string, observations: Observation[], coversUpToId: string): Entry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_RECORDED,
		data: { observations, coversUpToId },
	};
}

export function reflectionsEntry(id: string, reflections: Reflection[], coversUpToId: string): Entry {
	return {
		type: "custom",
		id,
		customType: OM_REFLECTIONS_RECORDED,
		data: { reflections, coversUpToId },
	};
}

export function dropsEntry(id: string, observationIds: string[], coversUpToId: string): Entry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_DROPPED,
		data: { observationIds, coversUpToId },
	};
}

export type LedgerScenario = {
	sourceEntries: Entry[];
	observations: Observation[];
	reflections: Reflection[];
	droppedIds: string[];
	entries: Entry[];
	coverageId: string;
};

export const ledgerScenarioArb: fc.Arbitrary<LedgerScenario> = fc
	.uniqueArray(entryIdArb, { minLength: 1, maxLength: 12 })
	.chain((sourceIds) => {
		const sourceEntries = sourceIds.map((id, index) => sourceEntry(id, index));
		const coverageId = sourceIds[sourceIds.length - 1];
		return fc
			.uniqueArray(observationArb(sourceIds), { minLength: 0, maxLength: 16, selector: (observation) => observation.id })
			.chain((observations) => {
				const observationIds = observations.map((observation) => observation.id);
				const reflectionsArb = observationIds.length === 0
					? fc.constant<Reflection[]>([])
					: fc.uniqueArray(reflectionArb(observationIds), { minLength: 0, maxLength: 12, selector: (reflection) => reflection.id });
				const droppedIdsArb = observationIds.length === 0
					? fc.constant<string[]>([])
					: fc.uniqueArray(fc.constantFrom(...observationIds), { minLength: 0, maxLength: observationIds.length });
				return fc.record({ reflections: reflectionsArb, droppedIds: droppedIdsArb }).map(({ reflections, droppedIds }) => {
					const entries = [...sourceEntries];
					if (observations.length > 0) entries.push(observationsEntry("ledger-observations", observations, coverageId));
					if (reflections.length > 0) entries.push(reflectionsEntry("ledger-reflections", reflections, coverageId));
					if (droppedIds.length > 0) entries.push(dropsEntry("ledger-drops", droppedIds, coverageId));
					return { sourceEntries, observations, reflections, droppedIds, entries, coverageId };
				});
			});
	});

export function idsOf<T extends { id: string }>(values: readonly T[]): string[] {
	return values.map((value) => value.id);
}

export function sorted(values: Iterable<string>): string[] {
	return Array.from(values).sort();
}
