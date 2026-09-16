import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { hashId } from "../src/ids.js";
import {
	renderRecallSourceEntries,
	serializeSourceAddressedBranchEntries,
} from "../src/serialize.js";
import { estimateEntryTokens, estimateStringTokens } from "../src/tokens.js";
import { PROPERTY_OPTIONS, entryIdArb, nonEmptyTextArb, sourceEntry } from "./fixtures/property.js";

describe("serialization and token property invariants", () => {
	it("should hash arbitrary content into stable 12-character memory ids", () => {
		fc.assert(
			fc.property(fc.string(), (content) => {
				// Act
				const once = hashId(content);
				const twice = hashId(content);

				// Assert
				expect(once).toBe(twice);
				expect(once).toMatch(/^[a-f0-9]{12}$/);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should make string token estimates monotonic with string length", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (a, b) => {
				// Arrange
				const shorter = a.length <= b.length ? a : b;
				const longer = a.length <= b.length ? b : a;

				// Act / Assert
				expect(estimateStringTokens(shorter)).toBeLessThanOrEqual(estimateStringTokens(longer));
				expect(estimateStringTokens(a)).toBe(Math.ceil(a.length / 4));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should sum only text blocks for custom-message token estimates", () => {
		fc.assert(
			fc.property(fc.array(fc.oneof(
				fc.record({ type: fc.constant("text"), text: fc.string() }),
				fc.record({ type: fc.constant("thinking"), thinking: fc.string() }),
				fc.record({ type: fc.constant("image"), url: fc.string() }),
			), { maxLength: 20 }), (content) => {
				// Arrange
				const expected = content.reduce((sum, block) => block.type === "text" ? sum + estimateStringTokens(block.text) : sum, 0);

				// Act
				const tokens = estimateEntryTokens({ type: "custom_message", content });

				// Assert
				expect(tokens).toBe(expected);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should source-address exactly renderable source entries with ids", () => {
		fc.assert(
			fc.property(fc.uniqueArray(entryIdArb, { minLength: 1, maxLength: 8 }), (ids) => {
				// Arrange
				const entries = [
					...ids.map((id, index) => sourceEntry(id, index)),
					{ type: "custom", id: "memory-entry", customType: "om.unknown", data: {} },
					{ type: "message", timestamp: "2026-05-02T10:00:00.000Z" },
				];

				// Act
				const serialized = serializeSourceAddressedBranchEntries(entries);

				// Assert
				expect(serialized.sourceEntryIds).toEqual(ids);
				for (const id of ids) expect(serialized.text).toContain(`[Source entry id: ${id}]`);
				expect(serialized.text).not.toContain("memory-entry");
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("should render recall source entries only for source-like branch entries", () => {
		fc.assert(
			fc.property(entryIdArb, nonEmptyTextArb, (id, summary) => {
				// Arrange
				const entries = [
					sourceEntry(id, 0),
					{ type: "branch_summary", id: `${id}-summary`, timestamp: "2026-05-02T10:00:00.000Z", summary },
					{ type: "custom", id: `${id}-memory`, customType: "om.observations.recorded", data: {} },
				];

				// Act
				const rendered = renderRecallSourceEntries(entries);

				// Assert
				expect(rendered).toContain("[User @");
				expect(rendered).toContain(summary);
				expect(rendered).not.toContain(`${id}-memory`);
			}),
			PROPERTY_OPTIONS,
		);
	});
});
