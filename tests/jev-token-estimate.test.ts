import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { estimateJevTokens } from "../src/jev/token-estimate.js";
import { PROPERTY_OPTIONS } from "./fixtures/property.js";

describe("Jev token estimator", () => {
	it.each([
		["", 0],
		["   ", 0],
		["a", 1],
		["abcdef", 1],
		["abcdefg", 2],
		["1", 1],
		["12", 1],
		["1234", 2],
		["!", 1],
		["!!", 2],
		["hello, world!", 4],
		["hello-world", 3],
		["abc123", 3],
		["1234abc!", 4],
		["🚀", 2],
	])("estimates %j as %i tokens", (text, expected) => {
		expect(estimateJevTokens(text)).toBe(expected);
	});

	it("never estimates below the number of alphabetic runs", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 4_096 }), (text) => {
				// Arrange
				const alphaRuns = text.match(/[A-Za-z]+/g)?.length ?? 0;

				// Act / Assert: every alphabetic run costs at least one token.
				expect(estimateJevTokens(text)).toBeGreaterThanOrEqual(alphaRuns);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("is monotone under concatenation", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 2_048 }), fc.string({ maxLength: 2_048 }), (left, right) => {
				// Act / Assert: merging pieces can only shrink boundary runs, never below either part.
				const joined = estimateJevTokens(left + right);
				expect(joined).toBeGreaterThanOrEqual(estimateJevTokens(left));
				expect(joined).toBeGreaterThanOrEqual(estimateJevTokens(right));
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("stays above the split-word count for prose bodies", () => {
		fc.assert(
			fc.property(fc.array(fc.stringMatching(/^[a-z]{1,12}$/), { maxLength: 64 }), (words) => {
				// Arrange: every whitespace-delimited token carries at least one alphabetic run.
				const body = `{"state":{"context":"${words.join(" ")}"}}`;
				const wordCount = body.split(/\s+/).filter((word) => word.length > 0).length;

				// Act / Assert
				expect(estimateJevTokens(body)).toBeGreaterThanOrEqual(wordCount);
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("overcounts a JSON-heavy dropper-shaped body against its split-word count", () => {
		// Arrange: a realistic serialized dropper state, punctuation-dense like the wire format.
		const state = {
			context: "Compaction is pruning durable memory for a TypeScript service.",
			reflections: [
				"[ref-0001] User prefers vitest; never add jest config",
				"[ref-0002] Postgres is the source of truth; Redis is a best-effort cache",
			],
			observations: Array.from({ length: 20 }, (_, index) => ({
				id: `obs-${index}`,
				content: `The rate limiter budget is 100 req/min per tenant and deploys require green tests before staging (ticket #${10 + index}).`,
				relevance: "medium",
				coverage: "partial",
				ageMinutes: 10 * (index + 1),
			})),
		};
		const body = JSON.stringify({
			state,
			questions: {
				drop_obs_3: { type: "noul", instructions: "Observation `obs-3` can be dropped from active durable memory." },
			},
		});

		// Act / Assert: the estimator must not undercount what the API will really bill.
		const wordCount = body.split(/\s+/).filter((word) => word.length > 0).length;
		expect(estimateJevTokens(body)).toBeGreaterThanOrEqual(wordCount);
	});
});
