# How it works

This is the V3 technical reference for `pi-observational-memory`.

V3 is ledger-centered: memory state is reconstructed by folding V3 ledger entries on the current branch. Covered compaction is model-free and renders a projection of that ledger. When Observation Coverage does not reach the Pruned Source Boundary, the extension delegates so Pi can summarize uncovered source.

## Runtime entry points

`src/index.ts` registers one shared runtime and these Pi surfaces:

| Surface | Purpose |
|---|---|
| `turn_end` observer trigger | Maybe run the observer in the background. |
| `turn_end` reflect/drop trigger | Maybe run the due reflector, then run dropper maintenance only after same-run successful reflection. |
| `agent_end` compaction trigger | Maybe call `ctx.compact()` when effective `compactionTrigger` is `agentEnd`, Pi is idle, and raw/source tokens are over `compactAfterTokens`. |
| `session_before_compact` hook | Decide Compaction Authority; render a deterministic V3 summary when covered or delegate when uncovered. |
| `/om:status` | Show ledger counts, drift, progress clocks, and worker state. |
| `/om:view` | Show visible or full memory content and attempt to copy the rendered memory text. |
| `recall` tool | Recover source evidence for a memory id. |

## Lifecycle overview

```mermaid
flowchart TD
    TE[turn_end]
    AE[agent_end]
    SBC[session_before_compact]

    ObsDue{raw tokens since Observation Coverage<br/>≥ observeAfterTokens?}
    Observer[Observer model call<br/>Recorded, Empty, or Failed]

    ReflectDropDue{observer not due<br/>and reflection/drop clock due?}
    BothDue{both due?}
    ReflectorOnly{reflector due only?}
    Reflector[Reflector model call<br/>append om.reflections.recorded]
    Dropper[Dropper model call<br/>append om.observations.dropped]

    TriggerMode{effective compactionTrigger<br/>agentEnd?}
    CompactDue{raw tokens since compaction<br/>≥ compactAfterTokens<br/>and idle?}
    CompactCall[ctx.compact]
    Native[Pi native/manual compaction]

    Authority{Observation Coverage reaches<br/>Pruned Source Boundary?}
    Fold[fold/project V3 ledger]
    Render[render deterministic summary]
    Details[return om.folded details]
    Delegate[return no override]
    PiSummary[Pi or later handler summarizes]

    TE --> ObsDue
    ObsDue -- yes --> Observer
    ObsDue -- no --> ReflectDropDue
    ReflectDropDue --> BothDue
    BothDue -- yes --> Reflector --> Dropper
    BothDue -- no --> ReflectorOnly
    ReflectorOnly -- yes --> Reflector
    ReflectorOnly -- no --> Dropper

    AE --> TriggerMode
    TriggerMode -- yes --> CompactDue
    CompactDue -- yes --> CompactCall
    CompactCall --> SBC
    Native --> SBC
    SBC --> Authority
    Authority -- yes --> Fold --> Render --> Details
    Authority -- no --> Delegate --> PiSummary
```

The observer has priority. Reflect/drop does not run on a turn where observer work is due.

## Source entries and progress

V3 raw-token progress counts only source entries:

- `message`
- `custom_message`
- `branch_summary`

Memory ledger entries and compaction entries do not add raw-token progress.

Every V3 ledger entry has `data.coversUpToId`. That field is a progress and projection watermark. Worker clocks count raw/source tokens after the latest valid watermark for that worker's ledger type:

| Worker/trigger | Progress source |
|---|---|
| Observer | greatest valid Recorded `om.observations.recorded` or Empty `om.observer.completed` source boundary |
| Reflector | latest `om.reflections.recorded.data.coversUpToId` |
| Dropper | latest `om.observations.dropped.data.coversUpToId` |
| Auto-compaction | latest compaction boundary |

The watermark is also used to decide whether a memory ledger entry belongs to a bounded projection. It is not provenance. Provenance lives in `sourceEntryIds` and `supportingObservationIds`.

## Ledger data shapes

### Empty observer completion

```ts
customType: "om.observer.completed"
data: {
  outcome: "empty";
  coversUpToId: string;
}
```

This marker records a trustworthy Empty outcome. It advances Observation Coverage but creates no observations and does not advance reflection or drop coverage.

### Observations recorded

```ts
customType: "om.observations.recorded"
data: {
  observations: Observation[];
  coversUpToId: string;
}
```

Each observation:

```ts
type Observation = {
  id: string;
  content: string;
  timestamp: string;
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];
  tokenCount: number;
}
```

The builder rejects empty observation arrays, so no empty progress entries are written.

### Reflections recorded

```ts
customType: "om.reflections.recorded"
data: {
  reflections: Reflection[];
  coversUpToId: string;
}
```

Each reflection:

```ts
type Reflection = {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
}
```

The reflector must cite valid active observation ids.

### Observations dropped

```ts
customType: "om.observations.dropped"
data: {
  observationIds: string[];
  coversUpToId: string;
}
```

Drops are tombstones. They remove ids from active observations but do not delete ledger history.

### Folded compaction details

```ts
details: {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}
```

These details are what later visible projections read. The ledger remains the source of truth.

## Observer flow

The observer trigger runs on `turn_end`.

1. Load config if needed.
2. Skip if `passive` is true.
3. Skip if observer work is already in flight.
4. Count raw/source tokens since latest Observation Coverage.
5. Skip if below `observeAfterTokens`.
6. Select and serialize source entries after the latest coverage marker.
7. Resolve the memory model and run `runObserver()` in a background task.
8. Validate source ids, compute deterministic ids, and classify the result.
9. If at least one observation is accepted, append `om.observations.recorded` and classify the run as Recorded.
10. If the observer explicitly reports an empty list with no rejected proposals, append `om.observer.completed` and classify the run as Empty.
11. If every proposal is rejected or no structured outcome is reported, append no coverage marker and classify the run as Failed.

Recorded and Empty advance Observation Coverage. Failed records an operational error, warns the user, and leaves the source eligible for another observer run.

## Reflect/drop flow

Reflect/drop also runs on `turn_end`, but only when the observer is not due.

1. Load config if needed.
2. Skip if `passive` is true.
3. Skip if observer or reflect/drop work is already in flight.
4. Skip if observer progress has reached `observeAfterTokens`.
5. Check the reflector raw-token clock against `reflectAfterTokens`.
6. Resolve the model only for stages that are ready to run.
7. Fold current ledger state.
8. If reflector is due and observation coverage exists, run the reflector. Each active observation line is annotated with current reflection coverage (`none`, `partial`, or `strong`) so the reflector can review uncovered durable facts without treating coverage as a quota.
9. Append non-empty `om.reflections.recorded` with `coversUpToId` set to the latest observation coverage marker. Support ids are downstream dropper coverage evidence and should include all and only observations whose durable meaning is preserved with equivalent fidelity.
10. Only after that same-run non-empty reflection append, check whether the folded active observation pool is over `observationsPoolTargetTokens`.
11. If over target, run the dropper with same-turn reflections available. It computes a maximum drop count from tokens over target converted to an approximate observation count and annotates active observations with reflection coverage tiers (`none`, `partial`, `strong`) for model judgment.
12. Append non-empty `om.observations.dropped` with `coversUpToId` set to the earlier branch position of latest observation coverage and same-run reflection coverage.

Reflector no-output and reflector failure skip same-turn dropper. Dropper failure does not roll back already-appended reflections.

## Auto-compaction trigger

The proactive extension trigger runs on `agent_end` only when the effective `compactionTrigger` is `agentEnd`.

Effective trigger policy:

- `native`: never call extension `ctx.compact()` proactively.
- `agentEnd`: use the legacy `agent_end` threshold trigger.
- `auto`: use `native` in `print` and `json`; use `agentEnd` in `tui`, `rpc`, and unknown interactive modes.

When the effective trigger is `agentEnd`, it skips when:

- `passive` is true;
- compaction is already in flight;
- the agent end event is a retryable error;
- raw/source tokens since last compaction are below `compactAfterTokens`;
- Pi is not idle after the deferred check;
- the threshold is no longer met after the deferred check.

When all checks pass, it calls `ctx.compact()`.

When the effective trigger is `native`, `compactAfterTokens` is ignored and Pi's own top-level compaction settings decide timing. Pi native and manual compactions still run the V3 authority check. The extension customizes covered compactions and delegates uncovered compactions.

This trigger does not wait for observer, reflector, or dropper promises. That is intentional: background memory work should never make compaction feel stuck.

## Compaction hook

The compaction hook runs on `session_before_compact` and is the critical V3 latency path.

1. Guard against duplicate concurrent compaction hooks.
2. Load config if needed.
3. Resolve the Pruned Source Boundary: the final source entry newly removed before `firstKeptEntryId`, after the previous compaction boundary.
4. Resolve the greatest valid source-backed Observation Coverage from Recorded and explicit Empty outcomes.
5. Record the content-free authority decision in debug logs when enabled.
6. If coverage reaches the prune boundary, build and render the deterministic projection and return `om.folded` details.
7. Otherwise return no override and no cancellation so Pi or a later handler can summarize the source.

The hook never runs observer, reflector, or dropper work and never waits for worker promises. The covered OM path calls no model. The delegated path may cause Pi to call its native summarization model after the hook returns.

If another compaction hook is already in flight, the duplicate call returns `{ cancel: true }`.

## Projections

V3 uses projection helpers so commands, compaction, and recall do not each invent their own truth.

### Full projection

Full projection folds valid V3 observations, reflections, and drops from branch root through the requested boundary. Memory entries are included by resolving their `data.coversUpToId` marker against the boundary, not by the physical position of the `om.*` custom entry. Old V2 entries/details, invalid V3-shaped entries, and dangling coverage markers are ignored.

### Visible projection

Visible projection without a boundary inspects the latest compaction entry. Valid V3 `om.folded` details become visible structured memory. If the latest compaction is native or has non-OM details, visible structured observational memory is empty; the projection never searches backward to an older OM compaction. Full ledger memory remains available.

### Compaction projection

When compaction runs, the projection helper decides whether this compaction is a full fold. It first builds the normal compaction projection: observations whose `coversUpToId` reaches `firstKeptEntryId`, with reflection/drop effects held stable from the latest full-fold boundary. If there is no previous full-fold boundary, normal compaction includes observations only and excludes reflections/drops. It sums that projection's active observation `tokenCount`; if the total is at or above `observationsPoolMaxTokens`, it performs a full fold through `firstKeptEntryId`, applying observations, reflections, and drops by coverage marker. Otherwise, it keeps the normal projection.

### Diff projection

Diff projection compares visible memory with full memory. `/om:status` uses this to show recorded-vs-visible drift. `/om:status` also reports the visible observation pool separately from the folded active observation pool because compaction pressure and dropper maintenance intentionally use different projections and thresholds.

## Summary rendering

The renderer returns an empty string when there are no visible observations or reflections. Otherwise it starts with deterministic usage instructions that tell the agent how to treat the memory, how to handle conflicts, and when to use `recall` for exact source context. It then renders reflection and observation sections when those entries exist:

```md
These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.

## Reflections
[id] durable reflection

## Observations
[id] YYYY-MM-DD HH:MM [relevance] timestamped observation
```

The renderer is deterministic. It does not call a model and does not rewrite memory content.

## Commands

### `/om:status`

Shows:

- recorded/dropped/visible observation counts, with plain `+N` / `-N` visible-vs-full drift suffixes when drift exists;
- recorded/visible reflection counts, with a plain `+N` drift suffix when full memory has extra reflections;
- next observation/reflection/compaction token progress and drop coverage since the last successful drop;
- visible observation pool pressure against `observationsPoolMaxTokens` from the current compaction projection;
- active observation pool pressure against `observationsPoolTargetTokens` from folded active observations;
- dropper state explaining whether the active pool is under target or waiting for the next successful reflection;
- reflection pool token total;
- passive mode;
- worker in-flight flags;
- last observer and reflect/drop errors.

### `/om:view`

Default mode shows visible structured memory and attempts to copy the rendered memory text to the clipboard. Visible memory is empty before the first V3 compaction and after a latest native compaction because no current `om.folded` details are in active context. Use `/om:view full` to inspect durable branch memory in either case.

Clipboard copy uses platform clipboard commands (`pbcopy`, `clip`, `wl-copy`, `xclip`, `xsel`, or `termux-clipboard-set`). If copying succeeds, Pi shows `Copied /om:view output to clipboard.` If copying fails, the command still prints the memory view and shows a warning. The clipboard text is only the rendered memory content; it does not include the success/failure line.

### `/om:view full`

Shows full V3 ledger truth at branch tip and attempts to copy the rendered memory text to the clipboard using the same success/failure behavior as default `/om:view`.

## Recall flow

The agent-facing `recall` tool accepts a 12-character lowercase hex id.

1. Validate id shape.
2. Read the current branch.
3. Index V3 observations, reflections, and drops from ledger history.
4. Match the id against observations and reflections.
5. For observations, mark status as `active` or `dropped`.
6. Resolve observation source entries from `sourceEntryIds`.
7. For reflections, resolve supporting observations and their sources.
8. Return exact evidence plus diagnostics for missing/non-source entries.

Recall ignores old V2 memory by construction because it indexes only V3 ledger entry types.

## Error and race handling

- Worker in-flight flags prevent duplicate observer or reflect/drop runs.
- Observer priority prevents reflect/drop from advancing while source text is due for observation.
- Explicit Empty observer outcomes append coverage metadata but no observation records; Failed outcomes append no coverage marker.
- Invalid source/support/drop ids are filtered or rejected by code.
- Background worker errors are recorded on runtime state and surfaced in `/om:status`.
- Compaction does not wait for background workers; it folds whatever ledger state is already present.
- Historical or invalid coverage markers are tolerated by progress helpers instead of throwing.

## V2 behavior

V3 does not use V2 state shapes. Old V2 custom memory entries, old V2 compaction details, and old V2 config keys are ignored. Existing old visible compaction text in a continued session may remain visible until a V3 compaction replaces it. The recommended upgrade path is to update settings and start a new clean session.

## Invariants

- The branch-local V3 ledger is the memory source of truth.
- The latest Pi compaction entry determines visible structured memory.
- Covered OM compaction is deterministic and model-free; uncovered compaction delegates to the host pipeline.
- Observer input is raw/source entries only.
- `coversUpToId` is a progress/projection watermark, not provenance.
- Kept observations and reflections are rendered without paraphrase.
- Dropped observations remain recallable from ledger history.
- Old V2 memory is ignored rather than migrated.
