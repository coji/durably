# ADR-0012: Run-authorized HTTP durable waits

## Status

accepted

## Context

ADR-0010 introduced durable waits through a direct API. A separate CI poller or local input client otherwise has to recreate HTTP routing, wait ownership checks, and idempotent response handling. A wait ID identifies a persisted address but cannot establish permission to read or change it. SSE notifications can also be missed during reconnect.

## Decision

Expose wait list, single-wait read, and signal routes through the existing HTTP handler. Every route requires a run ID and checks `onRunAccess` against that run before accessing a wait. Single-wait routes additionally check that the wait belongs to the authorized run. Authenticated handlers require an `onRunAccess` hook for these routes. Applications can reject invalid business payloads through `onSignal` before persistence.

Signal persistence reports `accepted` or `duplicate` from the same transaction that chooses the first result. A same-ID, same-JSON retry receives the original receipt. A different input returns conflict; a fixed deadline produces an expired response while retaining the timeout outcome. The direct `durably.signal()` return type remains a `DurableWait` to preserve its existing contract; the HTTP response adds disposition.

Persisted run and wait reads are authoritative after reconnect. A client reads both to recover waiting and finalized outcome state, even if it missed a live event or the run has not yet acquired a new worker lease. This decision adds no wait-specific event stream.

## Consequences

- HTTP callers can use the same run ownership or label policy as existing run routes; a wait ID alone grants no access.
- Applications remain responsible for CI commit identity, approval policy, credentials, and payload schemas.
- The handler distinguishes accepted, duplicate, conflicting, expired, and missing signals without a public webhook.
- Clients must re-read saved state on reconnect because events are not a durable delivery queue.

## Rejected Alternatives

### Authorize directly by wait ID

Knowing an address would grant access across tenants without checking the owning run.

### Add a wait-specific SSE replay log

Saved wait reads already recover missed state, and another event log would introduce delivery and retention rules unrelated to the input contract.

### Change the direct signal return type

Existing callers receive a `DurableWait`; changing it for an HTTP-only need would create avoidable migration work.
