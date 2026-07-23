# Observation Coverage gates Compaction Authority

Observational memory may provide a compaction summary only when trustworthy, source-backed Observation Coverage reaches the Pruned Source Boundary. The Pruned Source Boundary is the final source entry the current compaction will newly remove from active context, strictly before Pi's first kept entry and after the previous compaction boundary.

Recorded and explicit Empty outcomes count as Observation Coverage. Failed, absent, malformed, orphaned, and non-source markers do not. If coverage reaches the boundary, observational memory returns its deterministic `om.folded` projection. If coverage does not reach the boundary, or the boundary cannot be proved safe, observational memory returns no override and does not cancel. Pi or a later compaction handler then owns the summary.

The latest compaction entry determines visible structured observational memory. Valid `om.folded` details on the latest compaction are visible. A latest native or non-OM compaction makes structured visible memory empty. Full ledger memory and known-id recall remain available, and a later OM compaction can restore structured visibility.

## Considered options

Always returning an OM projection preserves the model-free fast path but can replace uncovered source with an empty or partial summary. Gating only on rendered-summary emptiness misses non-empty older memory that omits newer source and rejects intentionally empty covered spans. Gating only in passive mode misses active-mode observer lag and failure. Synchronous catch-up observation would add model latency and failure modes to V3's deterministic hook. Cancelling uncovered compaction can leave Pi over its context limit.

## Consequences

The covered OM path remains deterministic and model-free. A fully covered explicit Empty span may authorize an intentionally empty OM summary without creating observations. The host path may call Pi's summarization model, adding latency and cost, but it preserves uncovered source in active context. The authority rule is independent of trigger origin and passive mode, starts no workers, waits for no in-flight work, and adds no configuration option or routine notification. Debug logs record only the decision and boundary ids.

This decision extends [ADR 0001](0001-explicit-empty-outcomes-advance-coverage.md). Empty still advances Observation Coverage and Failed still does not; this ADR defines how that distinction controls compaction ownership.
