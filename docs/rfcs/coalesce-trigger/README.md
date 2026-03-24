# RFC: coalesce option for trigger

Issue: #143

## Problem

Webhook-driven workloads can trigger many jobs in rapid succession for the same logical entity. Since the job reads latest state from DB at execution time, intermediate triggers are redundant. Without coalescing, N webhook events create N queued runs. With coalesce, they compress to at most 1 pending + 1 running per `concurrencyKey`.

## API Design

### skip mode

```ts
const result = await job.trigger(input, {
  concurrencyKey: 'process:org1',
  coalesce: true,
})
// result: TypedRun (existing pending run if coalesced, new run otherwise)
// result.coalesced: boolean — true if an existing pending run was returned
```

`coalesce: true` — if a **pending** run with the same `concurrencyKey` already exists, skip creating a new run and return the existing one.

### merge mode

```ts
const result = await job.trigger(input, {
  concurrencyKey: 'process:org1',
  coalesce: (pendingInput, newInput) => ({
    organizationId: newInput.organizationId,
    export: pendingInput.export || newInput.export,
    triggerClassify: pendingInput.triggerClassify || newInput.triggerClassify,
  }),
})
```

`coalesce: (pendingInput, newInput) => mergedInput` — if a pending run exists, update its input using the merge function and return it. If no pending run exists, create a new one.

### Behavior matrix

| State                  | `coalesce: true` (skip) | `coalesce: fn` (merge)         |
| ---------------------- | ----------------------- | ------------------------------ |
| No pending, no running | Create new run          | Create new run                 |
| Running, no pending    | Create new pending      | Create new pending             |
| Pending exists         | **Skip** (return as-is) | **Merge** input, return update |

At most 2 runs per `concurrencyKey` exist at any time: 1 running + 1 pending.

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
  coalesce?: boolean | ((pendingInput: TInput, newInput: TInput) => TInput)
}
```

> `coalesce` requires `concurrencyKey`. Throw a validation error if `coalesce` is set without `concurrencyKey`.

### Return type augmentation

The existing `TypedRun` return type gains a `coalesced` field:

```ts
// Option A: Add to TypedRun directly (simpler)
export interface TypedRun<TOutput, TLabels> extends Run<TLabels> {
  output: TOutput | null
  coalesced?: boolean // true when returned from a coalesced trigger
}

// Option B: Separate return type (more explicit)
type TriggerResult<TOutput, TLabels> = TypedRun<TOutput, TLabels> & {
  coalesced: boolean
}
```

**Recommendation**: Option A. Adding an optional `coalesced` field keeps the return type backward-compatible. It defaults to `undefined` (falsy) for normal triggers.

### `TriggerRequest` / `TriggerResponse` (HTTP API)

```ts
// Request: add coalesce field
export interface TriggerRequest<TLabels> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
  coalesce?: boolean // merge mode not supported over HTTP (function not serializable)
}

// Response: add coalesced field
export interface TriggerResponse {
  runId: string
  coalesced: boolean
}
```

> Merge mode (`coalesce: fn`) is only available in the programmatic API, not HTTP. The HTTP API supports only skip mode (`coalesce: true`).

## Implementation Plan

### Step 1: Add `updateRunInput()` to storage layer

Currently `input` is immutable after `enqueue()`. Add a method to update it:

**File**: `packages/durably/src/storage.ts`

```ts
async updateRunInput(runId: string, input: unknown): Promise<void> {
  const now = new Date().toISOString()
  await db
    .updateTable('durably_runs')
    .set({ input: JSON.stringify(input), updated_at: now })
    .where('id', '=', runId)
    .where('status', '=', 'pending')  // safety: only pending runs
    .execute()
}
```

No schema migration needed — `input` column already exists.

### Step 2: Add `enqueueCoalesced()` to storage layer

**File**: `packages/durably/src/storage.ts`

```ts
async enqueueCoalesced(
  input: CreateRunInput,
  coalesce: true | ((pendingInput: unknown, newInput: unknown) => unknown),
): Promise<{ run: Run; coalesced: boolean }>
```

Logic (within a transaction for atomicity):

```
BEGIN TRANSACTION
1. SELECT * FROM durably_runs
     WHERE concurrency_key = :key AND status = 'pending' AND job_name = :jobName
     LIMIT 1

2a. If found AND coalesce === true:
      return { run: existing, coalesced: true }

2b. If found AND coalesce is function:
      mergedInput = coalesce(JSON.parse(existing.input), newInput)
      UPDATE durably_runs SET input = :mergedInput WHERE id = :existingId
      return { run: updated, coalesced: true }

3.  If not found:
      INSERT new run (same as normal enqueue)
      return { run: newRun, coalesced: false }
COMMIT
```

SQLite serializes writes so the transaction is naturally atomic. PostgreSQL may need `SELECT ... FOR UPDATE` on the pending row to prevent concurrent merges.

### Step 3: Wire up `job.trigger()`

**File**: `packages/durably/src/job.ts`

In the `trigger()` method:

```ts
async trigger(input: TInput, options?: TriggerOptions<TLabels>) {
  // ... existing validation ...

  if (options?.coalesce) {
    if (!options.concurrencyKey) {
      throw new ValidationError('coalesce requires concurrencyKey')
    }
    const { run, coalesced } = await storage.enqueueCoalesced(
      { jobName, input: validatedInput, concurrencyKey: options.concurrencyKey, labels: options.labels },
      options.coalesce,
    )
    if (!coalesced) {
      eventEmitter.emit({ type: 'run:trigger', runId: run.id, jobName, input: validatedInput, labels: run.labels })
    }
    return Object.assign(run as TypedRun<TOutput, TLabels>, { coalesced })
  }

  // ... existing enqueue path (unchanged) ...
}
```

> When coalesced (skip or merge), do NOT emit `run:trigger` — no new run was created. For merge mode, consider emitting a new event `run:coalesce` if observability is needed.

### Step 4: Wire up HTTP handler

**File**: `packages/durably/src/server.ts`

Pass `coalesce` from `TriggerRequest` to `job.trigger()`. Return `coalesced` in response.

### Step 5: Add `batchTrigger` support (optional, can defer)

`batchTrigger()` could accept `coalesce` in per-item options. This is more complex (batch coalescing within the same batch) and can be deferred to a follow-up.

### Step 6: Tests

**File**: `packages/durably/tests/shared/coalesce.shared.ts` (new, shared across dialects)

Test cases:

1. **skip: no pending run** — creates new run, `coalesced: false`
2. **skip: pending run exists** — returns existing, `coalesced: true`, input unchanged
3. **skip: running + no pending** — creates new pending (running doesn't count)
4. **merge: no pending run** — creates new run, `coalesced: false`
5. **merge: pending run exists** — updates input, returns same run ID, `coalesced: true`
6. **merge: running + pending** — merges into the pending one
7. **merge: verify merged input** — assert merge function output is persisted correctly
8. **validation: coalesce without concurrencyKey** — throws `ValidationError`
9. **event: no `run:trigger` on coalesce** — verify event not emitted when coalesced
10. **HTTP: skip mode over API** — verify `TriggerRequest` with `coalesce: true` works
11. **HTTP: response includes `coalesced`** — verify `TriggerResponse` shape

### Step 7: Documentation

- Update `packages/durably/docs/llms.md` — add coalesce to trigger options reference
- Regenerate `website/public/llms.txt`

## File Change Summary

| File                                               | Change                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/durably/src/job.ts`                      | Add `coalesce` to `TriggerOptions`, wire up in `trigger()`         |
| `packages/durably/src/storage.ts`                  | Add `updateRunInput()`, `enqueueCoalesced()`                       |
| `packages/durably/src/claim-sqlite.ts`             | No changes needed                                                  |
| `packages/durably/src/claim-postgres.ts`           | Possibly `FOR UPDATE` in coalesce query                            |
| `packages/durably/src/server.ts`                   | Add `coalesce` to `TriggerRequest`/`TriggerResponse`, pass through |
| `packages/durably/src/index.ts`                    | Export new types if any                                            |
| `packages/durably/tests/shared/coalesce.shared.ts` | New: shared test suite                                             |
| `packages/durably/tests/node/coalesce.test.ts`     | New: Node.js SQLite runner                                         |
| `packages/durably/tests/browser/coalesce.test.ts`  | New: Browser WASM runner                                           |
| `packages/durably/docs/llms.md`                    | Document coalesce option                                           |

## Open Questions

1. **Event for merge mode**: Should we emit `run:coalesce` when a merge happens? This would help with observability but adds a new event type.
2. **`batchTrigger` support**: Defer or include in this PR? Batch + coalesce interaction (multiple items in same batch targeting same concurrencyKey) adds complexity.
3. **Race condition in PostgreSQL merge mode**: Need `SELECT ... FOR UPDATE` to prevent two concurrent merges from reading the same pending input. SQLite is safe due to write serialization.
4. **Idempotency key interaction**: If both `idempotencyKey` and `coalesce` are set, which takes priority? Proposed: idempotency check runs first (existing behavior), coalesce only applies if idempotency check doesn't match.
