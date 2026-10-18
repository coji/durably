# ADR-0036: Fail-closed HTTP run subscriptions

## Status

accepted

## Context

The HTTP handler accepts application authentication and authorization hooks. It previously skipped configured hooks when `authenticate` returned `undefined`, although a void-valued context is a valid return type. The global `/runs/subscribe` stream could then proceed with client-selected filters, or with a `scopeRuns` fallback that dropped status and pagination restrictions. Empty allowed-job arrays also meant unrestricted access. A coalesced event mixed the existing run's labels with a different trigger's skipped input and labels, so filtering only on the run's labels could disclose the other trigger's data.

## Decision

Invoke every configured authorization hook after `authenticate` returns successfully, regardless of the context value. Authentication implementations must throw a `Response` to reject a request. Treat explicit empty job or status sets as matching no runs or stream events.

For an authenticated global HTTP subscription, require a server-derived stream scope. If `onRunAccess` is configured, require `scopeRunsSubscribe` explicitly because a run-level policy may be narrower than a list filter. Without `onRunAccess`, `scopeRuns` may serve as a fallback only when its returned filter contains conditions the stream can enforce. Reject unsupported conditions and malformed hook results before opening the stream. A public handler without `auth` retains its existing client-filtered subscription behavior.

The HTTP `run:coalesced` projection includes the selected run's identity, status, and labels but omits the incoming trigger's `skippedInput` and `skippedLabels`. The in-process event retains those fields for trusted application listeners. Per-run `/subscribe` does not deliver coalesced events.

## Consequences

Authenticated deployments that relied on an unscoped global stream must configure an explicit stream scope. An authenticated `scopeRuns` fallback that includes status, limit, or offset now rejects the subscription until the application defines a representable `scopeRunsSubscribe` policy. Explicit empty scopes deny access instead of widening it. HTTP clients can still follow coalesced run identity and status, but cannot inspect discarded trigger payloads through SSE. Applications must include tenant identity in concurrency keys when coalescing must not cross tenant boundaries.

## Rejected Alternatives

### Infer global stream access from `onRunAccess` for each event

A synchronous event subscription cannot safely await an arbitrary asynchronous per-run policy before delivery without changing ordering and resource behavior. Explicit stream scoping makes the authorization boundary visible to the application.

### Add status and pagination to the stream filter

Run events do not all carry a status, and pagination has no stable meaning for an unbounded live stream. Silently translating those list predicates would be incomplete.

### Remove discarded input and labels from in-process events

Trusted application listeners use these fields to observe coalesced work. The leak occurs at the HTTP projection, so the internal event contract remains unchanged.
