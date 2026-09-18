import { describe, expect, it } from "vitest";

import { measureRenderedText, renderSummary, renderSummarySections } from "../src/session-ledger/index.js";
import { observation, reflection } from "./fixtures/session.js";

describe("session-ledger V3 summary rendering", () => {
	it("renders empty memory as an empty summary", () => {
		expect(renderSummary([], [])).toBe("");
	});

	it("keeps compacted-memory usage instructions", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User prefers source-backed memory." });

		const summary = renderSummary([ref], []);

		expect(summary).toContain("These are condensed memories from earlier in this session.");
		expect(summary).toContain("use the recall tool");
	});

	it("renders V3 reflections with ids", () => {
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "User prefers source-backed memory." });

		const summary = renderSummary([ref], []);

		expect(summary).toContain("## Reflections\n[eeeeeeeeeeee] User prefers source-backed memory.");
	});

	it("renders V3 observations with ids, timestamps, relevance, and content", () => {
		const obs = observation("aaaaaaaaaaaa", {
			content: "User confirmed recall should use exact source entry ids.",
			timestamp: "2026-05-02 10:30",
			relevance: "high",
		});

		const summary = renderSummary([], [obs]);

		expect(summary).toContain(
			"## Observations\n[aaaaaaaaaaaa] 2026-05-02 10:30 [high] User confirmed recall should use exact source entry ids.",
		);
	});

	it("measures exact characters and the ceil(chars / 4) token estimate", () => {
		expect(measureRenderedText("")).toEqual({ chars: 0, estimatedTokens: 0 });
		expect(measureRenderedText("abcd")).toEqual({ chars: 4, estimatedTokens: 1 });
		expect(measureRenderedText("abcde")).toEqual({ chars: 5, estimatedTokens: 2 });
	});

	it("reports the size of a summary holding both reflections and observations", () => {
		const rendered = renderSummarySections([reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], [observation("aaaaaaaaaaaa")]);

		expect(rendered.size).toEqual({ chars: 1046, estimatedTokens: 262 });
		expect(rendered.sections).toEqual({
			instructions: { chars: 900, estimatedTokens: 225 },
			reflections: { chars: 53, estimatedTokens: 14 },
			observations: { chars: 89, estimatedTokens: 23 },
		});
	});

	it("reports the size of a summary holding only observations", () => {
		const rendered = renderSummarySections([], [observation("aaaaaaaaaaaa")]);

		expect(rendered.size).toEqual({ chars: 991, estimatedTokens: 248 });
		expect(rendered.sections.reflections).toEqual({ chars: 0, estimatedTokens: 0 });
	});

	it("reports the size of a summary holding only reflections", () => {
		const rendered = renderSummarySections([reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], []);

		expect(rendered.size).toEqual({ chars: 955, estimatedTokens: 239 });
		expect(rendered.sections.observations).toEqual({ chars: 0, estimatedTokens: 0 });
	});

	it("counts the blank lines between parts in the total, so sections do not sum to it", () => {
		const rendered = renderSummarySections([reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], [observation("aaaaaaaaaaaa")]);
		const sectionChars = rendered.sections.instructions.chars
			+ rendered.sections.reflections.chars
			+ rendered.sections.observations.chars;

		expect(sectionChars).toBe(1042);
		expect(rendered.size.chars).toBe(1046);
	});

	it("returns the same text as renderSummary", () => {
		const refs = [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])];
		const obs = [observation("aaaaaaaaaaaa")];

		expect(renderSummarySections(refs, obs).text).toBe(renderSummary(refs, obs));
		expect(renderSummarySections(refs, []).text).toBe(renderSummary(refs, []));
		expect(renderSummarySections([], obs).text).toBe(renderSummary([], obs));
		expect(renderSummarySections([], []).text).toBe(renderSummary([], []));
	});

	it("keeps the usage instructions first, then reflections, then observations", () => {
		const rendered = renderSummarySections([reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], [observation("aaaaaaaaaaaa")]);

		expect(rendered.text.startsWith("These are condensed memories from earlier in this session.")).toBe(true);
		expect(rendered.text.indexOf("## Reflections")).toBeLessThan(rendered.text.indexOf("## Observations"));
	});

	it("reports zero sizes when empty memory renders an empty summary", () => {
		const rendered = renderSummarySections([], []);

		expect(rendered.text).toBe("");
		expect(rendered.size).toEqual({ chars: 0, estimatedTokens: 0 });
		expect(rendered.sections).toEqual({
			instructions: { chars: 0, estimatedTokens: 0 },
			reflections: { chars: 0, estimatedTokens: 0 },
			observations: { chars: 0, estimatedTokens: 0 },
		});
	});

	it("keeps raw provenance metadata out of the compact summary", () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["entry-user", "entry-tool"] });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

		const summary = renderSummary([ref], [obs]);

		expect(summary).not.toContain("sourceEntryIds");
		expect(summary).not.toContain("supportingObservationIds");
		expect(summary).not.toContain("entry-user");
		expect(summary).not.toContain("entry-tool");
		expect(summary).not.toContain("legacy");
		expect(summary).not.toContain("[object Object]");
	});
});
