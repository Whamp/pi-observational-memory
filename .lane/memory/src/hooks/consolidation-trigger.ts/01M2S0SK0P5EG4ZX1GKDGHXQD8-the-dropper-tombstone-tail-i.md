---
id: 01M2S0SK0P5EG4ZX1GKDGHXQD8
anchor: function runDropperStage
created: 2026-09-18T01:06:18Z
norm: '1'
sig: b99762b5b27b36a6
body_hash: 6a381e77e357155c
raw_hash: 9a3acaa0be745ecd
lines: 437-526
---

The dropper tombstone tail is shared between the Jev and LLM engines via appendDroppedObservations; the LLM path stays byte-identical. Jev failures fall through to the LLM path in the same function rather than calling a second copy. resolveJevDropperConfig is called once per stage run and its mode feeds both the stage_start payload and the mode branch.
