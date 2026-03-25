# RFC: coalesce trigger + concurrencyKey pending limit

Issue: #143

## Problem

Webhook-driven workloads can trigger many jobs in rapid succession for the same logical entity. Since the job reads latest state from DB at execution time, intermediate triggers are redundant. Without coalescing, N webhook events create N queued runs — all executing sequentially but wastefully.

## Scope

Two breaking changes + one new feature in one release (pre-v1, v0.14.0):

1. **concurrencyKey enforces max 1 pending** — partial unique index, ConflictError on violation (breaking)
2. **trigger() returns `TriggerResult`** — `TypedRun & { disposition }`, no destructuring needed (breaking)
3. **coalesce: 'skip'** — opt-in graceful handling of the pending limit (new feature, additive)

## Design

### concurrencyKey semantic change

`concurrencyKey` now enforces **at most 1 running + 1 pending** per `(jobName, concurrencyKey)`.

Previously, `concurrencyKey` only serialized execution — unlimited pending runs could accumulate. This changes: attempting to create a 2nd pending run with the same `concurrencyKey` now throws `ConflictError`.

```ts
await job.trigger(input, { concurrencyKey: 'org:1' }) // OK: creates pending
await job.trigger(input, { concurrencyKey: 'org:1' }) // ConflictError: pending already exists
```

This is enforced at the DB level via a partial unique index. No application-level race conditions.

> Runs without `concurrencyKey` are unaffected — they can accumulate freely as before.

### Interaction with `releaseExpiredLeases`

The current `releaseExpiredLeases()` resets expired leased runs back to `status = 'pending'`. With the new partial unique index, this creates a potential conflict:

1. Run A: `pending` → `leased` (index entry removed)
2. Run B: `trigger()` creates new `pending` with same concurrencyKey (index entry added)
3. Run A: lease expires → `releaseExpiredLeases` tries to set `status = 'pending'` → **unique index violation!**

**Solution**: `releaseExpiredLeases()` must switch from a single bulk UPDATE to a **2-phase approach**. A single bulk UPDATE would fail entirely if even one row hits the unique index, preventing all other expired leases from being released.

Phase 1: Identify expired leases that **would conflict** (another pending run exists with the same concurrencyKey) and mark them as `failed` with error "lease expired, pending run already exists".

Phase 2: Reset remaining expired leases to `pending` **per-row with SAVEPOINT**, catching any unique index violations that occur due to concurrent `trigger()` calls inserting a pending run between Phase 1 and Phase 2.

```ts
async releaseExpiredLeases(now: string): Promise<number> {
  // Phase 1: fail expired leases that have a pending replacement (snapshot-based)
  const conflicting = await db
    .updateTable('durably_runs')
    .set({ status: 'failed', error: 'Lease expired; pending run already exists', ... })
    .where('status', '=', 'leased')
    .where('lease_expires_at', '<=', now)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('durably_runs as other')
          .where('other.job_name', '=', sql.ref('durably_runs.job_name'))
          .where('other.concurrency_key', '=', sql.ref('durably_runs.concurrency_key'))
          .where('other.status', '=', 'pending')
          .where('other.id', '<>', sql.ref('durably_runs.id'))
      )
    )
    .executeTakeFirst()

  // Phase 2: reset remaining expired leases per-row.
  // A concurrent trigger() may have inserted a pending run between Phase 1 and now,
  // so each UPDATE is wrapped in SAVEPOINT. On unique violation, mark as failed.
  const remaining = await db
    .selectFrom('durably_runs').select('id')
    .where('status', '=', 'leased')
    .where('lease_expires_at', '<=', now)
    .execute()

  let count = Number(conflicting.numUpdatedRows)
  for (const row of remaining) {
    try {
      await sql`SAVEPOINT sp_release`.execute(db)
      await db.updateTable('durably_runs')
        .set({ status: 'pending', lease_owner: null, lease_expires_at: null, ... })
        .where('id', '=', row.id)
        .execute()
      await sql`RELEASE SAVEPOINT sp_release`.execute(db)
      count++
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT sp_release`.execute(db)
      // Unique violation — a pending run was inserted concurrently. Fail this lease.
      await db.updateTable('durably_runs')
        .set({ status: 'failed', error: 'Lease expired; pending run already exists', ... })
        .where('id', '=', row.id)
        .execute()
      count++
    }
  }
  return count
}
```

This handles the race where `trigger()` inserts a pending run between Phase 1 and Phase 2.

> `cancelRun()` is unaffected: cancelled runs have `status = 'cancelled'`, which is outside the partial index condition.

### coalesce: 'skip' — graceful skip

`coalesce: 'skip'` opts in to graceful handling: instead of throwing ConflictError, return the existing pending run.

```ts
const run = await job.trigger(input, {
  concurrencyKey: 'org:1',
  coalesce: 'skip',
})
if (run.disposition === 'coalesced') {
  logger.debug(`coalesced into existing run ${run.id}`)
}
```

### trigger() return type

`trigger()` now returns `TriggerResult` — an extension of `TypedRun` with a `disposition` field:

```ts
type Disposition = 'created' | 'idempotent' | 'coalesced'

type TriggerResult<TOutput, TLabels> = TypedRun<TOutput, TLabels> & {
  disposition: Disposition
}
```

**No destructuring required.** Existing code that treats the return value as a Run continues to work — `run.id`, `run.status`, etc. are all available directly. `disposition` is an additional property on the return value only; it does not exist on the persisted `Run` type.

```ts
// Works like before (disposition is just there if you want it)
const run = await job.trigger(input)
console.log(run.id, run.status)

// Check disposition when needed
if (run.disposition === 'coalesced') { ... }
```

This also surfaces idempotency hits: previously `trigger()` with a matching `idempotencyKey` silently returned the existing run. Now it returns `disposition: 'idempotent'`.

> **Migration note**: This is a breaking change. However, since `TriggerResult` extends `TypedRun`, most existing code that reads Run properties (e.g. `run.id`, `run.status`) works without changes. The TypeScript compiler will NOT flag all call sites — `TriggerResult` is assignable to `TypedRun` in many contexts. Callers that explicitly type their variables as `TypedRun` or pass the result to functions expecting `TypedRun` will still work. The main impact is on code that spreads or serializes the return value (the extra `disposition` field will be included).

### Behavior matrix

| State                  | No coalesce        | `coalesce: 'skip'`         |
| ---------------------- | ------------------ | -------------------------- |
| No pending, no running | Create new run     | Create new run             |
| Running, no pending    | Create new pending | Create new pending         |
| Pending exists         | **ConflictError**  | **Skip** (return existing) |

### Why `'skip'` not `true`

String union is extensible for future modes (e.g. `'merge'`) without a breaking API change. Follows patterns in BullMQ (deduplication object), Temporal (WorkflowIdReusePolicy enum), and Inngest (separate debounce/idempotency).

### Events

- `disposition: 'created'` → emit `run:trigger` (existing behavior)
- `disposition: 'coalesced'` → emit `run:coalesced` (new, for observability)
- `disposition: 'idempotent'` → no event (**behavior change**: current code emits `run:trigger` even on idempotency hits — this is fixed as part of the disposition model)

`run:coalesced` carries both the **skipped input** and **skipped labels** (i.e. what the caller passed, not the existing run's data), enabling complete audit logging of what was deduplicated.

### Semantic caveats (must be documented)

- **Input is ignored on coalesce**: The returned run carries the **original** pending input, not the new input. This is by design — skip mode means "don't create, return what's already there." Callers using `triggerAndWait()` with coalesce will wait for the result of the _original_ input. The caller can detect this via `disposition: 'coalesced'`.
- **Labels are ignored on coalesce**: Similarly, the existing run's labels are returned. If label-sensitive routing is needed, don't use coalesce.

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

> `coalesce` requires `concurrencyKey`. Throw `ValidationError` if `coalesce` is set without `concurrencyKey`.

### `TriggerResult`

```ts
type Disposition = 'created' | 'idempotent' | 'coalesced'

type TriggerResult<TOutput, TLabels> = TypedRun<TOutput, TLabels> & {
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
  disposition: Disposition
}
```

## Implementation Plan

### Step 1: Schema migration — partial unique index

**File**: `packages/durably/src/migrations.ts`

Add the partial unique index to the existing **v1 migration** (not a new v2). Since the only production user is upflow and it's pre-v1, we consolidate into v1 and have upflow recreate their database.

```sql
-- Added to the end of migration v1
CREATE UNIQUE INDEX idx_durably_runs_pending_concurrency
  ON durably_runs (job_name, concurrency_key)
  WHERE status = 'pending' AND concurrency_key IS NOT NULL;
```

Works on both SQLite and PostgreSQL. `LATEST_SCHEMA_VERSION` stays at `1`.

> **Why v1 consolidation?** The only production user (upflow) will recreate their database. No incremental migration is needed. This keeps the migration system simple — a single v1 that creates the full schema.

### Step 2: Internal `disposition` in storage layer

**File**: `packages/durably/src/storage.ts`

Change `enqueue()` return type to `{ run: Run; disposition: Disposition }`:

```ts
type Disposition = 'created' | 'idempotent' | 'coalesced'

/**
 * Identify which unique constraint was violated.
 * Required because both idempotency and pending-concurrency use unique indexes.
 * Without this, an idempotency race could be misclassified as a concurrency conflict.
 *
 * PostgreSQL: SQLSTATE '23505' + constraint/index name from error object
 * SQLite/libsql: SQLITE_CONSTRAINT_UNIQUE + column names in error message
 *   (SQLite does NOT include index names — only column names like
 *    "UNIQUE constraint failed: durably_runs.job_name, durably_runs.concurrency_key")
 */
function parseUniqueViolation(
  err: unknown,
): 'idempotency' | 'pending_concurrency' | null {
  // PostgreSQL: inspect constraint name from DatabaseError
  //   'idx_durably_runs_job_idempotency' → 'idempotency'
  //   'idx_durably_runs_pending_concurrency' → 'pending_concurrency'
  //
  // SQLite/libsql: inspect column names in error message
  //   message contains 'idempotency_key' → 'idempotency'
  //   message contains 'concurrency_key' (without 'idempotency_key') → 'pending_concurrency'
}

async enqueue(input: CreateRunInput): Promise<{ run: Run; disposition: Disposition }> {
  // 1. Idempotency check (existing behavior, now returns disposition)
  if (input.idempotencyKey) {
    const existing = ...
    if (existing) return { run: rowToRun(existing), disposition: 'idempotent' }
  }

  // 2. INSERT — catch unique constraint violation
  try {
    // ... existing insert path ...
    return { run: newRun, disposition: 'created' }
  } catch (err) {
    const violation = parseUniqueViolation(err)

    // IMPORTANT: A single INSERT can violate both idempotency and pending-concurrency
    // constraints simultaneously. The DB returns whichever constraint it checks first,
    // which is non-deterministic. To guarantee "idempotency takes priority", always
    // check idempotency first regardless of which constraint the DB reported.
    if (input.idempotencyKey) {
      const idempotent = await db
        .selectFrom('durably_runs').selectAll()
        .where('job_name', '=', input.jobName)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst()
      if (idempotent) {
        return { run: rowToRun(idempotent), disposition: 'idempotent' }
      }
    }

    // Not an idempotency hit — check if it's a pending concurrency conflict.
    if ((violation === 'pending_concurrency' || violation === null) && input.concurrencyKey) {
      if (input.coalesce === 'skip') {
        // Graceful: return the conflicting run.
        // Only return pending — not leased (could be an expired orphan).
        const pending = await db
          .selectFrom('durably_runs').selectAll()
          .where('job_name', '=', input.jobName)
          .where('concurrency_key', '=', input.concurrencyKey)
          .where('status', '=', 'pending')
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .limit(1)
          .executeTakeFirst()

        if (pending) {
          return { run: rowToRun(pending), disposition: 'coalesced' }
        }

        // Pending run was leased or completed between INSERT failure and SELECT.
        // Index slot may be free — retry once.
        // Note: _retried is a placeholder — implement as a context parameter
        // (e.g. enqueue(input, { retryAfterConflict: false })) to avoid
        // mixing internal state into the business data structure.
        if (!input._retried) {
          return this.enqueue({ ...input, _retried: true })
        }
        // Retry also failed — one more SELECT before giving up.
        // Under high concurrency, another trigger may have won the retry race.
        const lastChance = await db
          .selectFrom('durably_runs').selectAll()
          .where('job_name', '=', input.jobName)
          .where('concurrency_key', '=', input.concurrencyKey)
          .where('status', '=', 'pending')
          .limit(1)
          .executeTakeFirst()
        if (lastChance) {
          return { run: rowToRun(lastChance), disposition: 'coalesced' }
        }
        throw new ConflictError(
          `Conflict after retry for concurrency key "${input.concurrencyKey}" ` +
          `in job "${input.jobName}". Concurrent modification detected.`
        )
      }
      // No coalesce: explicit error
      throw new ConflictError(
        `A pending run already exists for concurrency key "${input.concurrencyKey}" ` +
        `in job "${input.jobName}". Use coalesce: 'skip' to return the existing run instead.`
      )
    }

    throw err
  }
}
```

**Key design**: INSERT first, catch conflict. This is the correct pattern — no TOCTOU race. The partial unique index is the single source of truth.

**PostgreSQL SAVEPOINT requirement**: In PostgreSQL, a UNIQUE constraint violation aborts the current transaction — subsequent statements fail with "current transaction is aborted". To allow the catch-and-recover logic (follow-up SELECT, retry INSERT), the INSERT must be wrapped in a SAVEPOINT:

```ts
await sql`SAVEPOINT sp_enqueue`.execute(db)
try {
  // ... INSERT ...
  await sql`RELEASE SAVEPOINT sp_enqueue`.execute(db)
  return { run: newRun, disposition: 'created' }
} catch (err) {
  await sql`ROLLBACK TO SAVEPOINT sp_enqueue`.execute(db)
  // ... catch logic (SELECT, retry) works because savepoint was rolled back ...
}
```

SQLite does not have this limitation — errors do not abort the transaction. The SAVEPOINT is harmless on SQLite (it's a no-op in terms of behavior) but required for PostgreSQL correctness. The implementation should always use SAVEPOINT regardless of dialect for simplicity.

**Constraint identification**: `parseUniqueViolation()` distinguishes between idempotency and pending-concurrency violations by inspecting the constraint/index name in the driver error. This prevents misclassifying an idempotency race as a concurrency conflict.

**Post-conflict SELECT race**: After a pending-concurrency conflict, the follow-up SELECT queries only `status = 'pending'`. Leased runs are excluded — they could be expired orphans awaiting `releaseExpiredLeases`. If no pending run is found (it was leased or completed between our INSERT failure and SELECT), retry the INSERT once. The retry uses a `_retried` flag to prevent infinite recursion.

### Step 3: Change `trigger()` return type

**File**: `packages/durably/src/job.ts`

```ts
async trigger(
  input: TInput,
  options?: TriggerOptions<TLabels>,
): Promise<TriggerResult<TOutput, TLabels>> {
  const validatedInput = validateJobInputOrThrow(inputSchema, input)
  if (labelsSchema && options?.labels) {
    validateJobInputOrThrow(labelsSchema, options.labels, 'labels')
  }

  if (options?.coalesce) {
    if (options.coalesce !== 'skip') {
      throw new ValidationError(`Invalid coalesce value: '${options.coalesce}'. Valid values: 'skip'`)
    }
    if (!options.concurrencyKey) {
      throw new ValidationError('coalesce requires concurrencyKey')
    }
  }

  const { run, disposition } = await storage.enqueue({
    jobName: jobDef.name,
    input: validatedInput,
    concurrencyKey: options?.concurrencyKey,
    idempotencyKey: options?.idempotencyKey,
    labels: options?.labels,
    coalesce: options?.coalesce,
  })

  if (disposition === 'created') {
    eventEmitter.emit({
      type: 'run:trigger', runId: run.id, jobName: jobDef.name,
      input: validatedInput, labels: run.labels,
    })
  } else if (disposition === 'coalesced') {
    eventEmitter.emit({
      type: 'run:coalesced', runId: run.id, jobName: jobDef.name,
      labels: run.labels, skippedInput: validatedInput, skippedLabels: options?.labels ?? {},
    })
  }

  return Object.assign(run as TypedRun<TOutput, TLabels>, { disposition })
}
```

### Step 4: Update `batchTrigger()` — sequential enqueue

**File**: `packages/durably/src/job.ts`

`batchTrigger()` returns `TriggerResult[]` for consistency. Each item carries its own disposition.

**Contract** (implementation-independent): `batchTrigger()` processes items **sequentially in order**. Each item receives a per-item `disposition`. Items with the same `concurrencyKey` and `coalesce: 'skip'` deduplicate to the first item in the batch. This contract holds regardless of future implementation changes (bulk insert, parallelization, etc.).

**Implementation change**: The current `enqueueMany()` uses bulk INSERT, which cannot handle per-item coalesce/conflict semantics. When the same `concurrencyKey` appears multiple times in a batch, a bulk INSERT would fail entirely on the unique constraint.

**Store refactoring required**: The current `enqueue()` opens its own `db.transaction()` internally, so calling it N times from `batchTrigger()` creates N independent transactions — not one atomic batch. To support "sequential enqueue within a single transaction", `enqueue()` must be refactored to accept an optional transaction object (`trx`):

- Extract core enqueue logic into `_enqueueInTx(trx, input)` (internal, takes a transaction)
- `enqueue(input)` calls `db.transaction(trx => _enqueueInTx(trx, input))` (backwards compatible)
- `batchTrigger()` calls `db.transaction(trx => items.map(i => _enqueueInTx(trx, i)))` (single transaction, per-item SAVEPOINT)

Each `_enqueueInTx()` call uses a SAVEPOINT within the shared transaction (required for PostgreSQL — see Step 2). The batch remains **atomic** — if any item throws (e.g. ConflictError without coalesce), the entire transaction rolls back and no runs are created. This preserves the existing "validate all, then create all" contract.

With `coalesce: 'skip'`, conflicts within the same batch are absorbed as `disposition: 'coalesced'` (the SAVEPOINT rolls back the failed INSERT, and the catch logic returns the existing run). Without coalesce, a ConflictError on any item fails the entire batch.

- Per-item validation: `coalesce` value validated (`'skip'` only), `concurrencyKey` required if `coalesce` set — same rules as `trigger()`
- Same concurrencyKey in batch: first creates, rest coalesce (with `coalesce: 'skip'`) or entire batch fails with ConflictError
- Mixed idempotencyKey: each item gets its own disposition
- Atomic semantics: all-or-nothing, no partial success

> **Performance note**: Sequential enqueue is slower than bulk INSERT for large batches. This is acceptable for pre-v1. If bulk performance becomes critical, a future optimization could pre-deduplicate items by concurrencyKey within the batch before inserting.

### Step 5: Update `retrigger()`

`retrigger()` returns `TriggerResult` with `disposition: 'created'` (always creates a new run). Note: retrigger with a concurrencyKey that has an existing pending run will now throw ConflictError — document this.

### Step 6: Wire up HTTP handler

**File**: `packages/durably/src/server.ts`

- Add `coalesce` to `TriggerRequest`
- Return `disposition` in `TriggerResponse`

### Step 7: Add `run:coalesced` event type

**File**: `packages/durably/src/events.ts`

```ts
export interface RunCoalescedEvent extends BaseEvent {
  type: 'run:coalesced'
  runId: string // ID of the existing pending run
  jobName: string
  labels: Record<string, string> // existing run's labels (for SSE label-scoped filtering)
  skippedInput: unknown // the new input that was NOT used
  skippedLabels: Record<string, string> // the new labels that were NOT used
}
```

The event carries both:

- **`labels`**: The existing run's labels — required by the SSE layer for label-scoped filtering (`matchesLabels()` in server.ts uses `event.labels`).
- **`skippedInput` / `skippedLabels`**: What the caller passed (the deduplicated data) — for audit logging.

**SSE/React integration**: `run:coalesced` must also be wired into the event delivery chain:

- **server.ts SSE handler**: Add `run:coalesced` to the event types forwarded via SSE. The event needs a `labels` field (use the **existing run's labels**, not skippedLabels) for SSE label-scoped filtering to work. The SSE payload is a simplified projection — it doesn't need `skippedInput`/`skippedLabels`.
- **durably-react types.ts**: Add `run:coalesced` to the `DurablyEvent` union type so client-side hooks can receive and filter on it.
- **use-runs.ts (client)**: Include `run:coalesced` in the event types that trigger a refresh.
- **use-job.ts (client) followLatest**: The `followLatest` hook currently reacts only to `run:trigger` / `run:leased`. Since coalesce skips `run:trigger`, add `run:coalesced` so follow-latest UI can track the existing pending run.
- **use-job-subscription.ts (direct/SPA) followLatest**: Same issue — the direct hook's `followLatest` also only reacts to `run:leased`. Add `run:coalesced` handling here too.

### Step 8: Update callers

Since `trigger()` returns `TriggerResult` (extends `TypedRun`), most existing code works unchanged. Update:

- `triggerAndWait()` — add `disposition` to `TriggerAndWaitResult` (currently returns `{ id, output }`, needs `{ id, output, disposition }`)
- `durably-react` hooks — `useJob` trigger callback
- Server handler — done in Step 6
- SSE/React event types — done in Step 7
- Examples — update if they type-check the return
- Tests — update type assertions, add disposition checks

### Step 9: Tests

**File**: `packages/durably/tests/shared/coalesce.shared.ts` (new)

Test cases:

**concurrencyKey pending limit:**

1. **1st trigger** — creates pending, disposition `'created'`
2. **2nd trigger same key, no coalesce** — throws `ConflictError`
3. **2nd trigger same key, coalesce: 'skip'** — returns existing, disposition `'coalesced'`
4. **running + new trigger** — creates pending (only 1 running blocks leasing, not insert)
5. **running + pending + trigger** — ConflictError (or coalesced with skip)
6. **different concurrencyKeys** — both create, no conflict
7. **no concurrencyKey** — unlimited pending, no constraint

**coalesce behavior:**

8. **coalesced input preserved** — existing run's input returned, not new input
9. **coalesced labels preserved** — existing run's labels returned
10. **coalesce without concurrencyKey** — throws `ValidationError`

**disposition:**

11. **idempotency hit** — disposition `'idempotent'`
12. **normal create** — disposition `'created'`
13. **coalesced** — disposition `'coalesced'`

**events:**

14. **`run:trigger` on create** — emitted
15. **`run:coalesced` on skip** — emitted with skipped input
16. **no event on idempotent** — not emitted

**batchTrigger:**

17. **batch with same concurrencyKey + coalesce** — first creates, rest coalesce (sequential enqueue)
18. **batch with same concurrencyKey, no coalesce** — first creates, rest ConflictError

**constraint identification:**

19. **concurrent idempotency race** — two triggers with same idempotencyKey, both pass SELECT, one INSERT wins, other gets disposition `'idempotent'` (not ConflictError)
20. **concurrent concurrency race** — two triggers with same concurrencyKey + coalesce, both INSERT, one wins, other gets disposition `'coalesced'`

**post-conflict race:**

21. **coalesce after worker leases** — pending run gets leased between INSERT failure and follow-up SELECT → retry INSERT

**triggerAndWait:**

22. **triggerAndWait returns disposition** — verify `{ id, output, disposition }` shape
23. **triggerAndWait with coalesce** — coalesced run completes, returns original output + disposition `'coalesced'`

**releaseExpiredLeases interaction:**

24. **expired lease + existing pending** — lease expires on Run A, Run B is pending with same concurrencyKey → Run A set to `failed` (not pending), no index violation
25. **expired lease + no pending** — lease expires on Run A, no other pending → Run A reset to `pending` as before

**post-conflict edge:**

26. **coalesce after run completes and is purged** — conflicting run completes and is purged between INSERT failure and SELECT → retry INSERT succeeds, disposition `'created'`

**validation:**

27. **coalesce: 'invalid'** — throws `ValidationError`
28. **batchTrigger per-item coalesce validation** — invalid coalesce value in any item throws `ValidationError`, batch rolls back

### Step 10: Documentation

- Update `packages/durably/docs/llms.md`:
  - concurrencyKey now enforces max 1 pending
  - `coalesce: 'skip'` option
  - `trigger()` returns `TriggerResult` with `disposition`
  - ConflictError on duplicate pending
  - Semantic caveats (input/labels ignored on coalesce)
- Regenerate `website/public/llms.txt`

## File Change Summary

| File                                               | Change                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/durably/src/migrations.ts`               | Add partial unique index to v1 migration                           |
| `packages/durably/src/storage.ts`                  | `enqueue()` returns `{ run, disposition }`, catch unique violation |
| `packages/durably/src/job.ts`                      | `trigger()` returns `TriggerResult`, add `coalesce` to options     |
| `packages/durably/src/events.ts`                   | Add `RunCoalescedEvent`                                            |
| `packages/durably/src/errors.ts`                   | Ensure `ConflictError` handles this case                           |
| `packages/durably/src/server.ts`                   | Add `coalesce` to request, `disposition` to response               |
| `packages/durably/src/index.ts`                    | Export `TriggerResult`, `Disposition`                              |
| `packages/durably-react/src/**`                    | Update for `TriggerResult` return type                             |
| `packages/durably/src/storage.ts`                  | Update `releaseExpiredLeases()` to handle unique index conflict    |
| `packages/durably/tests/shared/coalesce.shared.ts` | New: shared test suite (28 cases)                                  |
| `packages/durably/tests/node/coalesce.test.ts`     | New: Node.js SQLite runner                                         |
| `packages/durably/tests/browser/coalesce.test.ts`  | New: Browser WASM runner                                           |
| `packages/durably/tests/**`                        | Update existing tests for new return type                          |
| `examples/**`                                      | Update trigger() usage if typed                                    |
| `packages/durably-react/src/types.ts`              | Add `run:coalesced` to `DurablyEvent` union                        |
| `packages/durably/docs/llms.md`                    | Document all changes                                               |

## Design Decisions

1. **concurrencyKey = max 1 pending** — simpler mental model. "At most 1 running + 1 pending" is the natural invariant. The previous "unlimited pending, serialize execution" allowed unbounded queue buildup that was almost always a bug in webhook workloads.

2. **ConflictError without coalesce** — makes the semantic change visible. Existing code that triggers duplicate pending runs will get an explicit error with a helpful message suggesting `coalesce: 'skip'`. Silent behavior changes are worse than loud errors.

3. **INSERT-first, catch conflict** — no TOCTOU race. The partial unique index is the single source of truth. No SELECT-before-INSERT, no advisory locks, no application-level mutex needed for correctness.

4. **`parseUniqueViolation()` distinguishes constraints** — the codebase has two unique indexes (idempotency + pending-concurrency). A generic `isUniqueViolation()` would misclassify idempotency races as concurrency conflicts. PostgreSQL: inspect constraint name. SQLite: inspect **column names** in error message (SQLite does not include index names — only `UNIQUE constraint failed: table.column`).

5. **Post-conflict SELECT returns only pending** — after a pending-concurrency conflict, the SELECT returns only `status = 'pending'` (with `id` as tie-breaker). Leased runs are excluded (could be expired orphans). If nothing found, retry INSERT once (guarded by `_retried` flag).

6. **`TriggerResult = TypedRun & { disposition }`** — no destructuring tax. Existing code that reads Run properties works unchanged. `disposition` is available when needed. The persisted `Run` type stays clean.

7. **`coalesce: 'skip'` string union** — extensible for future modes (`'merge'`, etc.) without breaking the API.

8. **Idempotency takes priority (double-checked)** — idempotency is checked both before INSERT (SELECT) and after INSERT failure (re-SELECT in catch). A single INSERT can violate both idempotency and pending-concurrency constraints simultaneously, and the DB may report either one non-deterministically. The catch block always re-checks idempotency first, regardless of which constraint the DB reported.

9. **`run:coalesced` event** — carries both skipped input AND skipped labels (what the caller passed, not the existing run's data). This avoids the inconsistency of mixing new input with old labels. Webhook storm visibility is operationally important.

10. **Idempotent stops emitting `run:trigger`** — the current codebase emits `run:trigger` even on idempotency hits. This is fixed: `disposition: 'idempotent'` now emits no event. This is a behavior change, documented in the migration guide.

11. **SAVEPOINT wraps each INSERT** — PostgreSQL aborts the entire transaction after a UNIQUE violation. SAVEPOINT/ROLLBACK TO SAVEPOINT allows catch-and-recover within the same transaction. Harmless on SQLite. Used in both `enqueue()` and `batchTrigger()`.

12. **`batchTrigger()` uses sequential enqueue, stays atomic** — bulk INSERT cannot handle per-item coalesce/conflict semantics. Sequential enqueue (each with its own SAVEPOINT) within a single transaction preserves all-or-nothing semantics. With `coalesce: 'skip'`, conflicts are absorbed; without coalesce, any ConflictError rolls back the entire batch. The sequential processing order is a **contract**, not an implementation detail.

13. **`releaseExpiredLeases()` uses 2-phase + per-row SAVEPOINT** — Phase 1: bulk fail expired leases with existing pending replacements. Phase 2: per-row UPDATE with SAVEPOINT for the rest, catching any unique violations from concurrent `trigger()` calls. This handles the race where a pending run is inserted between Phase 1 and Phase 2.

14. **v1 migration consolidation** — only production user (upflow) will recreate their database. No incremental v2 migration needed. Partial unique index is added to v1, keeping `LATEST_SCHEMA_VERSION = 1`.

15. **Runtime validation of `coalesce` value** — `trigger()` and `batchTrigger()` validate that `coalesce` is `'skip'` (or undefined). Invalid values from HTTP or programmatic API throw `ValidationError`. Prevents silent misconfiguration.

16. **Breaking change is acceptable** — pre-v1 (v0.14.0). Since `TriggerResult` extends `TypedRun`, most existing code works without changes. The TypeScript compiler will NOT flag all call sites — only code that explicitly narrows to `TypedRun` or serializes the return value may be affected.

## Future: merge mode

A merge mode (`coalesce: 'merge'`) that updates the pending run's input could be added later:

- Merge function in a separate option (e.g. `coalesceMerge: fn`)
- Requires `updateRunInput()` in storage layer
- PostgreSQL needs `SELECT ... FOR UPDATE` for atomicity
- Merged input must be re-validated against job schema
- `run:coalesced` event would carry the merged input
