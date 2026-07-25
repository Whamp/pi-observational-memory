# Compose between-turn compaction with nested Pi lifecycle events

Pi 0.81 manual compaction first aborts the active agent run, while `sendMessage({ triggerTurn: true })` starts a detached nested run after Pi becomes idle. Between-turn compaction therefore composes `turn_end` → `agent_settled` → manual compaction → Automatic continuation signal. The matching custom `message_start` returns the trigger to idle, and each parent `agent_settled` handler waits for its nested continuation to settle. This nesting permits repeated, independently earned cycles without an unconditional loop and keeps headless print mode alive until the final response.

Before sending the signal, the trigger requires the manual compaction callback, a manual non-retrying `session_compact` event, a newly persisted latest boundary that matches the callback, and raw-token headroom below the threshold captured at `turn_end`. Pi 0.81 locates the event entry by summary, so repeated deterministic summaries can report an older entry id; the latest branch boundary remains the authoritative persisted proof. Compaction Authority still decides whether Observational Memory or Pi supplies the summary.

## Considered options

A synthetic user prompt would blur user provenance and make one submitted prompt appear as several. An unconditional continuation loop could run without fresh tool work or headroom. Fire-and-forget signaling without a settlement waiter would let text and JSON print mode dispose the runtime before nested work finished. We rejected all three.

## Consequences

Each eligible cycle persists Pi's aborted boundary-call artifact, compacts once, and sends one hidden custom message in the same session. Terminal turns, queued messages, native threshold compaction, overflow recovery, failed safety proof, cancellation, and errors send no signal. The design adds no workers, retries, ledger state, or Compaction Authority policy.
