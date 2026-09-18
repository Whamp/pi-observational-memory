---
id: 01M2S0SK17FDP1HFEB89H2NQ7A
anchor: const mockAgents
created: 2026-09-18T01:06:18Z
norm: '1'
sig: 13f38b028fa3e5ba
body_hash: 7fae2c8df640e9bb
raw_hash: 9e9ec19fe9a13de8
lines: 3-7
---

The agent.js vi.mock must stay PARTIAL (importOriginal spread): src/agents/dropper/jev.ts imports selectDropCandidates from agent.js, so a full module replacement breaks the Jev path with 'No selectDropCandidates export is defined on the mock'. Discovered when the Jev success test fell back to the LLM with a dropper.failed warning.
