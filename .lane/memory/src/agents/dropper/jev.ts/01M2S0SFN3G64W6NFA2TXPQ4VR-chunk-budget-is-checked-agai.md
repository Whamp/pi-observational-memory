---
id: 01M2S0SFN3G64W6NFA2TXPQ4VR
anchor: function chunkJevDropperState
created: 2026-09-18T01:06:14Z
norm: '1'
sig: be744485bda3ea79
body_hash: a4904e6b4301658e
raw_hash: ffeb661a5ec837a0
lines: 117-143
---

Chunk budget is checked against the exact serialized state+questions body (the API's billing basis), not a component sum with pads. A pad-based conservative-sum model was tried first and failed empirical validation (whole-body estimate exceeded the sum by ~2.6 tokens/observation from envelope glue). Exact model costs ~0.6s once per consolidation run at 1,100 observations.
