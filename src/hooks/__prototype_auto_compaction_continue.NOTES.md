# PROTOTYPE — auto-compaction ledger replacement

Question: Can Pi's native auto-compaction path let `session_before_compact` replace older raw context with an observational-memory ledger summary, then continue the agent automatically?

Run:

```bash
npm run prototype:auto-compaction
```

Expected verdict from the prototype:

- Overflow recovery fires native auto-compaction with `reason: "overflow"` and `willRetry: true`.
- The extension's `session_before_compact` result is persisted as the compaction entry (`fromHook: true`).
- The retry provider call sees the ledger summary sentinel.
- The retry provider call does **not** see the old raw-context sentinel.
- The retry provider call still sees the current prompt sentinel.
- The output reports whether continuation happened before `session.prompt()` resolved or later via scheduled/native continuation; this matters for print-mode teardown bugs.

Delete this file and `__prototype_auto_compaction_continue.mjs`, or absorb the finding into real docs/tests, once the design decision is made.
