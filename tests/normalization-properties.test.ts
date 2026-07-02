import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { normalizeSourceEntryIds } from "../src/agents/observer/agent.js";
import { normalizeSupportingObservationIds } from "../src/agents/reflector/agent.js";
import { PROPERTY_OPTIONS, entryIdArb, memoryIdArb } from "./fixtures/property.js";

function expectedAllowedOrder(ids: readonly string[], allowedIds: readonly string[]): string[] {
	const requested = new Set(ids);
	return allowedIds.filter((id, index) => allowedIds.indexOf(id) === index && requested.has(id));
}

describe("normalization property invariants", () => {
	it("should dedupe valid source entry ids in allowed branch order", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(entryIdArb, { minLength: 1, maxLength: 8 }),
				fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 20 }),
				(allowedIds, rawIndexes) => {
					// Arrange
					const requestedIds = rawIndexes.map((index) => allowedIds[index % allowedIds.length]);

					// Act
					const normalized = normalizeSourceEntryIds(requestedIds, allowedIds);

					// Assert
					expect(normalized).toEqual(expectedAllowedOrder(requestedIds, allowedIds));
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("should reject the whole source-id proposal when any id is hallucinated", () => {
		fc.assert(
			fc.property(fc.uniqueArray(entryIdArb, { minLength: 1, maxLength: 8 }), fc.array(fc.nat({ max: 20 }), { minLength: 0, maxLength: 20 }), fc.string({ minLength: 1 }), (allowedIds, rawIndexes, rawInvalidId) => {
				// Arrange
				const invalidId = allowedIds.includes(rawInvalidId) ? `${rawInvalidId}-hallucinated` : rawInvalidId;
				const requestedIds = [
					...rawIndexes.map((index) => allowedIds[index % allowedIds.length]),
					invalidId,
					...rawIndexes.map((index) => allowedIds[index % allowedIds.length]),
				];

				// Act / Assert
				expect(normalizeSourceEntryIds(requestedIds, allowedIds)).toBeUndefined();
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should reject empty or missing source-id proposals", () => {
		fc.assert(
			fc.property(fc.uniqueArray(entryIdArb, { minLength: 1, maxLength: 8 }), (allowedIds) => {
				// Act / Assert
				expect(normalizeSourceEntryIds([], allowedIds)).toBeUndefined();
				expect(normalizeSourceEntryIds(undefined, allowedIds)).toBeUndefined();
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should dedupe valid supporting observation ids in active observation order", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(memoryIdArb, { minLength: 1, maxLength: 8 }),
				fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 20 }),
				(allowedIds, rawIndexes) => {
					// Arrange
					const requestedIds = rawIndexes.map((index) => allowedIds[index % allowedIds.length]);

					// Act
					const normalized = normalizeSupportingObservationIds(requestedIds, allowedIds);

					// Assert
					expect(normalized).toEqual(expectedAllowedOrder(requestedIds, allowedIds));
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("should reject the whole supporting-id proposal when any id is hallucinated", () => {
		fc.assert(
			fc.property(fc.uniqueArray(memoryIdArb, { minLength: 1, maxLength: 8 }), fc.array(fc.nat({ max: 20 }), { minLength: 0, maxLength: 20 }), fc.string({ minLength: 1 }), (allowedIds, rawIndexes, rawInvalidId) => {
				// Arrange
				const invalidId = allowedIds.includes(rawInvalidId) ? `${rawInvalidId}-hallucinated` : rawInvalidId;
				const requestedIds = [
					...rawIndexes.map((index) => allowedIds[index % allowedIds.length]),
					invalidId,
					...rawIndexes.map((index) => allowedIds[index % allowedIds.length]),
				];

				// Act / Assert
				expect(normalizeSupportingObservationIds(requestedIds, allowedIds)).toBeUndefined();
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should reject empty or missing supporting-id proposals", () => {
		fc.assert(
			fc.property(fc.uniqueArray(memoryIdArb, { minLength: 1, maxLength: 8 }), (allowedIds) => {
				// Act / Assert
				expect(normalizeSupportingObservationIds([], allowedIds)).toBeUndefined();
				expect(normalizeSupportingObservationIds(undefined, allowedIds)).toBeUndefined();
			}),
			PROPERTY_OPTIONS,
		);
	});
});
