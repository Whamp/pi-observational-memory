# Diagnose the compaction trigger

Compaction has four stages, and each one counts tokens on a different basis. Read the stage that is failing rather than the number that looks wrong. Every claim below names the file that owns it.

## 1. Does compaction fire?

`registerCompactionTrigger` (`src/hooks/compaction-trigger.ts`) listens for Pi's `agent_settled` event, which arrives after retries, automatic compaction, and queued continuation finish.

Read `Next compaction:` in `/om:status`. It prints progress against the threshold.

- Progress is `rawTokensSinceLastCompaction(entries)`, a local estimate over the source entries after the last compaction boundary. It is not Pi's context usage.
- The threshold is `resolveCompactAfterTokens(config, contextWindow)` (`src/config.ts`). Calibrated mode, the default, uses `compactAfterTokens` at 81,000. Ratio mode uses `floor(contextWindow * compactAfterTokensRatio)`, 0.68 by default.
- Compaction never fires when `passive` is true, when `compactionTrigger` is `"native"`, or when `compactInFlight` is already set.
- After the threshold is crossed, the trigger defers through `setTimeout` and re-checks. It stands down when the agent became busy, and again when progress fell below the threshold because another compaction already ran. Both notify through the UI and clear `compactInFlight`.

When the trigger calls `ctx.compact()` and nothing reaches the compaction hook, Pi refused the compaction because it found no removable range. The refusal arrives in `onError`, and Pi shows any message other than `Compaction cancelled` as an error notification. Context pressure and compactable history are separate conditions, so a session can be large and still hold nothing Pi is willing to remove.

## 2. Who renders the summary?

`compactionAuthority` (`src/session-ledger/projection.ts`) picks the owner, and `src/hooks/compaction-hook.ts` writes one `compaction.hook_result` row per `session_before_compact` call. The row's `reason` is a closed set.

| reason | Meaning |
| --- | --- |
| `rendered` | This extension renders the summary. `size` and `sections` carry the measurement. |
| `host-owned` | Pi's own summarizer runs. `authorityReason` says why. |
| `duplicate-suppressed` | A compaction hook call is already in flight, so the hook returned `{ cancel: true }`. |
| `empty-summary` | Defensive. A granted projection always carries at least one observation today, so this row should not appear. |

The host reasons are `boundary-unresolved` (the retained boundary entry cannot be resolved on the branch), `no-pruned-source` (nothing was pruned before the boundary), `projection-incomplete`, and `uncovered` (no observations-recorded batch covers the boundary). Only the granted reason `projected-coverage` hands the summary to this extension.

## 3. Is the summary too large?

The rendered text replaces the compacted history, and Pi stores it verbatim.

- `/om:status` prints `Last compaction summary: ~N tokens (M chars)` from the newest stored compaction entry on the branch. Pi stores a summary for its own compactions too, so the line covers those.
- The `rendered` row carries `size` and per-section `sections`.
- Sizes are exact characters and `ceil(chars / 4)` estimated tokens. Section sizes exclude the blank lines that join the parts, so they sum below the total.
- The fixed instructions block is 900 characters, about 225 estimated tokens, and it dominates a short summary. Reflection lines have no cap on count, and every observation line carries id, timestamp, and relevance overhead.

## 4. Does the dropper drop?

`runDropperStage` (`src/hooks/consolidation-trigger.ts`) walks four gates in order, and the first one that fails is the answer.

1. A non-empty reflection in the same pass. Otherwise `dropper.waiting_for_reflection`. This is the common reason nothing drops.
2. An observations-recorded coverage marker on the branch.
3. An active observation pool over `observationsPoolTargetTokens`, 10,000 by default. `observationPoolMetrics(...).ready` requires `observationTokens > targetTokens` and `maxDropsAllowed > 0`. Under target logs `dropper.not_ready`.
4. A usable dropper model. A rejected resolution logs `resolve.rejected` (`src/runtime.ts`).

Observation tokens count the full rendered line, not the content alone (`observationTokenSum` in `src/agents/dropper/pool.ts`). `observationsPoolMaxTokens`, 20,000 by default, switches the visible observation pool into fold mode. It is not a cap on the summary.

Read `dropper.result` for the outcome. `no_tool_call` means the model chose no drops, `all_filtered` means the proposed ids were unusable, and `selected_nonempty` means usable drops were selected.

## Token domains

| Stage | Basis |
| --- | --- |
| Compaction trigger | Local estimate over source entries after the compaction boundary. |
| Observation and reflection scheduling | Provider-reported context deltas when the host exposes `getContextUsage`, otherwise a local estimate since coverage. |
| Observation pool and drop sizing | Local estimate over the full rendered observation lines. |
| Rendered summary and stored memory | Local estimate, `ceil(chars / 4)`. |

A change to one row must move the trigger, the status lines, the documentation, and the tests together.

## Reading the evidence

`/om:status` prints every number above from the live branch. Debug rows go to one NDJSON file per session when `debugLog` is enabled.

```bash
grep -E '"event":"(compaction|dropper)' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Related references: `docs/how-it-works.md` for the pipeline and the summary rendering, and `docs/configuration.md` for every threshold and the `debugLog` event names.
