# Configuration

This page documents the current V3 configuration for `pi-observational-memory`.

V3 keeps the existing `observational-memory` settings namespace, but the setting names changed. Old V2 keys are not aliases; they are ignored. If you are upgrading, read [Migrating from V2](#migrating-from-v2).

## Where settings live

Pi reads settings from:

1. Global settings: `~/.pi/agent/settings.json`
2. Project settings: `<project>/.pi/settings.json`
3. Environment override: `PI_OBSERVATIONAL_MEMORY_PASSIVE`

Project settings override global settings. `PI_OBSERVATIONAL_MEMORY_PASSIVE` overrides only `passive` when set to a recognized value.

All extension-owned settings live under:

```json
{
  "observational-memory": {}
}
```

The extension loads config once for its runtime. After changing settings, restart Pi or reload the extension so the new values are picked up.

## Full V3 example

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "compactAfterTokens": 81000,
    "compactionTrigger": "auto",
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "passive": false,
    "debugLog": false
  }
}
```

You can omit everything. Defaults work for ordinary sessions, and if `model` is unset the memory workers use the current session model.

## Settings reference

| Setting | Type | Default | What it controls |
|---|---:|---:|---|
| `observeAfterTokens` | positive integer | `10000` | Raw/source token threshold for observer runs. |
| `reflectAfterTokens` | positive integer | `20000` | Raw/source token threshold for reflector runs; successful reflection creates dropper maintenance opportunities. |
| `compactAfterTokens` | positive integer | `81000` | Raw/source token threshold for proactive extension-triggered compaction when the effective `compactionTrigger` is `agentEnd`. |
| `compactionTrigger` | `auto`, `native`, or `agentEnd` | `auto` | Whether the extension proactively calls `ctx.compact()` or only customizes Pi native compactions. |
| `observationsPoolMaxTokens` | positive integer | `20000` | Normal compaction-projection observation-token pressure that makes compaction do a full fold. |
| `observationsPoolTargetTokens` | positive integer below max | half of `observationsPoolMaxTokens` | Folded active observation target used by post-reflection dropper maintenance. |
| `agentMaxTurns` | positive integer | `16` | Shared nested-agent turn cap for observer, reflector, and dropper. |
| `model` | object | unset | Shared fallback model for all stages; overridden by per-stage config. |
| `model.provider` | string | unset | Provider name in Pi's model registry. Required when `model` is set. |
| `model.id` | string | unset | Model id in Pi's model registry. Required when `model` is set. |
| `model.thinking` | enum | unset; workers fall back to `low` | Shared fallback reasoning/thinking level for memory workers. |
| `observer` | object | unset | Optional per-stage override; see [stage overrides](#stage-specific-model-and-thinking-overrides). |
| `reflector` | object | unset | Optional per-stage override; the dropper inherits this by default. |
| `dropper` | object | unset | Optional per-stage override; inherits the reflector when unset. |
| `passive` | boolean | `false` | Disables proactive background memory and auto-compaction triggers. |
| `debugLog` | boolean | `false` | Writes best-effort per-session extension debug events to Pi's agent directory. |

Valid `model.thinking` values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

Invalid values are ignored. Positive-integer settings must be finite integers greater than zero. `compactionTrigger` must be one of `auto`, `native`, or `agentEnd`. `observationsPoolTargetTokens` must also be below `observationsPoolMaxTokens`; if omitted or invalid, it is derived as `Math.floor(observationsPoolMaxTokens / 2)`.

## `observeAfterTokens`

Default: `10000`.

The observer runs from Pi's `turn_end` hook. It counts raw/source tokens after the latest `om.observations.recorded.data.coversUpToId` marker. When the count reaches `observeAfterTokens`, the observer receives source entries after that marker and may append a non-empty `om.observations.recorded` ledger entry.

Lower values create smaller chunks and more frequent model calls. Higher values reduce model-call frequency but let unobserved raw conversation accumulate longer. If the observer emits no observations, no ledger entry is written and the same range remains eligible for a later observer run.

## `reflectAfterTokens`

Default: `20000`.

The reflector uses this raw/source-token threshold. Reflector progress is counted after the latest `om.reflections.recorded.data.coversUpToId` marker.

The dropper no longer uses `reflectAfterTokens` as its own launch threshold. Dropper work is gated by successful reflection: after the reflector records non-empty reflections in a consolidation pass, the dropper may run if the folded active observation ledger is over `observationsPoolTargetTokens`. It can see same-turn new reflections before deciding what to prune.

Lower values distill reflections more often and therefore create more opportunities for post-reflection dropper maintenance. Higher values reduce reflector model calls but leave more observations between reflection and dropper opportunities.

## `compactAfterTokens`

Default: `81000`.

`compactAfterTokens` applies only when the effective `compactionTrigger` is `agentEnd`. In that mode, the proactive extension trigger runs from Pi's `agent_end` hook. It counts raw/source tokens after the latest compaction boundary. If the count reaches `compactAfterTokens`, the extension defers with `setTimeout(0)`, checks that Pi is idle, re-checks the threshold, and calls `ctx.compact()`.

This trigger does not wait for observer, reflector, or dropper work. Actual compaction summary creation happens later in `session_before_compact`, where V3 compaction is deterministic and model-free.

When the effective trigger is `native`, `compactAfterTokens` is ignored and Pi's own top-level `compaction` settings control when compaction happens. Pi's manual compaction also still runs the V3 `session_before_compact` hook.

## `compactionTrigger`

Default: `auto`.

`compactionTrigger` controls only whether this extension proactively calls `ctx.compact()`. It does not disable the V3 compaction hook. The hook still handles every `session_before_compact` event and returns the observational-memory ledger summary for Pi native, manual, and extension-triggered compactions.

Modes:

- `auto`: use Pi native compaction timing in `print` and `json` modes; use the legacy `agent_end` trigger in `tui`, `rpc`, and unknown interactive modes.
- `native`: never call extension `ctx.compact()` proactively. Pi's native top-level compaction settings decide timing, and V3 only customizes `session_before_compact` summaries.
- `agentEnd`: preserve the previous proactive behavior exactly: after `agent_end`, if raw/source tokens since the last compaction reach `compactAfterTokens` and Pi is idle, call `ctx.compact()`.

For eval harnesses and `pi -p`, prefer native timing so Pi can use its own auto-compaction-and-continue path:

```json
{
  "observational-memory": {
    "compactionTrigger": "native"
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 50000,
    "keepRecentTokens": 20000
  }
}
```

In that setup, `observational-memory.compactionTrigger` says “do not proactively call `ctx.compact()`,” while Pi's top-level `compaction.reserveTokens` says how early native compaction should fire.

## `observationsPoolMaxTokens`

Default: `20000`.

This controls V3's full-fold pressure. During compaction, the extension builds the normal compaction projection: observations whose `coversUpToId` reaches the compaction boundary, with reflection/drop effects held stable from the latest full fold. If there is no previous full fold, normal compaction includes observations only. If that projection's active observation tokens are at or above `observationsPoolMaxTokens`, compaction performs a full fold through the compaction boundary and applies observations, reflections, and drops by coverage marker. Otherwise, it keeps reflection/drop effects stable from the latest full fold and projects only observations through the new boundary.

This is not the active observation dropper target and not a scheduling threshold for the reflector. Use `observationsPoolTargetTokens` for dropper active observation maintenance and `reflectAfterTokens` for reflector cadence.

## `observationsPoolTargetTokens`

Default: half of `observationsPoolMaxTokens`.

This controls the folded active observation target used by the dropper. If folded active observation tokens are at or below this target, the dropper has no maintenance work. If they are over target, the dropper can run only after the reflector records non-empty reflections in the same consolidation pass.

With the defaults, `observationsPoolMaxTokens` is `20000` and `observationsPoolTargetTokens` is `10000`. If the active observation pool reaches about `20000` tokens, the dropper computes a maximum count intended to move it back toward about `10000` tokens, but the model may drop fewer or none.

When the dropper runs, it computes how many tokens are over target, converts that token excess to an approximate observation-count maximum using average active observation size, and passes that maximum to the model as a hard upper bound. The model may drop fewer or none, and code still rejects invalid or duplicate candidates.

Dropper input includes deterministic reflection coverage evidence for every active observation: `none` means no current reflection supports the observation id, `partial` means one reflection supports it, and `strong` means two or more reflections support it. Coverage is evidence for the model, not an automatic drop rule. Relevance is importance/resistance rather than an absolute lock: `critical` observations require the strongest evidence, but older covered/superseded critical observations may leave active memory when semantic safety is clear. Dropping does not delete ledger history; known ids remain recallable.

This target does not affect compaction full-fold pressure. Visible compaction pressure remains based on `observationsPoolMaxTokens`.

## `agentMaxTurns`

Default: `16`.

This is the shared nested-agent turn cap for the observer, reflector, and dropper. A turn is one assistant/model response cycle inside Pi's agent loop. The cap is not a token budget and not a literal tool-call counter.

Use lower values to bound background memory-worker cost. Too low can reduce observation coverage or reflection/drop quality.

## `model`

Default: unset, meaning memory workers use the session model.

Set `model` when you want the observer, reflector, and dropper to share a cheaper or faster model than the main coding agent. This is the shared fallback for every stage; set `observer`, `reflector`, or `dropper` to override a single stage (see [stage overrides](#stage-specific-model-and-thinking-overrides)):

```json
{
  "observational-memory": {
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    }
  }
}
```

`provider` and `id` must both be non-empty strings. `thinking` is optional. If the configured model cannot be resolved, the runtime attempts to fall back to the current session model and notifies once. If no usable model or API key is available, the relevant background worker skips/fails safely rather than inventing memory.

## Stage-specific model and thinking overrides

The observer, reflector, and dropper are different jobs and may want different models or thinking levels. Each stage accepts an optional `model` and `thinking` override:

```json
{
  "observational-memory": {
    "model": { "provider": "openrouter", "id": "shared-memory-model", "thinking": "low" },
    "observer": { "thinking": "off" },
    "reflector": { "model": { "provider": "openrouter", "id": "a-stronger-reflector", "thinking": "high" } },
    "dropper": { "thinking": "medium" }
  }
}
```

Each stage object has the same shape and accepts:

- `model` (object): a `{ provider, id, thinking? }` override for that stage only.
- `thinking` (enum): one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` for that stage only.

Invalid stage config (non-object, empty models, unknown thinking values) is ignored, the same as invalid top-level config.

### Resolution order

When a value is unset, the resolver walks a fixed fallback chain so defaults are unchanged when no stage config is present.

Model lookup (the model each stage runs on):

```text
observer.model   ?? model            ?? session model
reflector.model  ?? model            ?? session model
dropper.model    ?? reflector.model  ?? model ?? session model
```

Thinking level:

```text
observer.thinking   ?? observer.model.thinking   ?? model.thinking ?? "low"
reflector.thinking  ?? reflector.model.thinking  ?? model.thinking ?? "low"
dropper.thinking    ?? dropper.model.thinking    ?? reflector.thinking ?? model.thinking ?? "low"
```

The dropper inherits the reflector's settings by default because dropping is a judgment/compression task closer to reflection than literal observation. The dropper remains its own stage and can override both `model` and `thinking` independently.

### Defaults are unchanged

If you set none of `observer`, `reflector`, or `dropper`, every stage resolves to the shared `model` and `model.thinking ?? "low"` — exactly the previous behavior.

### Choosing stage models

Do not hardcode specific model ids in shared defaults; treat these as benchmark-driven choices. The observer tends to work best with cheap, literal, low/off thinking capture, while the reflector and dropper may benefit from more judgment. Configure per stage based on your own evaluation, and prefer measuring solve rate with your own tasks before committing to a split.

## `passive`

Default: `false`.

When `true`, the extension does not proactively run the observer, reflector/dropper lane, or auto-compaction trigger. Manual/Pi compaction hooks, `/om:status`, `/om:view`, and `recall` remain available.

Environment override:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

Truthy values: `1`, `true`, `yes`, `on`.

Falsy values: `0`, `false`, `no`, `off`.

Unrecognized values are ignored.

## `debugLog`

Default: `false`.

When enabled, the extension writes best-effort NDJSON debug events under Pi's agent directory. Normal Pi sessions write to a per-session file:

```txt
observational-memory/debug/<session-id>.ndjson
```

Contexts without a usable session id fall back to the legacy global file:

```txt
observational-memory/debug.ndjson
```

Each row includes event metadata such as `sessionId`, `sessionFile`, `runId`, `cwd`, and event-specific `data`. `runId` identifies one consolidation pipeline inside a session file, so you can filter a session log to a single observer/reflector/dropper pass.

Dropper diagnostics are especially useful when the active observation pool is over target but no drops are appended. For example:

```bash
grep '"event":"dropper' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Look for `dropper.result`: `no_tool_call` means the model chose not to drop anything, `all_filtered` means proposed ids were unusable, and `selected_nonempty` means usable drops were selected before append handling.

Debug logs are opt-in local debugging artifacts. By default, diagnostic events should record aggregate counts, token totals, ids, file paths, errors, and project details rather than observation/reflection content, prompts, model responses, or raw model-proposed drop ids. Treat debug files as sensitive local artifacts.

Debug-log write failures do not change memory behavior.

## Migrating from V2

V3 is not backwards compatible with V2 settings. Old keys are silently ignored and do not act as aliases.

| V2 setting | V3 setting | Migration note |
|---|---|---|
| `observationThresholdTokens` | `observeAfterTokens` | Rename. Same rough observer-cadence role. |
| `compactionThresholdTokens` | `compactAfterTokens` | Rename. Same rough proactive-compaction role only when the effective `compactionTrigger` is `agentEnd`; native timing uses Pi's top-level `compaction` settings. |
| `reflectionThresholdTokens` | `reflectAfterTokens`, `observationsPoolMaxTokens`, and/or `observationsPoolTargetTokens` | Split. Use `reflectAfterTokens` for reflector cadence, `observationsPoolMaxTokens` for compaction full-fold pressure, and `observationsPoolTargetTokens` for dropper active observation maintenance. |
| `compactionModel` | `model` | Move `{ provider, id }` under `model`. |
| `thinkingLevel` | `model.thinking` | Move under `model`. |
| `observerMaxTurnsPerRun` | `agentMaxTurns` | Replace with one shared cap. |
| `reflectorMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap. |
| `prunerMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap; V3 calls the role the dropper. |
| `compactionMaxToolCalls` | none | Remove. No V3 replacement. |
| `passive` | `passive` | Keep if desired. |
| `debugLog` | `debugLog` | Keep if desired. |

Old V2 memory entries and old V2 compaction details are ignored by V3. Start a new clean Pi session after upgrading to V3 so old visible summaries and old memory formats do not confuse the transition.

## Tuning recipes

### Lower background cost

```json
{
  "observational-memory": {
    "observeAfterTokens": 20000,
    "reflectAfterTokens": 50000,
    "agentMaxTurns": 8,
    "model": { "provider": "openrouter", "id": "a-cheaper-model", "thinking": "off" }
  }
}
```

Tradeoff: fewer background model calls, but memory updates lag longer, observation chunks are larger, and reflection/drop cleanup happens less often.

### More responsive memory

```json
{
  "observational-memory": {
    "observeAfterTokens": 750,
    "reflectAfterTokens": 3000,
    "agentMaxTurns": 16,
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" }
  }
}
```

Tradeoff: more background model calls.

### Split observer and reflector models

```json
{
  "observational-memory": {
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" },
    "observer": { "thinking": "off" },
    "reflector": { "model": { "provider": "openrouter", "id": "a-stronger-reflector", "thinking": "high" } }
  }
}
```

The observer uses the shared model with thinking off (literal, cheap capture). The reflector runs a stronger model with higher thinking. The dropper is unset, so it inherits the reflector's model and thinking. Measure this against a single shared model on your own tasks before committing.

### Disable proactive work temporarily

```json
{
  "observational-memory": {
    "passive": true
  }
}
```

Or for one shell:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=1 pi
```

## See also

- [concepts.md](concepts.md) — vocabulary and mental model.
- [how-it-works.md](how-it-works.md) — lifecycle and data shapes.
- [../README.md](../README.md) — quick start and V2 migration summary.
