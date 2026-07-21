# Observational Memory

Observational Memory maintains durable, source-backed memory for a Pi session by classifying observer outcomes and tracking which source has been trustworthily evaluated.

## Language

**Recorded observer outcome**:
An observer run in which at least one proposed observation was accepted as durable memory.
_Avoid_: Empty result, observation attempt

**Empty observer outcome**:
An observer run that explicitly and trustworthily reported no new observations. It is a successful coverage outcome that creates no observation records.
_Avoid_: Silent completion, failure, no-output error

**Failed observer outcome**:
An observer run that could not produce a trustworthy result because execution failed, every proposal was rejected, or no structured outcome was reported.
_Avoid_: Empty result, covered span

**Observation Coverage**:
The durable branch boundary through which an observer produced a Recorded or Empty outcome. It means the source was trustworthily evaluated, not that every source event became an observation.
_Avoid_: Observation attempt, raw source backlog
