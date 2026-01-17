# Core: HITL Extension (Simple)

## ADDED Requirements

### Requirement: Human-in-the-Loop Wait

The system SHALL allow Steps to wait for human input in the simplest possible form.

- The system MUST provide `ctx.human(options)` to transition Run to `waiting_human` state
- The `message` parameter MUST specify the human-readable request text
- The `schema` parameter MAY specify the expected input format (optional)
- The `timeoutMs` parameter SHALL specify the wait deadline (default 24 hours)
- The system MUST persist `wait_message`, `wait_schema`, and `wait_deadline_at` on the Run

#### Scenario: Wait for human input

- **WHEN** `const decision = await ctx.human({ message: "Please confirm" })` is called
- **THEN** Run transitions to `waiting_human` state
- **AND** `wait_message` is stored on the Run
- **AND** `run:wait_human` event is emitted

#### Scenario: Human wait with timeout

- **GIVEN** waiting with `ctx.human({ timeoutMs: 3600000 })`
- **WHEN** 1 hour passes and deadline expires
- **THEN** Run transitions to `failed` state
- **AND** error reason is `human_timeout`

---

### Requirement: Resume from Human Wait

The system SHALL allow external callers to resume a `waiting_human` Run by `runId`.

- The system MUST provide `durably.resume(runId, payload)`
- The `payload` SHALL include the human input
- The `payload` SHOULD include `decision` (`approved` | `rejected` | `edited`) as a common convention
- The system MUST reject resuming a Run that is not in `waiting_human` state
 - The system MUST return `404` when `runId` does not exist
 - The system MUST return `410` when `wait_deadline_at` has expired

#### Scenario: Resume with input

- **GIVEN** Run is in `waiting_human` state
- **WHEN** `durably.resume(runId, { decision: 'approved' })` is called
- **THEN** Run transitions back to `running` state
- **AND** `ctx.human()` returns the payload and continues
- **AND** `run:resume` event is emitted

#### Scenario: Resume invalid state

- **GIVEN** Run is not in `waiting_human` state
- **WHEN** `resume()` is called
- **THEN** error is raised (HTTP 409)

#### Scenario: Resume invalid runId

- **WHEN** `resume()` is called with non-existent `runId`
- **THEN** error is raised (HTTP 404)

#### Scenario: Resume expired runId

- **GIVEN** `wait_deadline_at` has passed
- **WHEN** `resume()` is called
- **THEN** error is raised (HTTP 410)

---

### Requirement: Human Step Replay

Completed human steps SHALL be skipped when Run is re-executed.

- `ctx.human()` MUST return the saved result immediately if a completed human step exists
- If no completed human step exists, the system SHALL create a new `waiting_human` state

#### Scenario: Replay completed human step

- **GIVEN** `ctx.human()` was previously completed
- **WHEN** Run resumes and reaches the same position
- **THEN** saved `human_payload` is returned immediately
- **AND** Run does NOT enter `waiting_human` state

---

### Requirement: HTTP Resume Endpoint

The system SHALL provide HTTP API to resume `waiting_human` Runs.

- The system MUST provide `POST /resume` endpoint
- On success, the system SHALL return `{ runId, success: true }`

#### Scenario: POST /resume success

- **GIVEN** Run is in `waiting_human` state
- **WHEN** `POST /resume` is called with `{ runId, payload }`
- **THEN** `200 OK` with `{ runId, success: true }` is returned

#### Scenario: GET /runs for waiting_human

- **GIVEN** Run is in `waiting_human` state
- **WHEN** `GET /runs?status=waiting_human` is called
- **THEN** response includes `wait_message`, `wait_schema`, and `wait_deadline_at`

---

## MODIFIED Requirements

### Requirement: Run Status

Run SHALL have `pending`, `running`, `completed`, `failed`, `cancelled`, and `waiting_human` states.

- `pending`: waiting for execution
- `running`: currently executing
- `completed`: successfully completed
- `failed`: execution failed
- `cancelled`: manually cancelled
- `waiting_human`: waiting for human input

#### Scenario: Normal run completion

- **GIVEN** Run is in `pending` state
- **WHEN** Worker picks up and executes the Run
- **THEN** Run transitions `running` → `completed`

#### Scenario: Run failure

- **GIVEN** Run is in `running` state
- **WHEN** an exception occurs in a step
- **THEN** Run transitions to `failed` state
- **AND** error message is recorded

#### Scenario: Run waits for human

- **GIVEN** Run is in `running` state
- **WHEN** `ctx.human()` is called
- **THEN** Run transitions to `waiting_human` state
- **AND** Worker moves on to process next Run
