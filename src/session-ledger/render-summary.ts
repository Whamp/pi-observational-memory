import { estimateStringTokens } from "../tokens.js";
import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

/** Size of rendered compaction summary text, in exact characters and estimated tokens. */
export type SummarySize = { chars: number; estimatedTokens: number };

/**
 * Rendered compaction summary: the full text, its size, and each section's size.
 * Section sizes exclude the blank lines that join the parts, so they sum below the total.
 */
export type RenderedSummary = {
	text: string;
	size: SummarySize;
	sections: {
		instructions: SummarySize;
		reflections: SummarySize;
		observations: SummarySize;
	};
};

/** Measures compaction summary size: exact characters and the ceil(chars / 4) token estimate used for pool and context budgets. */
export function measureRenderedText(text: string): SummarySize {
	return { chars: text.length, estimatedTokens: estimateStringTokens(text) };
}

export function renderSummarySections(reflections: Reflection[], observations: Observation[]): RenderedSummary {
	const hasMemory = reflections.length > 0 || observations.length > 0;
	const instructions = hasMemory ? CONTEXT_USAGE_INSTRUCTIONS : "";
	const reflectionsBlock = reflections.length > 0
		? `## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`
		: "";
	const observationsBlock = observations.length > 0
		? `## Observations\n${observations.map(observationToSummaryLine).join("\n")}`
		: "";
	const text = [instructions, reflectionsBlock, observationsBlock].filter((part) => part !== "").join("\n\n");

	return {
		text,
		size: measureRenderedText(text),
		sections: {
			instructions: measureRenderedText(instructions),
			reflections: measureRenderedText(reflectionsBlock),
			observations: measureRenderedText(observationsBlock),
		},
	};
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	return renderSummarySections(reflections, observations).text;
}
