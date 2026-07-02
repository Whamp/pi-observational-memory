import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	COMPACTION_TRIGGER_VALUES,
	DEFAULTS,
	THINKING_LEVEL_VALUES,
	readEnvConfig,
	resolveEffectiveCompactionTrigger,
	resolveStageModel,
	type Config,
	type ConfiguredModel,
	type StageName,
} from "../src/config.js";
import {
	MAX_RECORD_CONTENT_CHARS,
	truncateRecordContent,
} from "../src/serialize.js";
import {
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	isMemoryDetails,
	isObservation,
	isObservationsDroppedData,
	isObservationsRecordedData,
	isReflection,
	isReflectionsRecordedData,
} from "../src/session-ledger/index.js";
import { OM_FOLDED } from "../src/session-ledger/types.js";
import {
	PROPERTY_OPTIONS,
	entryIdArb,
	memoryIdArb,
	observationArb,
	reflectionArb,
} from "./fixtures/property.js";

const modeArb = fc.option(fc.oneof(fc.constantFrom("print", "json", "tui", "rpc"), fc.string()), { nil: undefined });
const modelArb: fc.Arbitrary<ConfiguredModel> = fc.record({
	provider: fc.constantFrom("openrouter", "anthropic", "google"),
	id: fc.string({ minLength: 1 }),
	thinking: fc.option(fc.constantFrom("off", "minimal", "low", "medium", "high", "xhigh"), { nil: undefined }),
});
const stageNameArb: fc.Arbitrary<StageName> = fc.constantFrom("observer", "reflector", "dropper");
const thinkingArb = fc.option(fc.constantFrom(...THINKING_LEVEL_VALUES), { nil: undefined });

function compactEnvSpelling(value: string, uppercase: boolean, pad: boolean): string {
	const spelled = uppercase ? value.toUpperCase() : value;
	return pad ? `  ${spelled}\t` : spelled;
}

function configWithModelFields(args: {
	model?: ConfiguredModel;
	observerModel?: ConfiguredModel;
	reflectorModel?: ConfiguredModel;
	dropperModel?: ConfiguredModel;
	observerThinking?: ConfiguredModel["thinking"];
	reflectorThinking?: ConfiguredModel["thinking"];
	dropperThinking?: ConfiguredModel["thinking"];
}): Config {
	return {
		...DEFAULTS,
		model: args.model,
		observer: args.observerModel || args.observerThinking ? { model: args.observerModel, thinking: args.observerThinking } : undefined,
		reflector: args.reflectorModel || args.reflectorThinking ? { model: args.reflectorModel, thinking: args.reflectorThinking } : undefined,
		dropper: args.dropperModel || args.dropperThinking ? { model: args.dropperModel, thinking: args.dropperThinking } : undefined,
	};
}

describe("config, type, and serialization property invariants", () => {
	it("should resolve effective compaction trigger deterministically for all modes", () => {
		fc.assert(
			fc.property(fc.constantFrom(...COMPACTION_TRIGGER_VALUES), modeArb, (compactionTrigger, mode) => {
				// Act
				const effective = resolveEffectiveCompactionTrigger({ compactionTrigger }, mode);

				// Assert
				if (compactionTrigger === "native") expect(effective).toBe("native");
				else if (compactionTrigger === "agentEnd") expect(effective).toBe("agentEnd");
				else expect(effective).toBe(mode === "print" || mode === "json" ? "native" : "agentEnd");
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should resolve stage model inheritance without inventing configured models", () => {
		fc.assert(
			fc.property(
				fc.option(modelArb, { nil: undefined }),
				fc.option(modelArb, { nil: undefined }),
				fc.option(modelArb, { nil: undefined }),
				fc.option(modelArb, { nil: undefined }),
				stageNameArb,
				(model, observerModel, reflectorModel, dropperModel, stage) => {
					// Arrange
					const config = configWithModelFields({ model, observerModel, reflectorModel, dropperModel });

					// Act
					const resolved = resolveStageModel(config, stage);

					// Assert
					if (stage === "observer") expect(resolved.model).toBe(observerModel ?? model);
					if (stage === "reflector") expect(resolved.model).toBe(reflectorModel ?? model);
					if (stage === "dropper") expect(resolved.model).toBe(dropperModel ?? reflectorModel ?? model);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("should resolve stage thinking inheritance across shared, stage, and dropper reflector fallback", () => {
		fc.assert(
			fc.property(
				fc.option(modelArb, { nil: undefined }),
				fc.option(modelArb, { nil: undefined }),
				fc.option(modelArb, { nil: undefined }),
				fc.option(modelArb, { nil: undefined }),
				thinkingArb,
				thinkingArb,
				thinkingArb,
				stageNameArb,
				(model, observerModel, reflectorModel, dropperModel, observerThinking, reflectorThinking, dropperThinking, stage) => {
					// Arrange
					const config = configWithModelFields({ model, observerModel, reflectorModel, dropperModel, observerThinking, reflectorThinking, dropperThinking });
					const sharedThinking = model?.thinking ?? "low";
					const expectedReflectorThinking = reflectorThinking ?? reflectorModel?.thinking ?? sharedThinking;

					// Act
					const resolved = resolveStageModel(config, stage);

					// Assert
					if (stage === "observer") expect(resolved.thinking).toBe(observerThinking ?? observerModel?.thinking ?? sharedThinking);
					if (stage === "reflector") expect(resolved.thinking).toBe(expectedReflectorThinking);
					if (stage === "dropper") expect(resolved.thinking).toBe(dropperThinking ?? dropperModel?.thinking ?? expectedReflectorThinking);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("should parse passive environment values case-insensitively with surrounding whitespace", () => {
		fc.assert(
			fc.property(fc.constantFrom("1", "true", "yes", "on"), fc.boolean(), fc.boolean(), (value, uppercase, pad) => {
				// Act / Assert
				expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: compactEnvSpelling(value, uppercase, pad) })).toEqual({ passive: true });
			}),
			PROPERTY_OPTIONS,
		);
		fc.assert(
			fc.property(fc.constantFrom("0", "false", "no", "off"), fc.boolean(), fc.boolean(), (value, uppercase, pad) => {
				// Act / Assert
				expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: compactEnvSpelling(value, uppercase, pad) })).toEqual({ passive: false });
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should accept generated valid observations and reject empty source evidence", () => {
		fc.assert(
			fc.property(observationArb(["source-1", "source-2"]), (observation) => {
				// Act / Assert
				expect(isObservation(observation)).toBe(true);
				expect(isObservation({ ...observation, sourceEntryIds: [] })).toBe(false);
				expect(isObservation({ ...observation, tokenCount: Number.POSITIVE_INFINITY })).toBe(false);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should accept generated valid reflections and reject multiline reflection content", () => {
		fc.assert(
			fc.property(reflectionArb(["000000000000", "111111111111"]), (reflection) => {
				// Act / Assert
				expect(isReflection(reflection)).toBe(true);
				expect(isReflection({ ...reflection, content: `${reflection.content}\nnext line` })).toBe(false);
				expect(isReflection({ ...reflection, supportingObservationIds: [] })).toBe(false);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should make V3 data builders produce values accepted by their corresponding guards", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(observationArb(["source-1", "source-2"]), { minLength: 1, maxLength: 5, selector: (observation) => observation.id }),
				fc.uniqueArray(reflectionArb(["000000000000", "111111111111"]), { minLength: 1, maxLength: 5, selector: (reflection) => reflection.id }),
				fc.uniqueArray(memoryIdArb, { minLength: 1, maxLength: 5 }),
				entryIdArb,
				(observations, reflections, droppedIds, coversUpToId) => {
					// Act
					const observationsData = buildObservationsRecordedData(observations, coversUpToId);
					const reflectionsData = buildReflectionsRecordedData(reflections, coversUpToId);
					const droppedData = buildObservationsDroppedData(droppedIds, coversUpToId);

					// Assert
					expect(isObservationsRecordedData(observationsData)).toBe(true);
					expect(isReflectionsRecordedData(reflectionsData)).toBe(true);
					expect(isObservationsDroppedData(droppedData)).toBe(true);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("should reject empty builder inputs instead of emitting empty ledger records", () => {
		fc.assert(
			fc.property(entryIdArb, (coversUpToId) => {
				// Act / Assert
				expect(buildObservationsRecordedData([], coversUpToId)).toBeUndefined();
				expect(buildReflectionsRecordedData([], coversUpToId)).toBeUndefined();
				expect(buildObservationsDroppedData([], coversUpToId)).toBeUndefined();
				expect(buildObservationsDroppedData(["000000000000"], "")).toBeUndefined();
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should accept memory details built from valid generated records", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(observationArb(["source-1", "source-2"]), { maxLength: 5, selector: (observation) => observation.id }),
				fc.uniqueArray(reflectionArb(["000000000000", "111111111111"]), { maxLength: 5, selector: (reflection) => reflection.id }),
				fc.boolean(),
				(observations, reflections, fullFold) => {
					// Act / Assert
					expect(isMemoryDetails({ type: OM_FOLDED, version: 1, fullFold, observations, reflections })).toBe(true);
					expect(isMemoryDetails({ type: OM_FOLDED, version: 2, fullFold, observations, reflections })).toBe(false);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("should leave short content unchanged", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: MAX_RECORD_CONTENT_CHARS }), (content) => {
				// Act / Assert
				expect(truncateRecordContent(content)).toBe(content);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should bound truncated long content and report the dropped character count", () => {
		fc.assert(
			fc.property(fc.string({ minLength: MAX_RECORD_CONTENT_CHARS + 1, maxLength: MAX_RECORD_CONTENT_CHARS + 500 }), (content) => {
				// Act
				const truncated = truncateRecordContent(content);

				// Assert
				expect(truncated.length).toBeLessThanOrEqual(MAX_RECORD_CONTENT_CHARS);
				const head = truncated.split(" … [truncated ")[0];
				expect(content.startsWith(head)).toBe(true);
				expect(truncated).toMatch(/ … \[truncated [1-9][0-9]* chars\]$/);
				const dropped = Number(truncated.match(/truncated ([0-9]+) chars/)?.[1]);
				expect(dropped).toBe(content.length - head.length);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should make record-content truncation idempotent", () => {
		fc.assert(
			fc.property(fc.string(), (content) => {
				// Act
				const once = truncateRecordContent(content);
				const twice = truncateRecordContent(once);

				// Assert
				expect(twice).toBe(once);
			}),
			PROPERTY_OPTIONS,
		);
	});
});
