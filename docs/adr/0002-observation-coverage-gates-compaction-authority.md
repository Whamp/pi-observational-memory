# Observation Coverage gates Compaction Authority

Observational memory may provide a compaction summary only when trustworthy, source-backed Observation Coverage reaches the Pruned Source Boundary. The Pruned Source Boundary is the final source entry the current compaction will newly remove from active context, strictly before Pi's first kept entry and after the previous compaction boundary.

Only Recorded observation batches count as replacement coverage. Explicit Empty is durable scheduling progress but contains no replacement context. Failed, absent, malformed, orphaned, non-source, and Empty markers do not grant authority. The batch that reaches the boundary must also be present in the exact compaction projection returned to Pi; a later watermark cannot authorize a projection that omitted its batch. If either proof fails, observational memory returns no override and does not cancel. Pi or a later compaction handler then owns the summary.

The latest compaction entry determines visible structured observational memory. Valid `om.folded` details on the latest compaction are visible. A latest native or non-OM compaction makes structured visible memory empty. Full ledger memory and known-id recall remain available, and a later OM compaction can restore structured visibility.

## Considered options

Always returning an OM projection preserves the model-free fast path but can replace uncovered source with an empty or partial summary. Gating only on rendered-summary emptiness misses non-empty older memory that omits newer source and rejects intentionally empty covered spans. Gating only in passive mode misses active-mode observer lag and failure. Synchronous catch-up observation would add model latency and failure modes to V3's deterministic hook. Cancelling uncovered compaction can leave Pi over its context limit.

## Consequences

The covered OM path remains deterministic and model-free. Explicit Empty never authorizes an empty replacement summary. The host path may call Pi's summarization model, adding latency and cost, but it preserves source not represented in the returned projection. The authority rule is independent of trigger origin and passive mode, starts no workers, waits for no in-flight work, and adds no configuration option or routine notification. Debug logs record only the decision and boundary ids.

This decision extends [ADR 0001](0001-explicit-empty-outcomes-advance-coverage.md). Empty advances the observer's scheduling coverage and Failed does not; this ADR deliberately keeps replacement-context coverage narrower.

## Field evidence (added 2026-08-19)

Upstream independently hit the empty-summary failure mode in `elpapi42/pi-observational-memory` PR [#39](https://github.com/elpapi42/pi-observational-memory/pull/39), which declines compaction ownership when the rendered summary is empty (`if (summary.length === 0) return`). That rule is safe for a fresh session with no memory yet, but it still returns a partial non-empty override when older memory omits newer, uncovered source — exactly the stale-memory case named above. The fix validates gating on coverage reaching the prune boundary; this ADR adds the stricter requirement that the covering batch must be present in the returned projection.
