# Explicit Empty observer outcomes advance coverage

An observer run has one of three outcomes: Recorded, Empty, or Failed. A trustworthy Empty outcome requires an explicit structured signal and writes `om.observer.completed { outcome: "empty", coversUpToId }`; Recorded and Empty outcomes advance Observation Coverage, while Failed outcomes do not. This prevents valid Empty runs from triggering a model call every turn without allowing silence, malformed output, or execution failures to masquerade as successful coverage.

## Considered options

Retrying Empty source after a separate attempt watermark would permit reconsideration with later context, but it would introduce a second progress model and growing retry chunks. It would also treat Empty chunks more cautiously than source omitted from a partially Recorded chunk. Retrying every turn repeats model cost and warnings; inferring Empty from silence cannot distinguish deliberate completion from failure.

## Consequences

An explicit Empty outcome permanently retires its source from future observation, just as a Recorded outcome retires source events that were not selected for memory. Empty creates no fabricated observation records, does not advance reflector or dropper boundaries, and does not block compaction. Failed outcomes remain operationally visible, retry on the next eligible turn, and do not alter compaction policy in this decision.
