# Pi's safe between-turn compaction path

## Question

Which Pi extension lifecycle event and compaction API can request compaction between model turns in TUI, RPC, print, and JSON modes while guaranteeing that the same agent run continues?

## Executive answer

**None in Pi 0.81.1.** `turn_end` is the conceptual between-model-turn seam, but the only extension call, `ctx.compact()`, starts *manual* compaction. Manual compaction disconnects agent events, aborts the active operation, waits for idle, and completes with `reason: "manual"` and `willRetry: false`; it cannot preserve an in-progress tool loop. Pi's only guaranteed compact-and-continue path is internal overflow recovery: after `agent_end`, Pi compacts with `willRetry: true` and then calls `agent.continue()`. Extensions may customize or cancel that compaction through `session_before_compact`, but cannot trigger that continuation-capable path themselves.

Therefore, moving this repository's optional trigger from its current idle `agent_end` deferral to `turn_end + ctx.compact()` would break same-run continuation. The requested behavior is blocked on a Pi runtime/API capability, not an observational-memory trigger change.

### Evidence scope

The installed executable reports `0.81.1`; the package identifies itself as `@earendil-works/pi-coding-agent@0.81.1` ([`packages/coding-agent/package.json:1-18`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/package.json#L1-L18)). All upstream links below pin the `v0.81.1` commit, `20be4b18d4c57487f8993d2762bace129f0cf7c6`. This repository's lockfile still resolves the Pi packages to `0.81.0` ([`package-lock.json:519-564`](../../package-lock.json#L519-L564)); that version difference is a compatibility caution for future implementation and regression tests.

## Documented guarantees

Pi documents one prompt as `agent_start`, one or more `turn_start … turn_end` cycles while tools continue, `agent_end`, then `agent_settled` ([`docs/extensions.md:275-314`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/extensions.md#L275-L314)). It explicitly distinguishes the last two events: retries, auto-compaction recovery, or queued continuation may follow `agent_end`; none remain at `agent_settled` ([`docs/extensions.md:558-585`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/extensions.md#L558-L585)).

The documented extension constraints are:

- `ctx.isIdle()` is false during an agent run, automatic retry, auto-compaction retry, or queued continuation ([`docs/extensions.md:1014-1017`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/extensions.md#L1014-L1017)).
- `ctx.compact()` returns without awaiting completion; `onComplete` and `onError` are follow-up notifications ([`docs/extensions.md:1047-1061`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/extensions.md#L1047-L1061)). Its type returns `void`, and both callbacks also return `void` ([`src/core/extensions/types.ts:294-335`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/extensions/types.ts#L294-L335)).
- `session_before_compact` runs for manual, threshold, and overflow compaction. It exposes `reason`, `willRetry`, and the prepared cut point, and may cancel or supply a compaction ([`docs/compaction.md:271-310`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/compaction.md#L271-L310); [`src/core/extensions/types.ts:581-601`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/extensions/types.ts#L581-L601)).
- Successful overflow compaction is the documented case where `compaction_end.willRetry` is true and Pi automatically retries the prompt ([`docs/rpc.md:1011-1049`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/rpc.md#L1011-L1049)).

Pi ships a `turn_end + ctx.compact()` example ([`examples/extensions/trigger-compact.ts:8-48`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/examples/extensions/trigger-compact.ts#L8-L48)), but its test only mocks `ctx.compact()` and checks threshold invocation; it does not exercise a tool loop or assert continuation ([`test/trigger-compact-extension.test.ts:26-58`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/trigger-compact-extension.test.ts#L26-L58)). The example is not evidence of same-run safety.

## Source-observed lifecycle

For a tool loop, Pi appends tool results to the active context, emits `turn_end`, calls `prepareNextTurn`, and then begins the next provider turn ([`packages/agent/src/agent-loop.ts:202-259`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/agent/src/agent-loop.ts#L202-L259)). Upstream tests confirm `toolResult message_end → turn_end → turn_start` before the second assistant response ([`test/suite/agent-session-retry-events.test.ts:260-303`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/suite/agent-session-retry-events.test.ts#L260-L303)). Thus `turn_end` is the right timing boundary in principle.

The coding-agent session keeps `_isAgentRunActive` true across the initial prompt and every post-run continuation. After each low-level run it decides retry, compaction, and queued-message continuation; a true decision causes `agent.continue()`. Only the final `finally` emits `agent_settled` and marks the session idle ([`src/core/agent-session.ts:1059-1100`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1059-L1100); [`src/core/agent-session.ts:569-586`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L569-L586)). Consequently, `ctx.isIdle()` is false at `turn_end` and `agent_end`, and normally true at `agent_settled`; upstream settlement tests assert the latter after retries and queued follow-ups ([`test/suite/regressions/6363-agent-settled-event.test.ts:29-90`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts#L29-L90)).

### Manual extension path

The extension binding starts an unawaited async call to `AgentSession.compact()` and invokes `onComplete` or `onError` afterward ([`src/core/agent-session.ts:2408-2435`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L2408-L2435)). `AgentSession.compact()` then:

1. disconnects from agent events and aborts the current operation;
2. waits for session idleness through `abort()`;
3. runs `session_before_compact` with `reason: "manual"`, `willRetry: false`;
4. persists and installs the rebuilt context;
5. emits `session_compact` and `compaction_end` with `willRetry: false`;
6. reconnects agent events.

These steps are explicit in [`src/core/agent-session.ts:1537-1551`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1537-L1551) and [`src/core/agent-session.ts:1776-1922`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1776-L1922). Neither callback can request continuation, and no continuation follows manual `compaction_end`.

### Internal continuation path

After `agent_end`, `_checkCompaction()` distinguishes overflow from threshold compaction. Overflow recovery removes the failed assistant response and calls `_runAutoCompaction("overflow", true)`; threshold compaction passes `false` ([`src/core/agent-session.ts:1940-2039`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1940-L2039)). Auto-compaction still invokes `session_before_compact`, persists the rebuilt context, and emits the normal compaction events. It returns true for overflow recovery, causing the coordinator to call `agent.continue()`; threshold compaction continues only when a steering/follow-up message is already queued ([`src/core/agent-session.ts:2042-2197`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L2042-L2197)). Extensions can customize this path but have no API to request it.

The extension `agent_end` event itself does not expose `willRetry` ([`src/core/extensions/types.ts:700-729`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/extensions/types.ts#L700-L729)); only the public `AgentSessionEvent` adds it after extension handlers run ([`src/core/agent-session.ts:592-620`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L592-L620)). This is why this repository currently screens retryable `agent_end` errors itself ([`src/hooks/compaction-trigger.ts:6-34`](../../src/hooks/compaction-trigger.ts#L6-L34)).

## Interactive behavior: TUI and RPC

TUI and RPC use the shared `AgentSession` compaction implementation; the extension mode changes UI availability, not `ctx.compact()` semantics ([`src/core/agent-session.ts:1-13`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1-L13); [`src/core/extensions/types.ts:303-335`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/extensions/types.ts#L303-L335)). Calling `ctx.compact()` at `turn_end` therefore aborts the active run in both modes. Calling it after `agent_settled` can rebuild and reconnect the session for later use, but the old run has already ended; a later user prompt is a new run, not continuation of the compacted run ([`src/core/agent-session.ts:1776-1922`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1776-L1922)).

RPC also has a client `compact` command that directly awaits `session.compact()` ([`src/modes/rpc/rpc-mode.ts:530-532`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L530-L532)). That command is an external manual operation, not an extension-triggered between-turn continuation mechanism.

## Print, JSON, and headless behavior

Print and JSON share `runPrintMode`; it binds extensions as `print` or `json`, awaits each `session.prompt()`, then disposes the runtime in `finally` ([`src/modes/print-mode.ts:67-107`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/modes/print-mode.ts#L67-L107); [`src/modes/print-mode.ts:121-157`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/modes/print-mode.ts#L121-L157)). `session.prompt()` awaits the full post-run coordinator, including native overflow compaction and `agent.continue()` ([`src/core/agent-session.ts:1195-1263`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1195-L1263); [`src/core/agent-session.ts:1059-1100`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/agent-session.ts#L1059-L1100)). Native overflow recovery therefore finishes before disposal in both headless output formats.

By contrast, `ctx.compact()` is fire-and-forget and `runPrintMode` does not join its callbacks. A manual compaction launched from an extension event has no source-level guarantee that it finishes before runtime disposal. The repository's current `auto` policy avoids this gap by selecting native compaction in print/JSON and the deferred extension trigger in TUI/RPC ([`src/config.ts:250-257`](../../src/config.ts#L250-L257)). RPC is headless but long-lived and must not be grouped with single-shot print/JSON for this decision.

## Test-harness options

The best regression surface is the real coding-agent session with a faux provider:

- Pi's internal harness supports scripted responses, custom tools, inline extension factories, in-memory settings/session/auth, and event capture ([`test/suite/harness.ts:63-92`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/suite/harness.ts#L63-L92); [`test/suite/harness.ts:100-219`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/test/suite/harness.ts#L100-L219)).
- This repository already has an equivalent public-SDK harness ([`tests/compaction-runtime.integration.test.ts:37-93`](../../tests/compaction-runtime.integration.test.ts#L37-L93)). Its overflow test proves the existing native path persists a compaction, reports `reason: "overflow", willRetry: true`, retains the interrupted prompt, and completes the retry ([`tests/compaction-runtime.integration.test.ts:308-363`](../../tests/compaction-runtime.integration.test.ts#L308-L363)).
- `pi-agent-core`'s public `AgentHarness.compact()` requires an idle harness, so it cannot prove mid-run `ctx.compact()` behavior ([`packages/agent/src/harness/agent-harness.ts:714-765`](https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/agent/src/harness/agent-harness.ts#L714-L765)).

If Pi exposes a continuation-capable extension trigger, the minimum regression should use a tool-bearing first response, request compaction at its first `turn_end`, assert that compaction completes before the second provider call, verify that the second context contains the summary and retained tool result, and observe one normal final settlement. The same scenario must run through `runPrintMode` in text and JSON modes to prove disposal occurs only after completion. This specifies proof of the requested behavior; it does not add new retry, waiting, or failure semantics.

## Risks and unknowns

- **Unknown maintainer intent:** Pi ships the `turn_end` example, but neither its documentation nor test promises same-run continuation. It is unknown whether mid-tool-loop abort is intended or a bug.
- **No extension retry signal at `agent_end`:** the extension event omits `willRetry`, so moving logic there cannot reliably select Pi's continuation path without duplicating host heuristics.
- **Threshold is not overflow recovery:** native threshold compaction uses `willRetry: false`; absent queued messages, the current run settles. Lowering Pi's threshold would not create the required between-turn same-run guarantee.
- **Version skew:** this conclusion targets installed Pi 0.81.1, while the repository lockfile uses 0.81.0. Any implementation should pin and test the intended Pi version before relying on lifecycle details.
- **Unknown future API:** no released extension contract at the audited revision requests compaction at the next-turn seam while preserving the active run.

## Minimal recommendation for this repository

1. **Do not implement `betweenTurns` as `turn_end + ctx.compact()`.** It can abort a tool loop and cannot guarantee continuation in any mode.
2. **Keep `registerCompactionHook()` unchanged.** Its coverage-gated `session_before_compact` authority is independent of trigger origin ([`src/hooks/compaction-hook.ts:85-138`](../../src/hooks/compaction-hook.ts#L85-L138)) and already customizes Pi's continuation-capable overflow path.
3. **Keep the current mode split and idle extension trigger until Pi supplies a continuation-capable extension contract.** The existing trigger defers from `agent_end`, checks `ctx.isIdle()`, and then invokes manual compaction ([`src/hooks/compaction-trigger.ts:45-96`](../../src/hooks/compaction-trigger.ts#L45-L96)); this preserves current observational-memory semantics but intentionally does not claim same-run continuation.
4. **Treat the requested between-turn feature as upstream-blocked.** Resolve the Pi capability first, then add the faux-provider lifecycle regression above without changing observational-memory's threshold, Compaction Authority, summary, or failure behavior.
