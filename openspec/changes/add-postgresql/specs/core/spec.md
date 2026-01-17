# Core: PostgreSQL Support Extension

## ADDED Requirements

### Requirement: PostgreSQL Dialect Support

The system SHALL support PostgreSQL as an alternative database dialect.

- PostgreSQL dialect MUST be usable via Kysely pg dialect
- SQLite behavior MUST remain unchanged
- PostgreSQL support SHALL be marked as experimental initially

#### Scenario: Create durably with PostgreSQL

- **GIVEN** PostgreSQL Kysely dialect is configured
- **WHEN** `createDurably({ dialect: pgDialect })` is called
- **THEN** durably instance works with PostgreSQL backend

---

### Requirement: Atomic Run Claiming

The system SHALL atomically claim Runs to prevent double-execution in multi-worker deployments.

- PostgreSQL MUST use `FOR UPDATE SKIP LOCKED` for atomic claiming
- SQLite SHALL continue using current claiming logic
- Only one worker MUST be able to claim a specific Run

#### Scenario: Two workers claim simultaneously

- **GIVEN** two workers polling for Runs
- **AND** one pending Run exists
- **WHEN** both workers attempt to claim the Run
- **THEN** exactly one worker succeeds
- **AND** the other worker claims nothing

---

### Requirement: Concurrency Key Lock Table

The system SHALL use a lock table to protect concurrency keys across workers.

- The system MUST create `durably_concurrency_locks` table for PostgreSQL
- Lock MUST be acquired when Run with `concurrency_key` starts
- Lock MUST be released when Run completes, fails, or is cancelled
- Same `concurrency_key` SHALL NOT run simultaneously

#### Scenario: Concurrency key mutual exclusion

- **GIVEN** Run A with `concurrency_key: "org_123"` is running
- **WHEN** Run B with same `concurrency_key` tries to start
- **THEN** Run B remains in `pending` state
- **AND** Run B starts only after Run A completes

---

### Requirement: Stale Run Recovery for PostgreSQL

The system SHALL recover stale Runs in PostgreSQL environments.

- Recovery MUST check `heartbeat_at` against threshold
- Recovery MUST release orphaned concurrency locks
- Recovery SHALL run before each claim attempt

#### Scenario: Recover stale run in multi-worker

- **GIVEN** Run is `running` but heartbeat expired
- **WHEN** any worker's polling cycle runs
- **THEN** Run is reset to `pending`
- **AND** concurrency lock is released
- **AND** Run becomes claimable by any worker
