# RFC: coalesce option for trigger (skip mode)

Issue: #143

## Problem

Webhook-driven workloads can trigger many jobs in rapid succession for the same logical entity. Since the job reads latest state from DB at execution time, intermediate triggers are redundant. Without coalescing, N webhook events create N queued runs. With coalesce, they compress to at most 1 pending + 1 running per `concurrencyKey`.

## Scope

**v1 is skip mode only.** A merge mode (`coalesce: fn` that updates pending input) was considered but deferred — it adds input mutation complexity, PostgreSQL `FOR UPDATE` locking, validation concerns, and new event types, none of which are justified by current use cases. Skip mode covers the primary need.

## API Design

```ts
const run = await job.trigger(input, {
  concurrencyKey: 'process:org1',
  coalesce: 'skip',
})
```

`coalesce: 'skip'` — if a **pending** run with the same `concurrencyKey` and `jobName` already exists, skip creating a new run and return the existing one.

`trigger()` return type does **not** change. It still returns `TypedRun`. Callers who need to distinguish "created" vs "coalesced" use the new `triggerDetailed()` method (see below).

### `triggerDetailed()` — additive API

```ts
const { run, disposition } = await job.triggerDetailed(input, {
  concurrencyKey: 'process:org1',
  coalesce: 'skip',
})
// disposition: 'created' | 'idempotent' | 'coalesced'
```

This is additive — no breaking changes. `trigger()` delegates to `triggerDetailed()` internally and returns only `run`.

### Behavior matrix

| State                  | No coalesce (default)  | `coalesce: 'skip'`         |
| ---------------------- | ---------------------- | -------------------------- |
| No pending, no running | Create new run         | Create new run             |
| Running, no pending    | Create new pending     | Create new pending         |
| Pending exists         | Create another pending | **Skip** (return existing) |

At most 2 runs per `concurrencyKey` exist at any time: 1 running + 1 pending.

### Why `'skip'` not `true`

Using a string union instead of boolean leaves room for future modes (e.g. `'merge'`) without a breaking API change. This follows patterns in BullMQ (deduplication object), Temporal (WorkflowIdReusePolicy enum), and Inngest (separate debounce/idempotency).

### Events

When coalesced (skip), emit a **`run:coalesced`** event (lightweight, for observability). Do **not** emit `run:trigger` — nothing was created.

> **Note**: The current codebase emits `run:trigger` even on idempotency hits. This is an existing inconsistency that should be addressed separately — coalesce should not inherit it.

### Semantic caveats (must be documented)

- **Input is ignored on coalesce**: The returned run carries the **original** pending input, not the new input passed to `trigger()`. This is by design — skip mode means "don't create, return what's already there." Callers using `triggerAndWait()` with coalesce will wait for the result of the _original_ input.
- **Labels are ignored on coalesce**: Similarly, the existing run's labels are returned, not the new ones. If label-sensitive routing is needed, don't use coalesce.

## Type Changes

### `TriggerOptions`

```ts
export interface TriggerOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
  coalesce?: 'skip' // string union, extensible for future modes
}
```

> `coalesce` requires `concurrencyKey`. Throw a `ValidationError` if `coalesce` is set without `concurrencyKey`.

### `TriggerDetailedResult`

```ts
type Disposition = 'created' | 'idempotent' | 'coalesced'

interface TriggerDetailedResult<TOutput, TLabels> {
  run: TypedRun<TOutput, TLabels>
  disposition: Disposition
}
```

### `TriggerRequest` / `TriggerResponse` (HTTP API)

```ts
export interface TriggerRequest<TLabels> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
  coalesce?: 'skip'
}

export interface TriggerResponse {
  runId: string
  disposition: 'created' | 'idempotent' | 'coalesced'
}
```

> `TriggerResponse` gains `disposition`. For backward compatibility, `runId` remains the primary field. Clients that don't care about disposition can ignore it.

## Implementation Plan

### Step 1: Schema migration — partial unique index

**File**: `packages/durably/src/migrations.ts`

Add migration v2 with a partial unique index to guarantee at most 1 pending run per `(job_name, concurrency_key)`:

```sql
-- SQLite
CREATE UNIQUE INDEX idx_durably_runs_pending_concurrency
  ON durably_runs (job_name, concurrency_key)
  WHERE status = 'pending' AND concurrency_key IS NOT NULL;

-- PostgreSQL
CREATE UNIQUE INDEX idx_durably_runs_pending_concurrency
  ON durably_runs (job_name, concurrency_key)
  WHERE status = 'pending' AND concurrency_key IS NOT NULL;
```

This makes coalesce atomic at the DB level — INSERT will fail with a unique constraint violation if a pending run already exists, and we catch the conflict to return the existing run. No application-level race conditions on either SQLite or PostgreSQL.

> **Important**: This index applies only when `concurrency_key IS NOT NULL`. Runs without a concurrency key are unaffected. Existing data must be checked — if multiple pending runs already share a concurrency key, the migration must resolve them (e.g. cancel duplicates) before creating the index.

### Step 2: Internal `disposition` in storage layer

**File**: `packages/durably/src/storage.ts`

Change `enqueue()` return type internally to `{ run: Run; disposition: Disposition }`:

```ts
type Disposition = 'created' | 'idempotent' | 'coalesced'

async enqueue(input: CreateRunInput): Promise<{ run: Run; disposition: Disposition }> {
  // 1. Idempotency check (existing behavior, now returns disposition)
  if (input.idempotencyKey) {
    const existing = await db
      .selectFrom('durably_runs').selectAll()
      .where('job_name', '=', input.jobName)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst()
    if (existing) {
      return { run: rowToRun(existing), disposition: 'idempotent' }
    }
  }

  // 2. Coalesce check
  if (input.coalesce === 'skip' && input.concurrencyKey) {
    const pending = await db
      .selectFrom('durably_runs').selectAll()
      .where('job_name', '=', input.jobName)
      .where('concurrency_key', '=', input.concurrencyKey)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'asc')  // deterministic: oldest first
      .limit(1)
      .executeTakeFirst()
    if (pending) {
      return { run: rowToRun(pending), disposition: 'coalesced' }
    }
  }

  // 3. INSERT — if coalesce is active, catch unique constraint violation
  //    (race condition fallback for PostgreSQL concurrent inserts)
  try {
    // ... existing insert path ...
    return { run: newRun, disposition: 'created' }
  } catch (err) {
    if (input.coalesce === 'skip' && isUniqueViolation(err)) {
      // Another concurrent trigger won the INSERT — fetch the winner
      const pending = await db
        .selectFrom('durably_runs').selectAll()
        .where('job_name', '=', input.jobName)
        .where('concurrency_key', '=', input.concurrencyKey!)
        .where('status', '=', 'pending')
        .orderBy('created_at', 'asc')
        .limit(1)
        .executeTakeFirstOrThrow()
      return { run: rowToRun(pending), disposition: 'coalesced' }
    }
    throw err
  }
}
```

### Step 3: Add `triggerDetailed()` and wire up `trigger()`

**File**: `packages/durably/src/job.ts`

```ts
async triggerDetailed(
  input: TInput,
  options?: TriggerOptions<TLabels>,
): Promise<TriggerDetailedResult<TOutput, TLabels>> {
  // ... existing validation ...

  if (options?.coalesce && !options.concurrencyKey) {
    throw new ValidationError('coalesce requires concurrencyKey')
  }

  const { run, disposition } = await storage.enqueue({
    jobName, input: validatedInput,
    concurrencyKey: options?.concurrencyKey,
    idempotencyKey: options?.idempotencyKey,
    labels: options?.labels,
    coalesce: options?.coalesce,
  })

  if (disposition === 'created') {
    eventEmitter.emit({
      type: 'run:trigger', runId: run.id, jobName,
      input: validatedInput, labels: run.labels,
    })
  } else if (disposition === 'coalesced') {
    eventEmitter.emit({
      type: 'run:coalesced', runId: run.id, jobName,
      input: validatedInput, labels: run.labels,
    })
  }

  return { run: run as TypedRun<TOutput, TLabels>, disposition }
}

// trigger() delegates — no breaking change
async trigger(
  input: TInput,
  options?: TriggerOptions<TLabels>,
): Promise<TypedRun<TOutput, TLabels>> {
  const { run } = await this.triggerDetailed(input, options)
  return run
}
```

### Step 4: Wire up HTTP handler

**File**: `packages/durably/src/server.ts`

- Add `coalesce` to `TriggerRequest`
- Call `job.triggerDetailed()` internally
- Return `disposition` in `TriggerResponse`

### Step 5: Add `run:coalesced` event type

**File**: `packages/durably/src/events.ts`

```ts
export interface RunCoalescedEvent extends BaseEvent {
  type: 'run:coalesced'
  runId: string // ID of the existing pending run
  jobName: string
  input: unknown // the new (skipped) input, for logging/audit
  labels: Record<string, string>
}
```

### Step 6: Tests

**File**: `packages/durably/tests/shared/coalesce.shared.ts` (new, shared across dialects)

Test cases:

1. **no pending run** — creates new run, disposition `'created'`
2. **pending run exists** — returns existing, disposition `'coalesced'`, original input preserved
3. **running + no pending** — creates new pending (running doesn't count)
4. **multiple pending (pre-existing before index)** — returns oldest
5. **concurrent insert race** — two triggers at once, only 1 pending created (partial unique index catches the second)
6. **validation: coalesce without concurrencyKey** — throws `ValidationError`
7. **event: `run:coalesced` emitted, `run:trigger` not emitted**
8. **event: `run:trigger` emitted on normal create**
9. **idempotency + coalesce** — idempotency takes priority, disposition `'idempotent'`
10. **labels ignored on coalesce** — existing run's labels returned
11. **HTTP: `coalesce: 'skip'` in request** — verify response includes `disposition`
12. **trigger() returns TypedRun** — no breaking change, disposition not exposed
13. **triggerDetailed() returns disposition** — verify full result shape
14. **batchTrigger with coalesce** — same concurrencyKey items in batch, first wins

### Step 7: `batchTrigger` support

Coalesce applies per-item in `batchTrigger()`. Within a single batch, items with the same `concurrencyKey + coalesce: 'skip'` should deduplicate against each other: first item creates, subsequent items coalesce to it. The partial unique index handles this naturally when items are inserted sequentially within the transaction.

### Step 8: Documentation

- Update `packages/durably/docs/llms.md` — add `coalesce` to trigger options, document `triggerDetailed()`, document semantic caveats
- Regenerate `website/public/llms.txt`

## File Change Summary

| File                                               | Change                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/durably/src/migrations.ts`               | Add v2 migration: partial unique index                                   |
| `packages/durably/src/job.ts`                      | Add `coalesce` to `TriggerOptions`, add `triggerDetailed()`              |
| `packages/durably/src/storage.ts`                  | Add `disposition` to `enqueue()` return, coalesce logic + conflict catch |
| `packages/durably/src/events.ts`                   | Add `RunCoalescedEvent` type                                             |
| `packages/durably/src/server.ts`                   | Add `coalesce` to request, `disposition` to response                     |
| `packages/durably/src/index.ts`                    | Export `TriggerDetailedResult`, `Disposition`                            |
| `packages/durably/tests/shared/coalesce.shared.ts` | New: shared test suite                                                   |
| `packages/durably/tests/node/coalesce.test.ts`     | New: Node.js SQLite runner                                               |
| `packages/durably/tests/browser/coalesce.test.ts`  | New: Browser WASM runner                                                 |
| `packages/durably/docs/llms.md`                    | Document coalesce, triggerDetailed, caveats                              |

## Design Decisions

1. **Skip mode only (v1)** — merge mode deferred. Skip is read-only (no input mutation, no `FOR UPDATE`), covers the primary webhook use case, and leaves room to add merge later with real-world feedback.

2. **`coalesce: 'skip'` not `true`** — string union is extensible for future modes (`'merge'`, etc.) without breaking the API. Follows patterns in BullMQ, Temporal, and Inngest.

3. **Additive API: `triggerDetailed()` not breaking `trigger()`** — opt-in feature should not break all existing callers. `trigger()` return type is unchanged; `triggerDetailed()` adds disposition info for callers who need it.

4. **Internal `disposition` model** — `enqueue()` returns `disposition: 'created' | 'idempotent' | 'coalesced'`, unifying the information model across idempotency and coalesce. This also surfaces the existing idempotency hit (which currently has no return signal).

5. **Partial unique index for atomicity** — `UNIQUE (job_name, concurrency_key) WHERE status = 'pending' AND concurrency_key IS NOT NULL` guarantees at most 1 pending per concurrency key at the DB level. No application-level race conditions. Works on both SQLite and PostgreSQL.

6. **Idempotency takes priority over coalesce** — idempotency check runs first in `enqueue()`. If matched, returns disposition `'idempotent'` regardless of coalesce flag.

7. **`run:coalesced` event for observability** — silent coalescing during webhook storms is hard to debug. A lightweight event helps monitoring without confusing run-counting listeners (unlike re-emitting `run:trigger`).

8. **Oldest pending returned** — `ORDER BY created_at ASC` ensures deterministic selection. Unordered `LIMIT 1` is avoided.

9. **Input and labels ignored on coalesce** — explicitly documented. The existing pending run is returned as-is. This is inherent to skip mode.

## Future: merge mode

A merge mode that updates the pending run's input could be added later if needed. Key considerations for that future work:

- `coalesce: 'merge'` with a merge function in a separate option (e.g. `coalesceMerge: fn`)
- Requires `updateRunInput()` in storage layer
- PostgreSQL needs `SELECT ... FOR UPDATE` for atomicity
- Merged input must be re-validated against job schema
- `run:coalesced` event would carry the merged input
- Decision needed on `batchTrigger` interaction within a single batch
