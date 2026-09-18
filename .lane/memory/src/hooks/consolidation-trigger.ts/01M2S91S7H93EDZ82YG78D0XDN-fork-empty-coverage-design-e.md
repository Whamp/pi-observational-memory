---
id: 01M2S91S7H93EDZ82YG78D0XDN
anchor: function runObserverStage
created: 2026-09-18T03:30:35Z
norm: '1'
---

Fork empty-coverage design: explicit empty outcomes append om.observer.completed and ADVANCE observation coverage (ADR 0001), so the due-gate alone prevents same-span re-fires. Upstream #23's observerEmptyBackoff is redundant here; a port attempt broke the empty-coverage resumption test and was reverted (PR #15). Do not port #23 while ADR 0001 semantics hold.
