---
id: 01M2S91S6SCHE9PVNJB4KJVZG9
anchor: const COMPACTION_TRIGGER_VALUES
created: 2026-09-18T03:30:35Z
norm: '1'
---

Fork keeps compactionTrigger (agentSettled | native); upstream 3.1.x removed the field entirely. On every future upstream merge, resolve config.ts conflicts to the fork side. Legacy fork values (auto, agentEnd, betweenTurns) normalize to agentSettled.
