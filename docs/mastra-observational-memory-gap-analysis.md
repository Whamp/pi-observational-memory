# Mastra Observational Memory Gap Analysis

Date: 2026-06-29

Purpose: preserve research on how Mastra Observational Memory compares to `pi-observational-memory`, with emphasis on Mastra features that seem integral but are absent or partial here.

## Sources reviewed

Mastra docs/source:

- https://mastra.ai/en/docs/memory/observational-memory
- https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/docs/memory/observational-memory.mdx
- https://mastra.ai/en/docs/memory/message-history
- https://mastra.ai/en/docs/memory/working-memory
- https://mastra.ai/en/docs/memory/semantic-recall

Local project references:

- `README.md`
- `docs/concepts.md`
- `docs/how-it-works.md`
- `src/session-ledger/types.ts`
- `src/session-ledger/recall.ts`
- `src/session-ledger/projection.ts`
- `src/hooks/consolidation-trigger.ts`
- `src/hooks/compaction-hook.ts`
- `src/tools/recall-observation.ts`
- `src/agents/observer/agent.ts`
- `src/agents/observer/prompts.ts`
- `src/serialize.ts`
- `src/config.ts`

## What Mastra Observational Memory does

Mastra OM maintains an event-log style memory by observing conversation history, buffering observations, reflecting over them, and compacting message history. Its docs position OM as replacing both working memory and message history for long-running agents, with better accuracy/lower cost than semantic recall because it appends stable memory context instead of dynamically retrieving snippets.

Important Mastra OM defaults/features found in docs:

- Observer trigger around 30K message tokens.
- Reflector trigger around 40K observation tokens.
- Async buffering enabled by default:
  - `bufferTokens = 0.2`
  - `bufferActivation = 0.8`
  - `blockAfter = 1.2`
- Scope can be thread-local or resource-level.
- Recall can browse raw source messages behind observation ranges, and can optionally use vector search.
- Observer tracks continuity metadata such as current task and suggested response.

## Features Mastra has that Pi OM lacks or only partially covers

### 1. Current-task and suggested-response continuity

Mastra Observer tracks continuity hints such as current task and suggested response so the next agent can resume after raw history is compacted.

Pi OM currently records:

- `Observation`: `id`, `content`, `timestamp`, `relevance`, `sourceEntryIds`, `tokenCount`
- `Reflection`: `id`, `content`, `supportingObservationIds`, `tokenCount`

There is no first-class field for current task, next response, or resume state. The Observer prompt may encode completions or active work inside plain observations, but continuation state is not structured or rendered specially.

Local evidence:

- `src/session-ledger/types.ts`
- `src/agents/observer/prompts.ts`
- `src/session-ledger/render-summary.ts`

Assessment: this is the smallest high-value Mastra parity gap. It fits Pi OM's existing ledger/summary model without adding storage, vectors, or cross-thread scope.

### 2. Retrieval ranges and browsing recall

Mastra OM stores source ranges like `startId:endId`, exposes range metadata, and supports paging raw messages behind observation groups. Mastra recall can browse source history without vector search, and can optionally use semantic/vector search.

Pi OM recall is id-based only. It requires a known 12-character memory id and explicitly says it is not semantic search or transcript browsing.

Local evidence:

- `src/tools/recall-observation.ts`
- `src/session-ledger/recall.ts`
- `README.md` recall tool docs

Assessment: Pi has source-backed recall, but not Mastra's recall browser/search model. This is larger than continuation hints because it implies pagination UX, broader search semantics, and maybe access/scope decisions.

### 3. Thread/resource scope

Mastra has a memory model with threads and resources:

- thread scope: conversation-local
- resource scope: cross-thread memory for a user/entity

Pi OM is branch/session-local. It reads the current Pi session branch ledger via the session manager. There is no resource id, thread id, storage adapter, or cross-conversation memory model.

Local evidence:

- `src/hooks/consolidation-trigger.ts`
- `src/tools/recall-observation.ts`
- `src/runtime.ts`

Assessment: useful, but not a small OM parity patch. It changes the storage and privacy model.

### 4. Async buffering and early activation

Mastra's buffering pipeline can observe before hard thresholds and activate early on idle/provider-change events. It also has blocking fallback behavior when memory falls too far behind.

Pi OM runs consolidation on `agent_start` and `turn_end` when token thresholds say a stage is due. It has in-flight guards and background task tracking, but not Mastra-style pre-buffer/activate/block semantics.

Local evidence:

- `src/hooks/consolidation-trigger.ts`
- `src/runtime.ts`
- `src/config.ts`

Assessment: potentially useful for latency and prompt-cache friendliness, but more complex than continuation hints.

### 5. Attachment-aware observation and token accounting

Mastra OM has controls for observing attachments, MIME allowlists, file placeholders, and caller-supplied token estimates.

Pi OM serialization focuses on text and placeholders. Non-text and complex parts are represented minimally or omitted.

Local evidence:

- `src/serialize.ts`
- `src/tokens.ts`

Assessment: only important if Pi sessions rely heavily on screenshots, files, or multimodal inputs.

### 6. Temporal gap markers

Mastra can insert reminders when large time gaps occur between messages. This helps agents interpret stale context.

Pi OM stores timestamps on observations and source renderings, but does not synthesize explicit temporal gap entries.

Assessment: small but lower priority than continuation hints.

### 7. Thread title generation

Mastra can generate thread titles from observations.

Pi OM has no thread concept, so this is not directly applicable unless a cross-session/thread model is introduced.

## Adjacent Mastra memory features, not core OM parity

### Working memory

Mastra Working Memory is small structured state for persistent user/task facts. It can be Markdown-template based or schema-based:

- resource-scoped by default
- thread-scoped optionally
- templates use replace semantics
- schemas use merge semantics
- supports programmatic initial/update paths

Pi OM already stores durable facts as observations/reflections. Adding a second mutable working-memory store could create conflicting memory semantics unless there is a clear product need.

### Semantic recall

Mastra Semantic Recall is RAG/vector search over messages:

- disabled by default
- configurable `topK`, `messageRange`, scope, metadata filters
- requires vector store + embedder

Mastra docs frame OM as more accurate/lower cost than Semantic Recall for many long-session cases. Semantic recall should not be treated as mandatory OM parity.

### Message history

Mastra Message History is storage-backed thread/message persistence with pagination, filtering, cloning, and deletion. Pi uses the existing Pi session ledger instead of a storage adapter.

## Recommended next move

Add a small design candidate for **continuation hints**:

> Observation groups can carry optional `currentTask` and `suggestedResponse` metadata, rendered near the top of compaction memory.

Why this first:

- It maps to an explicit Mastra OM feature.
- It directly improves post-compaction continuity.
- It avoids storage adapters, vector indexes, thread/resource identity, and browsing UX.
- It can likely be implemented by extending the Observer output and rendered summary with a small ledger addition.

Skipped for now:

- vector recall
- cross-thread/resource scope
- generic working memory
- thread titles

Add those only when Pi needs cross-session search, user profiles, or a storage-backed memory product rather than OM parity.
