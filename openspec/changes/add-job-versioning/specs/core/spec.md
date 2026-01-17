# Core: Job Versioning Extension

## ADDED Requirements

### Requirement: Job Hash Generation

The system SHALL auto-generate a hash from job definition for version tracking.

- The hash MUST be generated from job name and input/output schemas
- The hash generation MUST be stable (order-independent)
- The hash MUST be computed at job registration time

#### Scenario: Generate job hash

- **WHEN** `durably.register({ myJob })` is called
- **THEN** `job_hash` is computed from job definition
- **AND** hash is stored in job registry

---

### Requirement: Job Hash Storage

The system SHALL store `job_hash` with each Run for compatibility tracking.

- Run records MUST include `job_hash` from trigger time
- The `job_hash` MUST be immutable once stored

#### Scenario: Store job hash at trigger

- **WHEN** `job.trigger(payload)` is called
- **THEN** Run is created with current `job_hash`
- **AND** `job_hash` is persisted in database

---

### Requirement: Job Hash Validation

The system SHALL validate job hash compatibility when resuming Runs.

- The system MUST compare current `job_hash` with Run's stored hash
- Mismatched hash SHALL cause `job_version_mismatch` error by default
- The `allowIncompatible` option MUST bypass validation

#### Scenario: Retry with matching hash

- **GIVEN** Run's `job_hash` matches current job definition
- **WHEN** `durably.retry(runId)` is called
- **THEN** Run is retried normally

#### Scenario: Retry with mismatched hash

- **GIVEN** Job definition has changed since Run was created
- **WHEN** `durably.retry(runId)` is called
- **THEN** error `job_version_mismatch` is raised

#### Scenario: Retry with allowIncompatible

- **GIVEN** Job definition has changed since Run was created
- **WHEN** `durably.retry(runId, { allowIncompatible: true })` is called
- **THEN** Run is retried despite hash mismatch

#### Scenario: Resume HITL with mismatched hash

- **GIVEN** Run is in `waiting_human` and job definition changed
- **WHEN** `durably.resume(token, payload)` is called
- **THEN** error `job_version_mismatch` is raised (HTTP 412)
