---
id: 01M2S0SK1HC9WMXD4701DQQR8C
anchor: function createJevClient
created: 2026-09-18T01:06:18Z
norm: '1'
sig: 5d89ac1e8dbf0ae8
body_hash: ebf98467f89a1b27
raw_hash: d90a8a6f25ad76ae
lines: 230-285
---

DEFAULT_JEV_MODEL_ID lives here (the transport owns the wire default); src/config.ts imports it for resolveJevDropperConfig so the pinned id has one definition site. The client validates usage strictly at the boundary: a 200 without finite input_tokens/output_tokens is malformed_response.
