# RFC: coalesce option for trigger (skip mode)

Issue: #143

## Problem

Webhook-driven workloads can trigger many jobs in rapid succession for the same logical entity. Since the job reads latest state from DB at execution time, intermediate triggers are redundant. Without coalescing, N webhook events create N queued runs. With coalesce, they compress to at most 1 pending + 1 running per `concurrencyKey`.

## Scope

**v1 is skip mode only.** A merge mode (`coalesce: fn` that updates pending input) was considered but deferred — it adds input mutation complexity, PostgreSQL `FOR UPDATE` locking, validation concerns, and new event types, none of which are justified by current use cases. Skip mode covers the primary need.

## API Design

```ts
const { run, coalesced } = await job.trigger(input, {
  concurrencyKey: 'process:org1',
  coalesce: true,
})
```

`coalesce: true` — if a **pending** run with the same `concurrencyKey` already exists, skip creating a new run and return the existing one with `coalesced: true`.

### Behavior matrix

| State                  | `coalesce: false` (default) | `coalesce: true`           |
| ---------------------- | --------------------------- | -------------------------- |
| No pending, no running | Create new run              | Create new run             |
| Running, no pending    | Create new pending          | Create new pending         |
| Pending exists         | Create another pending      | **Skip** (return existing) |

At most 2 runs per `concurrencyKey` exist at any time: 1 running + 1 pending.

### Events

When coalesced (skip), **no `run:trigger` event** is emitted — nothing new happened.

## Type Changes

### `TriggerOptions`

```ts
// packages/durably/src/job.ts
export interface TriggerOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
  coalesce?: boolean
}
```

> `coalesce` requires `concurrencyKey`. Throw a `ValidationError` if `coalesce` is set without `concurrencyKey`.

### Return type change (breaking)

`trigger()` return type changes from `TypedRun` to `{ run: TypedRun, coalesced: boolean }`:

```ts
interface TriggerResult<TOutput, TLabels> {
  run: TypedRun<TOutput, TLabels>
  coalesced: boolean
}
```

`coalesced` lives on the result tuple, not on `Run` itself — Run is a state-machine entity and shouldn't carry creation-context metadata. This is a **breaking change**.

### `TriggerRequest` / `TriggerResponse` (HTTP API)

```ts
// Request: add coalesce field
export interface TriggerRequest<TLabels> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
  coalesce?: boolean
}

// Response: add coalesced field
export interface TriggerResponse {
  runId: string
  coalesced: boolean
}
```

## Implementation Plan

### Step 1: Change `trigger()` return type

**File**: `packages/durably/src/job.ts`

Change `trigger()` to return `{ run: TypedRun, coalesced: boolean }`. This is breaking — all callers need updating.

Update `retrigger()` similarly if it shares the same return path.

### Step 2: Add coalesce logic to `enqueue()` in storage layer

**File**: `packages/durably/src/storage.ts`

No new method needed. Add an optional `coalesce` flag to `CreateRunInput` and handle it inside `enqueue()`:

```ts
async enqueue(input: CreateRunInput): Promise<{ run: Run; coalesced: boolean }> {
  // ... existing idempotency check (runs first, takes priority) ...

  if (input.coalesce && input.concurrencyKey) {
    const pending = await db
      .selectFrom('durably_runs')
      .selectAll()
      .where('job_name', '=', input.jobName)
      .where('concurrency_key', '=', input.concurrencyKey)
      .where('status', '=', 'pending')
      .limit(1)
      .executeTakeFirst()

    if (pending) {
      return { run: rowToRun(pending), coalesced: true }
    }
  }

  // ... existing insert path ...
  return { run: newRun, coalesced: false }
}
```

For SQLite this is naturally serialized. For PostgreSQL, the SELECT is read-only within the enqueue transaction — no `FOR UPDATE` needed since we're not modifying the pending row.

> **Idempotency interaction**: idempotency check runs first (existing behavior). Coalesce only applies if idempotency doesn't match.

### Step 3: Wire up `job.trigger()`

**File**: `packages/durably/src/job.ts`

```ts
async trigger(input: TInput, options?: TriggerOptions<TLabels>) {
  // ... existing validation ...

  if (options?.coalesce && !options.concurrencyKey) {
    throw new ValidationError('coalesce requires concurrencyKey')
  }

  const { run, coalesced } = await storage.enqueue({
    jobName, input: validatedInput,
    concurrencyKey: options?.concurrencyKey,
    idempotencyKey: options?.idempotencyKey,
    labels: options?.labels,
    coalesce: options?.coalesce,
  })

  if (!coalesced) {
    eventEmitter.emit({
      type: 'run:trigger', runId: run.id, jobName,
      input: validatedInput, labels: run.labels,
    })
  }

  return { run: run as TypedRun<TOutput, TLabels>, coalesced }
}
```

### Step 4: Wire up HTTP handler

**File**: `packages/durably/src/server.ts`

Pass `coalesce` from `TriggerRequest` to `job.trigger()`. Return `coalesced` in `TriggerResponse`.

### Step 5: Update callers for new return type

Since `trigger()` now returns `{ run, coalesced }` instead of `TypedRun`, update:

- `retrigger()` — returns `{ run, coalesced: false }` always
- `triggerAndWait()` — destructure internally
- `batchTrigger()` — each item returns `{ run, coalesced }`
- `durably-react` hooks — `useJob` trigger/triggerAndWait
- Server handler — already done in Step 4
- Examples — fullstack-react-router, fullstack-vercel-turso, etc.
- Tests — all existing trigger tests

### Step 6: Tests

**File**: `packages/durably/tests/shared/coalesce.shared.ts` (new, shared across dialects)

Test cases:

1. **no pending run** — creates new run, `coalesced: false`
2. **pending run exists** — returns existing, `coalesced: true`, input unchanged
3. **running + no pending** — creates new pending (running doesn't count)
4. **multiple pending (pre-existing)** — returns one of them, doesn't create new
5. **validation: coalesce without concurrencyKey** — throws `ValidationError`
6. **event: no `run:trigger` on coalesce** — verify event not emitted when coalesced
7. **idempotency + coalesce** — idempotency takes priority
8. **HTTP: skip mode over API** — verify request/response shape
9. **return type** — verify `{ run, coalesced }` structure for both coalesced and non-coalesced

### Step 7: Documentation

- Update `packages/durably/docs/llms.md` — add `coalesce` to trigger options reference
- Regenerate `website/public/llms.txt`

## File Change Summary

| File                                               | Change                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/durably/src/job.ts`                      | Add `coalesce` to `TriggerOptions`, change `trigger()` return type |
| `packages/durably/src/storage.ts`                  | Add `coalesce` to `CreateRunInput`, handle in `enqueue()`          |
| `packages/durably/src/server.ts`                   | Add `coalesce` to `TriggerRequest`/`TriggerResponse`               |
| `packages/durably/src/index.ts`                    | Export `TriggerResult` type                                        |
| `packages/durably-react/src/**`                    | Update for new trigger return type                                 |
| `packages/durably/tests/shared/coalesce.shared.ts` | New: shared test suite                                             |
| `packages/durably/tests/node/coalesce.test.ts`     | New: Node.js SQLite runner                                         |
| `packages/durably/tests/browser/coalesce.test.ts`  | New: Browser WASM runner                                           |
| `packages/durably/tests/**`                        | Update existing tests for new return type                          |
| `examples/**`                                      | Update for new return type                                         |
| `packages/durably/docs/llms.md`                    | Document coalesce option                                           |

## Design Decisions

1. **Skip mode only (v1)** — merge mode deferred. Skip is simpler (read-only check, no input mutation, no `FOR UPDATE`, no new events), covers the primary webhook use case, and leaves room to add merge later with real-world feedback.
2. **Return `{ run, coalesced }` not `TypedRun & { coalesced }`** — Run is a persistent entity; `coalesced` is transient trigger context. Mixing them pollutes the domain model.
3. **No `run:trigger` on coalesce** — nothing was created. Emitting would confuse listeners counting new runs.
4. **Idempotency takes priority over coalesce** — idempotency check runs first in `enqueue()`. If matched, returns existing run regardless of coalesce flag.
5. **No new storage method** — coalesce logic fits as a conditional branch inside `enqueue()`, keeping the storage API surface small.

## Future: merge mode

A merge mode that updates the pending run's input could be added later if needed. Key considerations for that future work:

- Requires `updateRunInput()` in storage layer
- PostgreSQL needs `SELECT ... FOR UPDATE` for atomicity
- Merged input must be re-validated against job schema
- New `run:input-updated` event needed for observability
- Decision needed on `batchTrigger` interaction
