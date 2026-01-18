# React: HITL Hooks

## ADDED Requirements

### Requirement: Human Waits Hook

The React client SHALL provide a single hook for human waits.

- The system MUST provide `useHumanWaits()` in `@coji/durably-react` (browser mode)
- The system MUST provide `useHumanWaits({ api })` in `@coji/durably-react/client` (server mode)
- The hook SHOULD accept `jobName` to filter waits by job
- The hook SHOULD accept `payloadSchema` to enable type inference and client-side validation
- The hook MUST return `{ waits, isLoading, reload, respond }`
- `respond(runId, payload)` MUST resume the Run with the given payload

#### Scenario: Client mode usage

- **WHEN** `useHumanWaits({ api: '/api/durably' })` is called
- **THEN** the hook returns `waits`, `isLoading`, `reload`, and `respond`
- **AND** `respond(runId, payload)` resumes the Run via `POST /resume`

#### Scenario: Browser mode usage

- **WHEN** `useHumanWaits()` is called without `api`
- **THEN** the hook returns `waits`, `isLoading`, `reload`, and `respond`
- **AND** `respond(runId, payload)` resumes the Run via `durably.resume(runId, payload)`

#### Scenario: Filter waits by job name

- **GIVEN** multiple waits across different jobs
- **WHEN** `useHumanWaits({ api, jobName: 'import-csv' })` is called
- **THEN** only waits for `import-csv` are returned

---

### Requirement: Typed Human Payload

The React client SHALL support type-safe human payloads.

- The hook MUST be generic: `useHumanWaits<TPayload>(options?)`
- When `payloadSchema` is provided, the hook SHOULD infer `TPayload` from the schema
- `respond(runId, payload)` MUST accept `TPayload`

#### Scenario: Typed respond payload

- **GIVEN** `useHumanWaits({ api, payloadSchema: z.object({ decision: z.enum(['approved', 'rejected']) }) })`
- **WHEN** `respond(runId, { decision: 'approved' })` is called
- **THEN** the payload is type-checked by TypeScript
- **AND** invalid payloads fail type-checking

---

### Requirement: Human Waits Hook Factory

The React client SHALL provide a factory for typed human waits hooks.

- The system MUST provide `createHumanWaitsHook({ api?, jobName?, payloadSchema? })`
- The factory MUST return a hook that yields `{ waits, isLoading, reload, respond }`
- The returned hook MUST preserve the inferred `TPayload` from `payloadSchema`

#### Scenario: Create typed waits hook

- **GIVEN** `createHumanWaitsHook({ api, jobName: 'invoice', payloadSchema })`
- **WHEN** the returned hook is used
- **THEN** `respond(runId, payload)` is type-checked against `payloadSchema`

---

### Requirement: WaitingRun Shape

The React client SHALL expose a minimal WaitingRun shape for UI rendering.

- A WaitingRun MUST include `id`, `wait_message`, and `wait_deadline_at`
- A WaitingRun SHOULD include `wait_schema` when available

#### Scenario: Waiting run fields

- **GIVEN** a Run in `waiting_human` state
- **WHEN** it is returned by `useHumanWaits()`
- **THEN** `wait_message` and `wait_deadline_at` are present
- **AND** `wait_schema` is present if stored on the Run
