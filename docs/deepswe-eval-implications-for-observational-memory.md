# Deep SWE Bench eval implications for pi-observational-memory

Date: 2026-06-29
Workflow: `pi_om_eval_research`
Run: `mr02u4t6-kx5ulp`

This note preserves the workflow synthesis and critic from a deep read-only research pass over `~/evals/deep-swe-bench`, existing zvec/embedding analyses, and this extension's model/thinking seams.

## Final synthesis

# Final synthesis: implications for `pi-observational-memory`

## 1. What the eval evidence actually shows

### Observer thinking should stay low/off

The strongest repeated signal is negative: **high/xhigh thinking is bad for Observer**.

Evidence:

- `gpt54mini-xhigh` had worse solve rate: `0.278`.
- It shifted observations toward abstract requirement summaries:
  - requirement-like share high
  - test/failure share low
  - final topic recall only `0.102`
- Low/off observers captured more concrete live-state evidence:
  - test/failure observations around `~0.25`
  - self-report/state observations around `~0.23`

Interpretation: Observer is not a reasoning job. It is an event-capture job.

The Observer should record:

- files touched
- commands run
- errors
- passing/failing tests
- unresolved seams
- user constraints
- verified completions

It should not infer broad architecture or summarize requirements too early.

---

### Best current single Observer: `gpt-5.4-mini:low`

Evidence:

- `observational-memory-gpt54mini-low` is the semantic reference winner:
  - semantic F1 `1.000`
- On full `gpt-5.5/low` eval:
  - baseline partial: `0.968`
  - OM `gpt54mini-low` partial: `0.949`
  - solves: `29 -> 28`

So it is not a clear win for near-ceiling `gpt-5.5`, but it is the best observed single Observer candidate.

---

### `glm-5.2:off` is meaningfully different, not merely worse

Evidence:

- `glm52-off` semantic F1 vs GPT-mini-low: `0.823`
- Unique-neighbor mining:
  - GLM-off unique rate vs GPT-mini-low: `0.404`
  - GPT-mini-low unique rate vs GLM-off: `0.279`
- Pair complementarity:
  - GLM unique topics: `248`
  - GPT-mini unique topics: `153`
  - oracle solve: `0.500`
  - robust partial: `0.997`

Interpretation: GLM-off is a good **diversity lane**, not necessarily the primary Observer.

Do not replace GPT-mini-low with GLM-off by default. Keep GLM-off as an optional second perspective.

---

### OM helps weaker executors more

Evidence:

| Worker | Baseline partial | OM partial | Baseline solves | OM solves |
|---|---:|---:|---:|---:|
| `deepseek-v4-flash/high` | `0.774` | `0.856` | `2` | `10` |
| `gpt-5.5/low` best solve OM variant | `0.968` | `0.945` | `29` | `32` |

For DeepSeek, OM is a big win.

For GPT-5.5, OM trades partial score down while sometimes increasing solves. That suggests OM can help finish some tasks but can also nudge a strong model away from the clean path.

---

### Negative eval pattern: missed seams, not lack of exploration

The reported regressions look like “missed boring integration seam” failures:

- export/compat path
- CLI registration
- overlay schema/test seam
- shared type/error path

So the problem is probably not “memory needs deeper reasoning.” It is more likely:

- noisy memory crowds out the seam
- early/abstract observations anchor the worker
- self-reported completion claims look too authoritative
- final observations/compaction lag behind the actual latest state

---

## 2. What it likely means for `pi-observational-memory`

### Treat Observer and Reflector as different jobs

Current coupling is the wrong abstraction.

Observer wants:

```text
cheap, literal, low/off thinking, high grounding
```

Reflector may want:

```text
slower, more judgment, dedupe/compression/support fidelity
```

Dropper wants:

```text
conservative pruning
```

Using one model/thinking knob for all three forces a bad compromise.

Evidence supports **separating the knobs**.

Evidence does **not** yet prove Reflector should use high thinking.

---

### Do not default Reflector to high yet

The plausible hypothesis is:

```text
Observer: low/off
Reflector: maybe higher
Dropper: low/off or conservative
```

But the evals did not isolate Reflector.

Current results changed the whole OM worker model, so Observer/Reflector/Dropper effects are confounded.

Safe default:

```text
observer: low/off
reflector: inherit shared low for now
dropper: inherit shared low for now
```

Then test Reflector separately.

---

### Multi-observer is promising, but should be configurable first

GPT-mini-low and GLM-off are complementary.

But unfiltered union could make near-ceiling regressions worse.

So do not hardcode a two-observer ensemble yet.

Shortest safe version:

```text
one primary observer
optional extra observer lanes
tag observations by lane/model
dedupe/rank before render
```

---

## 3. Recommended extension changes, shortest-path first

### 1. Add stage-specific model/thinking config

Minimal config shape:

```ts
model?: ConfiguredModel; // shared fallback

observer?: {
  model?: ConfiguredModel;
  thinking?: ModelThinkingLevel;
};

reflector?: {
  model?: ConfiguredModel;
  thinking?: ModelThinkingLevel;
};

dropper?: {
  model?: ConfiguredModel;
  thinking?: ModelThinkingLevel;
};
```

Resolution order:

```text
stage.model ?? shared model ?? session model
stage.thinking ?? stage.model.thinking ?? shared.model.thinking ?? "low"
```

Default behavior should remain unchanged when no stage config exists.

This is the highest-value refactor because it enables clean evals without committing to a new architecture.

---

### 2. Change Observer default guidance: low/off, concrete, seam-aware

Docs/config recommendation:

```text
Observer: gpt-5.4-mini:low
Optional diversity observer: glm-5.2:off
Avoid observer high/xhigh unless experimenting.
```

Prompt guidance should emphasize:

- exact errors
- test state
- commands
- files
- unresolved seams
- user decisions
- verified completions

Avoid:

- speculative summaries
- broad requirements summaries
- “completed” unless verified

---

### 3. Patch completion/self-report wording

Current memory seems to risk anchoring on assistant self-report.

Recommended behavior:

- `completed:` only when backed by passing tests, user confirmation, or direct verification
- otherwise use:
  - `attempted:`
  - `changed:`
  - `claimed complete but unverified:`

Rendered memory should say:

```text
Assistant completion claims are historical evidence, not proof. Verify code/tests when correctness matters.
```

This is a cheap prompt/render patch and directly targets near-ceiling degradation.

---

### 4. Prefer seam facts in rendered memory

When choosing what to show the worker, rank higher:

1. unresolved failing tests
2. exact error messages
3. files touched
4. integration seams
5. user constraints
6. verified completions

Rank lower:

- broad implementation summaries
- repeated self-reports
- stale requirements restatements
- vague “need to handle edge cases” notes

This may be only a prompt/ranking tweak first. Do not build a complex scorer unless the cheap version works.

---

### 5. Defer compaction if consolidation is in flight

Evidence suggests compaction may race with fresh observation/reflection.

Minimal change:

```text
if runtime.consolidationInFlight, skip/defer auto-compaction once
```

This targets late-turn coverage loss without building a scheduler.

---

### 6. Make multi-observer experimental, not default

Configurable lane idea:

```ts
observer?: {
  model?: ConfiguredModel;
  thinking?: ModelThinkingLevel;
  extraModels?: ConfiguredModel[];
};
```

But I would not implement this first unless needed for the next eval. Stage separation comes first.

Skipped: hardcoded ensemble. Add only after merged observers beat best single observer without worsening GPT-5.5 near-ceiling rows.

---

## 4. Refactor seams needed to support those changes

Grounded in current files:

### `src/config.ts`

Current:

- `Config` has one shared `model?: ConfiguredModel`
- `normalizeModel()` only handles `{ provider, id, thinking }`
- `loadConfig()` merges one global/project/env model

Needed:

- add optional `observer`, `reflector`, `dropper` config sections
- normalize stage model/thinking
- preserve existing `model` as fallback

Minimal target:

```ts
type StageModelConfig = {
  model?: ConfiguredModel;
  thinking?: ModelThinkingLevel;
};
```

---

### `src/runtime.ts`

Current:

- `Runtime.resolveModel` resolves one configured model override for the whole runtime

Needed:

- either keep `resolveModel()` unchanged and call it with stage model
- or add a small stage-aware wrapper

Do not rewrite runtime. The agent layer already supports per-stage thinking.

---

### `src/hooks/consolidation-trigger.ts`

Current:

- `makeModelResolver()` caches one resolved model
- `runObserverStage()`, `runReflectorStage()`, `runDropperStage()` all pass:

```ts
runtime.config.model?.thinking ?? "low"
```

Needed:

- cache resolved model by stage
- pass stage-specific thinking
- keep fallback behavior

This is the main implementation seam.

---

### Existing agents probably do not need changes

Files:

- `src/agents/observer/agent.ts`
- `src/agents/reflector/agent.ts`
- `src/agents/dropper/agent.ts`

They already accept:

```ts
thinkingLevel?: ModelThinkingLevel
```

So avoid touching them unless prompt wording changes live there.

---

### Tests to update

Likely impacted:

- `tests/config.test.ts`
  - stage config normalization/fallback
- `tests/runtime.test.ts`
  - shared fallback behavior
- `tests/consolidation-trigger.test.ts`
  - Observer/Reflector/Dropper receive the correct model/thinking

Docs:

- `docs/configuration.md`
- `README.md`

---

## 5. Specific next evals to run

### Eval 1: stage separation smoke

Purpose: prove config plumbing does not change current behavior.

Variants:

```text
shared model only
observer-only override matching shared
reflector-only override matching shared
dropper-only override matching shared
```

Expected: identical or near-identical behavior.

---

### Eval 2: Observer thinking ablation

Hold worker and Reflector fixed.

Variants:

```text
observer gpt-5.4-mini off
observer gpt-5.4-mini low
observer gpt-5.4-mini high
observer gpt-5.4-mini xhigh
observer glm-5.2 off
observer glm-5.2 low
```

Primary question:

```text
Does low/off continue to dominate once Reflector is controlled?
```

---

### Eval 3: Reflector-only replay

Cheaper than full benchmark.

Use existing observation ledgers.

Hold observations fixed, rerun only Reflector:

```text
reflector gpt-5.4-mini low
reflector gpt-5.4-mini high
reflector glm-5.2 off
reflector gpt-5.5 low
```

Score mechanically:

- reflection count
- token count
- duplicate rate
- unsupported claims
- support-id precision
- seam preservation
- whether Dropper would remove important observations

This directly tests the “Reflector higher thinking” hypothesis without a 113-task sweep.

---

### Eval 4: no-dropper / conservative-dropper

Purpose: check whether Dropper causes seam loss.

Variants:

```text
normal OM
no dropper
dropper low/off
dropper conservative prompt
```

Focus on known seam-regression tasks:

- `adaptix-name-mapping-aliases`
- `cattrs-partial-structuring-recovery`
- `dasel-html-document-format`
- `actionlint-action-pinning-lint`
- `dynamodb-toolbox-lazy-recursive-schemas`

---

### Eval 5: prompt patch only

Before larger architecture, test cheap mitigation:

- completion wording patch
- unresolved seam emphasis
- concrete evidence over broad summaries

Run on:

```text
gpt-5.5/low near-ceiling slice
deepseek-v4-flash/high hard slice
```

Success means:

- GPT-5.5 partial drop shrinks
- DeepSeek gains remain

---

### Eval 6: optional two-observer merge

Only after stage config works.

Variants:

```text
gpt-5.4-mini:low single
glm-5.2:off single
gpt-5.4-mini:low + glm-5.2:off merged/deduped
```

Do not compare raw union only. Compare merged/ranked memory, otherwise noise may dominate.

---

## 6. Risks / unknowns

### Reflector high thinking is unproven

Evidence supports separating Observer and Reflector.

It does not prove Reflector should be high.

Bad Reflector output is more dangerous than bad Observer output because it can become durable memory and justify dropping source observations.

---

### Embedding analysis is useful but not final

The GLM/GPT diversity evidence is strong enough to justify experiments.

But caveats remain:

- some analyses are on `12_v0`
- clustering is heuristic
- semantic F1 is not downstream solve rate
- oracle complementarity may overstate achievable merged performance

---

### Near-ceiling regressions are the main product risk

For strong workers, OM can become drag.

Mitigation should focus on:

- less noise
- better seam preservation
- verified completion wording
- conservative Dropper
- low/off Observer

Not on “more reasoning everywhere.”

---

### Cost accounting is incomplete

Main result JSONs do not fully capture OM worker spend.

Before choosing expensive Reflector defaults, measure:

- Observer tokens
- Reflector tokens
- Dropper tokens
- wall time
- solve/partial delta per dollar

---

## Shortest practical path

1. Add stage-specific `observer` / `reflector` / `dropper` config with shared fallback.
2. Default/docs: Observer `low/off`; warn against `high/xhigh`.
3. Patch Observer/render prompts around verified completion and unresolved seams.
4. Add compaction defer when consolidation is in flight.
5. Run reflector replay before any full high-thinking sweep.
6. Keep GLM-off as optional diversity, not default ensemble.

## Evidence critic / corrected recommendations

Corrections needed

- Tone down the metric claims. `semantic F1=1.000`, `oracle solve=0.500`, and topic-share stats are offline proxies, not proof of a production default.
- Reword “best current single Observer” to “best current candidate on the tested slice.” `gpt-5.4-mini:low` looks best so far, but it was not a universal win on `gpt-5.5/low`.
- Reword `glm-5.2:off` as “promising diversity candidate,” not “good diversity lane.” The complementarity numbers justify more evals, not a default ensemble.
- Replace “missed seams, not lack of exploration” with a hypothesis. That diagnosis is plausible, but not established without a failure taxonomy over all regressions.
- The system already has separate observer/reflector/dropper agents and prompts; the shared bottleneck is config resolution in `src/config.ts` + `src/hooks/consolidation-trigger.ts`, not a missing agent abstraction.
- The config proposal is overbuilt. Don’t add nested `observer/reflector/dropper` objects, `extraModels`, or a dropper-specific default yet.
- Drop the “defer compaction if consolidation is in flight” idea for now. No evidence yet, and it adds scheduler complexity.
- Drop the ranking/scoring scheme for “seam facts” in rendered memory. The current prompt rules and coverage/support-id system are enough to test the cheaper version first.
- Don’t hardcode exact model IDs in shipped defaults/docs; keep them as benchmark recommendations.

Final prioritized recommendations

1. Split stage-specific model/thinking overrides for observer vs reflector, with shared fallback.  
   Files: `src/config.ts`, `src/hooks/consolidation-trigger.ts`.

2. Default the observer to low/off; keep reflector at current low until a reflector-only replay proves higher thinking helps.  
   Files: `src/hooks/consolidation-trigger.ts`, `src/agents/observer/prompts.ts`, `src/agents/reflector/prompts.ts`.

3. Treat `glm-5.2:off` as an eval-only diversity candidate, not a shipped two-observer ensemble.  
   Keep multi-observer in the harness, not the extension.

4. Patch prompt/docs for verified completions, exact errors, and seam facts; keep it simple.  
   Files: `src/agents/observer/prompts.ts`, `src/agents/reflector/prompts.ts`, `README.md`, `docs/configuration.md`.

5. Run two targeted evals before any bigger refactor: observer thinking ablation, then reflector-only replay.  
   Don’t ship multi-observer or compaction changes until those are clean.

## Raw gather outputs

```json
[
  "I\u2019ll sample an `openai-codex/gpt-5.5` OM-off worker run record to see whether worker-side costs/tokens reflect the intended no-reasoning setup.",
  "Read-only mining. Sources:\n- `results/deepseek-v4-flash/high/{baseline,observational-memory}/.../result.json`\n- `results/gpt-5.5/low/{baseline,observational-memory-*}/.../result.json`\n- `reports/om-memory-pilot-w10/{initial_summary.md,difficulty_causal_analysis.md}`\n- `analysis/observer-embeddings-smoke/semantic-distance-summary.csv`\n- `analysis/om-observer-screen/mechanical_scores.csv`\n\n### 1) Full paired benchmark\n\n| model | config | tasks | mean partial | solves | vs baseline |\n|---|---|---:|---:|---:|---:|\n| deepseek-v4-flash/high | baseline | 113 | 0.774 | 2 | \u2014 |\n| deepseek-v4-flash/high | observational-memory (`deepseek-v4-flash:low`) | 113 | 0.856 | 10 | +0.082 partial, +8 solves |\n| gpt-5.5/low | baseline | 113 | 0.968 | 29 | \u2014 |\n| gpt-5.5/low | observational-memory-gpt54mini-low (`gpt-5.4-mini:low`) | 113 | 0.949 | 28 | -0.019 partial, -1 solve |\n| gpt-5.5/low | observational-memory-glm52-off (`glm-5.2:off`) | 113 | 0.945 | 32 | -0.023 partial, +3 solves |\n| gpt-5.5/low | observational-memory-gpt54mini-off (`gpt-5.4-mini:off`) | 113 | 0.932 | 29 | -0.037 partial, 0 solves |\n\n### 2) Observer evidence\n\n- `analysis/observer-embeddings-smoke/semantic-distance-summary.csv`:\n  - `observational-memory-gpt54mini-low` = semantic F1 `1.000` (best reference)\n  - `observational-memory-glm52-off` = semantic F1 `0.823` (close/diverse)\n  - caveat: only 2 tasks\n\n- Small slice variants:\n  - `observational-memory-gpt54-low`: `+0.006` partial on 12 tasks\n  - `observational-memory-glm52-high`: `~flat` on 12 tasks\n  - `xhigh` variants were worse and costlier on the small slices\n\n### Implications\n\n- **Yes, separate Observer vs Reflector is worth testing.** Current OM configs use one worker model for observer/reflector/dropper (`configs/observational-memory-gpt54mini-low/README.md`), but the data says the observer should stay cheap (`low/off`), not `xhigh`.\n- **Best current observer default:** `gpt-5.4-mini:low`. `glm-5.2:off` is close enough to be a good second observer / diversity source.\n- **Avoid defaulting observers to higher thinking.** `xhigh`/`high` mostly look worse or noisier, and they cost more.\n- **OM helps weaker executors more.** DeepSeek gains a lot; gpt-5.5 mostly trades partial score for a few extra solves.\n- **Main negative-eval pattern:** OM hurts near-ceiling tasks by missing a seam, not by lacking exploration (`reports/om-memory-pilot-w10/difficulty_causal_analysis.md`).\n\n### Caveat\n\nOM worker spend is not fully captured in the main result JSON, so token/cost deltas are lower bounds.",
  "Evidence found in `analysis/observer-embeddings/gpt55-low-12v0-all-observers/`:\n\n- Best single observer remains `observational-memory-gpt54mini-low` (semantic F1 1.000).\n- `observational-memory-glm52-off` is close but clearly different: F1 0.823, precision 0.812, recall 0.835, centroid distance 0.035.\n- GLM variants are not \u201cjust worse\u201d:\n  - `glm52-max` F1 0.833, but solve drops to 0.306 and obs ratio jumps to 3.42.\n  - `glm52-high` F1 0.824, solve 0.333.\n  - `glm52-off` has the best solve among GLM at 0.417, but still semantically far from GPT-5.4-mini-low.\n\nDiversity / complementarity evidence:\n\n- Unique-neighbor mining, GLM-off \u2194 GPT-5.4-mini-low:\n  - GLM-off \u2192 GPT-mini-low: unique rate 0.404, mean nearest sim 0.810\n  - GPT-mini-low \u2192 GLM-off: unique rate 0.279, mean nearest sim 0.836\n- Pairwise complementarity:\n  - union topic recall 0.357\n  - overlap 0.259\n  - unique topics: GLM-off 248, GPT-mini-low 153\n  - oracle solve 0.500, robust partial 0.997\n- Top divergence tasks are mostly the same few repos: `anko-default-function-arguments`, `boa-hierarchical-evaluation-cancellation`, `actionlint-action-pinning-lint`, `awilix-async-container-initialization`, `dynamodb-toolbox-lazy-recursive-schemas`.\n\nThinking-level evidence:\n\n- Xhigh is the clearest negative signal for observers:\n  - `gpt54mini-xhigh`: solve 0.278, robust partial 0.934, no-observation tasks 2\n  - type mix shifts toward abstract/requirement-like notes: requirement 0.354, test/failure 0.112, self-report 0.087\n  - timeliness is bad: early obs share 0.956, final topic recall 0.102\n- By contrast low/off configs are more balanced and better at live verification:\n  - low/off roughly ~0.25 test/failure share and ~0.23 self-report share\n- Self-consistency is not quality:\n  - `gpt54mini-low` has lower rep-consistency (semantic F1 0.800) than some worse configs, but best solve (0.444).\n\nImplication:\n\n- Strong evidence for **observer low/off defaults**.\n- Strong evidence that **observer xhigh is a bad default** for OM.\n- Strong evidence that **GLM-5.2-off and GPT-5.4-mini-low are complementary**, so multi-observer diversity is worth preserving.\n- **Separate Observer vs Reflector models is plausible**; the current data supports keeping the observer lightweight/low-thinking and moving higher thinking to a different role, but I do **not** have direct reflector-specific evidence yet.\n\nCommands run:\n- `sed -n ... semantic-distance-summary.md/csv`\n- `sed -n ... INITIAL_EMBEDDING_ANALYSIS.md`\n- `sed -n ... FOLLOWUP_ANALYSIS_SUMMARY.md`\n- `sed -n ... unique-observations-glm52-off-vs-gpt54mini-low/{summary.csv,examples.md}`\n- `sed -n ... {pairwise-complementarity,observation-type-classification,timeliness-adjusted-coverage,rep-self-consistency}/summary.md`\n- `python -` aggregation over `nearest-neighbor-observations.csv`\n\nConfidence: medium-high on \u201cobserver low/off + multi-observer diversity\u201d; medium on \u201cseparate observer/reflector models\u201d because reflector wasn\u2019t directly tested here.\n\nGaps: only `12_v0`, heuristic clustering/embeddings, and no direct ablation of observer-vs-reflector separation.",
  "Here\u2019s the seam map.\n\n**Current wiring**\n- `src/config.ts:13-116`\n  - `Config` has one shared `model?: ConfiguredModel`.\n  - `normalizeModel()` only reads `{ provider, id, thinking }`.\n  - `loadConfig()` merges that single model from global/project/env settings.\n- `src/runtime.ts:42-62` (`Runtime.resolveModel`)\n  - Resolves **one** configured model override for the whole runtime.\n  - Falls back to the session model if configured model is missing.\n- `src/hooks/consolidation-trigger.ts:77-368`\n  - `makeModelResolver()` caches one `ResolveResult` and reuses it for observer/reflector/dropper.\n  - `runObserverStage()`, `runReflectorStage()`, `runDropperStage()` all pass the same:\n    - resolved model\n    - `runtime.config.model?.thinking ?? \"low\"`\n- `src/agents/observer/agent.ts`, `src/agents/reflector/agent.ts`, `src/agents/dropper/agent.ts`\n  - Each already accepts `thinkingLevel?: ModelThinkingLevel`.\n  - Each maps it to LLM `reasoning` only when the model supports reasoning.\n  - So stage-specific thinking is already supported at the agent layer.\n\n**Current limitation**\n- No way to set observer vs reflector models separately.\n- No way to set observer vs reflector thinking separately.\n- Dropper is coupled to the same shared model/thinking too.\n- One missing configured model affects all three stages the same way.\n\n**Smallest plausible refactor**\n1. Keep the agent code unchanged.\n2. Add stage-specific config only at the trigger layer first.\n   - Minimal shape: stage overrides for `observer` / `reflector` (leave dropper shared for now).\n3. Split `makeModelResolver()` into stage-aware resolution or cache-by-stage.\n4. Wire `thinkingLevel` per stage from config instead of `runtime.config.model?.thinking ?? \"low\"`.\n5. Preserve shared `model` as fallback/default so this stays a thin extension, not a rewrite.\n\n**Tests impacted**\n- `tests/consolidation-trigger.test.ts` \u2014 main one; it asserts the shared model/thinking is passed to all stages.\n- `tests/runtime.test.ts` \u2014 shared fallback / missing configured model behavior.\n- `tests/config.test.ts` \u2014 config schema/normalization.\n- Docs to sync: `docs/configuration.md`, `README.md`.\n\nIf you want, I can next turn this into a 1-file refactor plan with the exact new config shape I\u2019d choose."
]
```

## Raw analysis outputs

```json
[
  "## Bottom line\n\nObserver should be treated as a **cheap, grounded event-capture role**, not a deep reasoning role.\n\nBest current design direction:\n\n1. **Default Observer thinking: `off` or `low`, not `high/xhigh`.**\n2. **Separate Observer and Reflector model/thinking config.**\n3. **Use GPT-5.4-mini low as the strongest current default observer.**\n4. **Keep GLM-5.2 off as a diversity lane, not necessarily the primary.**\n5. **Do not hardcode an ensemble yet; make lanes configurable and testable first.**\n\n---\n\n## Evidence-backed claims\n\n### 1. High observer thinking is a bad default\n\nEvidence points against `high/xhigh` for Observer:\n\n- `gpt54mini-xhigh` had worse solve rate: `0.278`.\n- It produced more abstract/requirement-like observations:\n  - requirement share `0.354`\n  - test/failure share only `0.112`\n  - final topic recall only `0.102`\n- Low/off configs had better live-verification balance:\n  - roughly `~0.25` test/failure observations\n  - roughly `~0.23` self-report observations\n\nImplication: Observer quality seems to come from **timely concrete capture**, not deeper reasoning.\n\n---\n\n### 2. GPT-5.4-mini low is the best current single observer\n\nEvidence:\n\n- `observational-memory-gpt54mini-low` is the best semantic reference:\n  - semantic F1 `1.000`\n- On full GPT-5.5/low eval:\n  - partial score dropped slightly vs baseline: `0.949` vs `0.968`\n  - solves nearly matched: `28` vs `29`\n\nIt is not a clear net win for near-ceiling GPT-5.5, but it is the best observed single Observer candidate.\n\n---\n\n### 3. GLM-5.2 off is not just worse; it is different\n\nEvidence:\n\n- `glm52-off` semantic F1: `0.823`\n- It is semantically distant from GPT-5.4-mini low:\n  - centroid distance `0.035`\n- Unique-neighbor mining:\n  - GLM-off \u2192 GPT-mini-low unique rate `0.404`\n  - GPT-mini-low \u2192 GLM-off unique rate `0.279`\n- Pairwise complementarity:\n  - GLM unique topics: `248`\n  - GPT-mini unique topics: `153`\n  - oracle solve: `0.500`\n  - robust partial: `0.997`\n\nImplication: GLM-5.2 off looks like a **diversifying observer**, not a replacement for GPT-5.4-mini low.\n\n---\n\n### 4. OM helps weaker executors more than near-ceiling executors\n\nEvidence:\n\n- DeepSeek v4 flash/high:\n  - baseline partial `0.774`, solves `2`\n  - OM partial `0.856`, solves `10`\n  - gain: `+0.082` partial, `+8` solves\n- GPT-5.5/low:\n  - baseline partial `0.968`, solves `29`\n  - best solve OM variant `glm52-off`: partial `0.945`, solves `32`\n  - partial drops, solves can rise\n\nImplication: Observer memory may be most valuable where the worker needs scaffolding. For strong models, OM can introduce drag or wrong emphasis.\n\n---\n\n## Observed failure modes\n\n### Near-ceiling degradation\n\nFor GPT-5.5, OM often trades partial score down for small solve changes. The likely danger is not \u201ctoo little memory,\u201d but **wrong or noisy memory nudging the worker away from the correct seam**.\n\nDesign implication:\n\n- cap observation volume\n- deduplicate aggressively\n- prefer concrete test/failure/action observations\n- avoid abstract \u201crequirements\u201d summaries from high-thinking observers\n\n---\n\n### Overthinking creates premature abstraction\n\n`xhigh` observers appear to front-load broad requirement notes instead of capturing grounded late-stage evidence.\n\nDesign implication:\n\n- Observer prompt/config should favor:\n  - facts\n  - commands\n  - files touched\n  - failing/passing tests\n  - decisions\n  - blockers\n- It should avoid:\n  - speculation\n  - grand summaries\n  - inferred project intent unless directly evidenced\n\n---\n\n### Self-consistency is not enough\n\nEvidence says `gpt54mini-low` had lower rep-consistency than some worse configs, but better solve rate.\n\nDesign implication: Do not optimize Observer solely for stable/consistent observations. Optimize for **useful coverage and downstream solve impact**.\n\n---\n\n## Hypotheses, not yet proven\n\n### 1. Reflector may benefit from higher thinking\n\nCurrent evidence supports low/off for Observer. It does **not** directly prove Reflector should be high.\n\nPlausible hypothesis:\n\n- Observer: cheap, grounded, low/off\n- Reflector: maybe stronger/higher-thinking, because it compresses and reconciles observations after the fact\n\nNeeds direct ablation.\n\n---\n\n### 2. GPT-5.4-mini low + GLM-5.2 off could form a useful ensemble\n\nEvidence supports complementarity, but not yet production ensemble behavior.\n\nSafer first step:\n\n- add configurable observer lanes\n- allow `primary` + optional `diversity`\n- tag source model per observation\n- merge/dedupe before memory write\n\nDo not hardcode a permanent two-observer ensemble yet.\n\n---\n\n### 3. Adaptive observer use may minimize negative evals\n\nLikely useful policy:\n\n- default to one low/off observer\n- add GLM diversity only when:\n  - the worker is weaker\n  - task is long-running\n  - observations are sparse\n  - failures repeat\n  - memory confidence is low\n\nThis needs testing.\n\n---\n\n## Recommended Pi OM design change\n\nMinimal refactor:\n\n```ts\nmodel: sharedFallbackModel\n\nobserver:\n  model: gpt-5.4-mini\n  thinking: low\n\nreflector:\n  model: strongerOrShared\n  thinking: low | high\n\ndropper:\n  model: sharedFallbackModel\n  thinking: low\n```\n\nKeep shared `model` as fallback. Add stage-specific overrides.\n\nStart simple:\n\n1. `observer.model`\n2. `observer.thinking`\n3. `reflector.model`\n4. `reflector.thinking`\n\nSkipped: hardcoded ensemble. Add when lane-based evals prove merged observers beat the best single observer without hurting near-ceiling runs.",
  "### Reflector implication\n\nYes: **split Observer and Reflector model/thinking knobs**, but don\u2019t assume \u201cReflector high thinking\u201d is right yet.\n\nCurrent code couples all stages:\n\n- `Config.model` is one shared model.\n- `runObserverStage`, `runReflectorStage`, and `runDropperStage` all pass `runtime.config.model?.thinking ?? \"low\"`.\n- Agent layer already supports per-stage `thinkingLevel`, so the refactor is mostly config + resolver plumbing.\n\n### What the evidence says\n\nKnown:\n\n- Observer should stay **low/off**.\n  - `xhigh` observers were worse, noisier, more abstract, and costlier.\n  - Best single observer so far: `gpt-5.4-mini:low`.\n  - `glm-5.2:off` is close and complementary.\n- Current benchmark variants changed the **whole OM worker model**, not just Reflector.\n  - So any win/loss is confounded across Observer + Reflector + Dropper.\n- Negative eval pattern is \u201cmissed seam,\u201d not \u201cinsufficient exploration.\u201d\n  - That argues against making Observer more thoughtful.\n  - It may argue for a better Reflector/Dropper gate only if seams are present in observations but lost/blurred later.\n\nUnknown:\n\n- Whether Reflector benefits from higher thinking.\n- Whether Reflector high thinking over-generalizes, creates false durable reflections, or inflates support ids.\n- Whether Dropper is causing any near-ceiling regressions by dropping observations whose exact seam was not actually preserved.\n\n### Reflector design hypothesis\n\nReflector is a better place than Observer for \u201cmore thinking\u201d because:\n\n- It reads a smaller, structured pool of observations.\n- Its job is judgment: durability, dedupe, abstraction, support-id fidelity.\n- It runs less often than Observer, so higher cost hurts less.\n\nBut it is also riskier than Observer in one way:\n\n- Bad Observer output is noisy.\n- Bad Reflector output can become **durable wrong memory** and can make Dropper delete still-needed observations.\n\nSo the safe design is:\n\n```ts\nmodel?: ConfiguredModel;          // shared fallback\nobserver?: { model?: ConfiguredModel };\nreflector?: { model?: ConfiguredModel };\ndropper?: { model?: ConfiguredModel };\n```\n\nResolution order:\n\n```text\nstage.model ?? shared model ?? session model\nstage.thinking ?? stage.model.thinking ?? shared.model.thinking ?? \"low\"\n```\n\nDefault:\n\n```text\nobserver:  gpt-5.4-mini low/off\nreflector: inherit low for now\ndropper:   inherit low/off, or keep conservative\n```\n\nDo **not** default Reflector to high until tested.\n\n### Cheapest validation\n\nNo full benchmark first. Replay existing OM ledgers.\n\n1. Pick existing runs with strong observation pools:\n   - `gpt-5.4-mini:low`\n   - `glm-5.2:off`\n   - maybe union/multi-observer pool\n\n2. Hold observations fixed.\n\n3. Run only Reflector variants:\n   - same model low\n   - same model medium/high\n   - `gpt-5.5 low`\n   - `glm-5.2 off/low`\n   - maybe `gpt-5.4-mini low` over GLM observations\n\n4. Score Reflector output mechanically:\n   - reflection count/token count\n   - support-id precision\n   - unsupported high/critical observations\n   - duplicate/reword rate\n   - exact-seam preservation on known divergence tasks\n   - downstream Dropper candidates before/after\n\n5. Only then run a small paired eval slice on top candidates.\n\nSkipped: full 113-task sweep now. Add it after replay shows Reflector-specific signal.",
  "## Prioritized failure modes + mitigations\n\n### 1) Observer thinking too high pollutes memory with abstract/early summaries\n**Evidence**\n- `gpt54mini-xhigh`: solve `0.278`, robust partial `0.934`, 2 no-observation tasks.\n- xhigh type mix shifts away from useful live state: requirement share `0.233`, test/failure `0.159`, self-report `0.083`; low/off keep test/failure around `0.255`.\n- xhigh often records early snapshots then stops covering later implementation: `gpt54mini-xhigh` early obs share `0.956`, final topic recall `0.102`.\n\n**Likely cause**\nHigh-thinking observers over-summarize requirements/architecture and under-capture concrete test failures, file seams, and late verification state.\n\n**Mitigation**\n- Default observer to `low` or `off`; avoid `xhigh`.\n- Add stage-specific config now: `observer.model/thinking`, `reflector.model/thinking`, maybe later `dropper`.\n- Add a warning or docs note: \u201cobserver high/xhigh is experimental and regressed evals.\u201d\n\n---\n\n### 2) Shared model/thinking couples three different jobs\n**Evidence**\n- `src/config.ts` has one `model`.\n- `src/hooks/consolidation-trigger.ts` passes `runtime.config.model?.thinking ?? \"low\"` to observer, reflector, and dropper.\n- Agent layer already accepts per-stage `thinkingLevel`, so the missing seam is config/wiring, not agent code.\n\n**Likely cause**\nObserver wants cheap literal capture; reflector may want stronger synthesis; dropper wants conservative pruning. One setting forces a bad compromise.\n\n**Mitigation**\nSmallest refactor:\n```ts\nmodel?: ConfiguredModel\nobserver?: { model?: ConfiguredModel }\nreflector?: { model?: ConfiguredModel }\ndropper?: { model?: ConfiguredModel }\n```\nFallback to shared `model`.\n\nSuggested eval defaults:\n- Observer: `gpt-5.4-mini:low` or `glm-5.2:off`\n- Reflector: test `gpt-5.4-mini:low` vs `gpt-5.4-mini:medium/high`\n- Dropper: keep low/off until direct evidence says otherwise\n\nDo **not** default reflector higher yet; current evidence supports separation, not the high-reflector choice.\n\n---\n\n### 3) Memory hurts near-ceiling tasks by missing one integration seam\n**Evidence**\n- DeepSeek full run: hard bucket improved `+0.308` partial, but medium `-0.022`, easy `-0.043`.\n- Losses concentrated:\n  - `adaptix-name-mapping-aliases`: `0.999 -> 0.000`; OM missed overlay-schema/test seam.\n  - `cattrs-partial-structuring-recovery`: `0.947 -> 0.132`; OM missed compat/export path.\n  - `dasel-html-document-format`: missed CLI registration seam.\n\n**Likely cause**\nOM keeps exploration alive, but on easy/medium tasks the winning move is often one boring seam: export, CLI registration, compat shim, shared error type, or test file.\n\n**Mitigation**\n- Prompt/render memory should bias toward \u201cunresolved seams\u201d and \u201cverification failures,\u201d not broad implementation narrative.\n- Add observer guidance: capture missed/remaining integration seams explicitly when present.\n- Add eval slice for \u201cseam tasks\u201d before any larger refactor.\n\nLazy code change first: prompt tweak, not new architecture.\n\n---\n\n### 4) Prompt pollution from \u201ccompleted:\u201d / self-report observations\n**Evidence**\n- Topic correlation flags negative self-reported completion / implementation-state topics.\n- Rendered summary says: \u201cWork that prior observations describe as completed should not be redone unless\u2026\u201d\n- Observer prompt explicitly encourages \u201ccompleted:\u201d markers.\n\n**Likely cause**\nThe worker may treat assistant self-reports as truth, anchoring on partial/wrong work and skipping verification or alternate seams.\n\n**Mitigation**\n- Change observer prompt: use `completed:` only for user-confirmed or test-verified completion.\n- Render summary should say assistant completion claims are historical evidence, not proof; verify code/tests when correctness matters.\n- Prefer wording like \u201cAssistant attempted/changed\u2026\u201d unless backed by passing tests.\n\n---\n\n### 5) Compaction can run before fresh observation/reflection coverage catches up\n**Evidence**\n- Consolidation runs on `agent_start` / `turn_end`.\n- Auto-compaction runs on `agent_end`.\n- `compaction-trigger.ts` does not wait for `runtime.consolidationInFlight`.\n- Timeliness analysis shows poor late coverage for bad configs.\n\n**Likely cause**\nCompaction may snapshot memory before the latest chunk is observed/reflected, especially after long final implementation turns.\n\n**Mitigation**\n- Before auto-compaction: if consolidation is in flight or observation/reflection is due, defer compaction.\n- Minimal version: if `runtime.consolidationInFlight`, skip/defer compaction once.\n- Better eval variant: \u201cflush observer before compact.\u201d\n\n---\n\n### 6) More observations \u2260 better observations\n**Evidence**\n- `glm52-max`: topic recall `0.354`, obs ratio `3.423`, but solve `0.306`.\n- `glm52-off`: lower recall `0.256`, solve `0.417`.\n- `gpt54mini-low`: lower topic recall `0.194`, best solve `0.444`.\n\n**Likely cause**\nRaw coverage adds noise. Broad survey notes can crowd out decisive test/failure/seam facts.\n\n**Mitigation**\n- Cap or rank observations by usefulness before rendering.\n- Prefer test/failure, exact errors, unresolved seams, user constraints, verified completions.\n- Avoid rendering every low-value implementation-state note.\n\n---\n\n### 7) GLM-off is useful diversity, but not as unfiltered union\n**Evidence**\n- GLM-off + GPT-5.4-mini-low: union topic recall `0.357`, overlap `0.259`, oracle solve `0.500`.\n- GLM-off has 248 unique topics; GPT-mini-low has 153.\n- GLM-off skews broader codebase survey; GPT-mini-low skews validation/test outcomes.\n\n**Mitigation**\n- Keep multi-observer as an experiment.\n- Start with 2-observer optional mode: `gpt-5.4-mini:low` primary + `glm-5.2:off` diversity.\n- Merge through dedup/ranking; do not dump both full streams into compacted context.\n\n---\n\n## Highest-value next experiments\n\n1. **Stage-specific config refactor** with observer low/off default.\n2. **Prompt patch**: completion claims require verification; capture unresolved seams.\n3. **Compaction flush/defer** before auto-compaction.\n4. Eval variants:\n   - observer-only, no reflector/dropper\n   - reflector low vs high with same observer\n   - no-dropper\n   - GPT-mini-low + GLM-off merged vs single observer\n\nBottom line: fix observer defaults and stage separation first. The evidence says OM is good on hard stateful tasks but harms near-ceiling rows through noisy/early/overconfident memory and missed seams."
]
```


---

## 2026-06-29 update: reflector/dropper workflow findings

New source: `/home/will/evals/deep-swe-bench/analysis/om-reflector-dropper-workflow/SYNTHESIS.md`

Supporting reports:

- `/home/will/evals/deep-swe-bench/analysis/om-reflector-dropper-workflow/inventory.md`
- `/home/will/evals/deep-swe-bench/analysis/om-reflector-dropper-workflow/reflector_content_audit.md`
- `/home/will/evals/deep-swe-bench/analysis/om-reflector-dropper-workflow/dropper_activation_audit.md`
- `/home/will/evals/deep-swe-bench/analysis/om-reflector-dropper-workflow/model_differences_reflector_dropper.md`
- `/home/will/evals/deep-swe-bench/analysis/om-reflector-dropper-workflow/outcome_linkage.md`
- `/home/will/evals/deep-swe-bench/analysis/om-reflector-dropper-workflow/extension_mechanics.md`

### Updated conclusions

1. Reflector is no longer just a hypothesis. It is active, model-sensitive, and materially different across model/thinking settings.
2. Dropper did not meaningfully activate in the analyzed datasets. Current positive OM effects are therefore not caused by dropping.
3. GLM-5.2 looks especially strong for reflector depth/support density, not just observer diversity.
4. GPT-5.4-mini-low remains the best solve-lift candidate in the GPT-5.5 low grid, but its reflections are shallower and more process/self-report-heavy than GLM.
5. High/xhigh thinking still looks suspect: it often produces fewer reflections. More thinking can mean sparser memory, not better memory.
6. The next code move remains stage-specific model/thinking overrides, but the rationale is stronger: observer and reflector have empirically different behavior and may want different models.
7. Do not prioritize dropper behavior changes until a forced-over-target dropper experiment makes the active drop path observable.

### Key evidence

- DeepSeek-v4-flash high full run: 113 tasks, OM vs baseline showed +0.082 mean partial, +11 net binary solves, and positive descriptive correlations between observation/reflection volume and outcome. No debug NDJSON was available there, so runtime reflector/dropper event analysis is unavailable for DeepSeek.
- GPT-5.5 low grid: solve gains were mostly near-miss-to-solve conversions while mean partial was slightly negative for every OM config.
- Reflector yield differs strongly by config. `gpt54mini-low` accepted nonempty reflections in 87.4% of reflector runs; `glm52-off` in 92.2%; `gpt55-off` only 53.2%; `gpt54-off` 50.0%.
- `glm52-off` had richer reflections: 650 reflection records, 86.38 avg tokens, 2.27 avg supporting observations. It also had strong support-density and coverage-transition numbers.
- `gpt54mini-low` was mechanically clean and solved best in the 36_v1 screen, but content audit found more completion/self-report/process-style reflections.
- `gpt54mini-off` had high throughput but more duplicate/reject noise.
- Dropper never emitted `om.observations.dropped`; no active drop events appeared. Every audited `dropper.not_ready` had `maxDropsAllowed = 0` and `tokensOverTarget = 0`.
- The observation pools stayed far below the 10k target: max fullness was 27.41% in the low-grid audit; named current trees maxed at 6,279 tokens for DeepSeek high and 1,846 for GPT-5.5 low.

### Revised recommendation

Ship the smallest enabling refactor:

- allow Observer and Reflector to use separate model/thinking settings;
- keep Dropper on inherited/default settings for now;
- document benchmark recommendations rather than hardcoding model IDs;
- run a reflector-only replay next;
- run a forced-over-target dropper activation test before changing dropper logic.

Skipped for now: multi-observer in the extension, dropper tuning, ranking/scoring memory facts, scheduler changes.

### Model inheritance decision: Dropper follows Reflector by default

User decision, 2026-06-29: Dropper should inherit Reflector settings by default, not Observer settings, because dropping is a judgment/compression task closer to reflection than literal observation. Dropper should still remain independently configurable.

Recommended resolution order:

```text
observer.model   ?? shared model ?? session model
reflector.model  ?? shared model ?? session model
dropper.model    ?? reflector.model ?? shared model ?? session model

observer.thinking   ?? observer.model.thinking   ?? shared thinking ?? "low"
reflector.thinking  ?? reflector.model.thinking  ?? shared thinking ?? "low"
dropper.thinking    ?? dropper.model.thinking ?? reflector.thinking ?? shared thinking ?? "low"
```

Implementation note: keep this as fallback resolution only. Do not couple Dropper to Reflector internals; `dropper` remains its own stage config and can override both model and thinking.
