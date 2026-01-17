# Core: Streaming v2 Extension

## ADDED Requirements

### Requirement: Streaming Step

The system SHALL provide `step.stream()` for token-level streaming output.

- The system MUST accept an async function with `emit` callback
- The `emit` callback SHALL send intermediate data without persistence
- The step's return value MUST be persisted as with regular `step.run()`
- Completed streaming steps SHALL be skipped on replay

#### Scenario: Stream tokens to subscriber

- **WHEN** `step.stream('generate', async (emit) => { emit({ text: 'hello' }); return 'done' })` is called
- **THEN** `stream` events are emitted with `{ text: 'hello' }`
- **AND** step completes with output `'done'`

#### Scenario: Streaming step replay

- **GIVEN** `step.stream('generate', fn)` was previously completed
- **WHEN** Run resumes and reaches the same step
- **THEN** saved output is returned immediately
- **AND** `fn` is NOT re-executed

---

### Requirement: Event Persistence

The system SHALL persist coarse-grained events for reconnection support.

- Events `run:*`, `step:*`, `run:progress`, `log:write` MUST be persisted
- `stream` events SHALL NOT be persisted (memory only)
- Each event MUST have a `sequence` number for ordering

#### Scenario: Persist step events

- **WHEN** a step completes
- **THEN** `step:complete` event is saved to `events` table
- **AND** event has `sequence` number

#### Scenario: Stream events not persisted

- **WHEN** `emit()` is called in `step.stream()`
- **THEN** `stream` event is delivered to subscribers
- **AND** event is NOT saved to database

---

### Requirement: Subscribe with Resume

The system SHALL support reconnection by replaying persisted events.

- `subscribe(runId, { resumeFrom })` MUST return events after the given sequence
- Persisted events SHALL be fetched from database first
- Live events SHALL be streamed after replay completes

#### Scenario: Reconnect and replay events

- **GIVEN** Run has events with sequence 1-10
- **WHEN** `subscribe(runId, { resumeFrom: 5 })` is called
- **THEN** events 6-10 are replayed from database
- **AND** new events are streamed in real-time

---

## MODIFIED Requirements

### Requirement: Run Subscription

Run subscription SHALL support reconnection with `resumeFrom` option.

- `subscribe` returns `ReadableStream<DurablyEvent>`
- Stream auto-closes on `run:complete` or `run:fail`
- The `resumeFrom` option SHALL replay events after the given sequence

#### Scenario: Subscribe to run events

- **GIVEN** Run is executing
- **WHEN** `durably.subscribe(runId)` is called
- **THEN** event stream is returned
- **AND** `step:start`, `step:complete` events are delivered

#### Scenario: Subscribe with resumeFrom

- **GIVEN** Run has persisted events
- **WHEN** `durably.subscribe(runId, { resumeFrom: 5 })` is called
- **THEN** events after sequence 5 are replayed first
- **AND** live events follow
