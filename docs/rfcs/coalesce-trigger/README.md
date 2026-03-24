# RFC: coalesce trigger + concurrencyKey pending limit

Issue: #143

## Problem

Webhook-driven workloads can trigger many jobs in rapid succession for the same logical entity. Since the job reads latest state from DB at execution time, intermediate triggers are redundant. Without coalescing, N webhook events create N queued runs — all executing sequentially but wastefully.

## Scope

Two breaking changes in one release (pre-v1, v0.14.0):

1. **concurrencyKey enforces max 1 pending** — partial unique index, ConflictError on violation
2. **trigger() returns `TriggerResult`** — `TypedRun & { disposition }`, no destructuring needed
3. **coalesce: 'skip'** — opt-in graceful handling of the pending limit

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

> **Migration note**: This is a breaking change, but the TypeScript compiler will flag all call sites where the new `disposition` property conflicts with existing type expectations. Existing code that only reads Run properties works without changes.

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

`run:coalesced` carries the **skipped** input (not the existing run's input), enabling audit logging of what was deduplicated.

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

Add migration v2:

```sql
CREATE UNIQUE INDEX idx_durably_runs_pending_concurrency
  ON durably_runs (job_name, concurrency_key)
  WHERE status = 'pending' AND concurrency_key IS NOT NULL;
```

Works on both SQLite and PostgreSQL.

**Existing data handling**: The migration must check for duplicate pending runs before creating the index. If duplicates exist, fail with a descriptive error instructing the user to resolve manually:

```ts
{
  version: 2,
  up: async (db) => {
    // Check for duplicate pending runs per concurrency key
    const duplicates = await sql`
      SELECT job_name, concurrency_key, COUNT(*) as cnt
      FROM durably_runs
      WHERE status = 'pending' AND concurrency_key IS NOT NULL
      GROUP BY job_name, concurrency_key
      HAVING COUNT(*) > 1
    `.execute(db)

    if (duplicates.rows.length > 0) {
      const details = duplicates.rows
        .map(r => `${r.job_name}:${r.concurrency_key} (${r.cnt} pending)`)
        .join(', ')
      throw new Error(
        `Cannot migrate: duplicate pending runs per concurrency key found: ${details}. ` +
        `Cancel or complete duplicates before upgrading. ` +
        `See https://github.com/coji/durably/blob/main/docs/migration-v2.md`
      )
    }

    await sql`
      CREATE UNIQUE INDEX idx_durably_runs_pending_concurrency
      ON durably_runs (job_name, concurrency_key)
      WHERE status = 'pending' AND concurrency_key IS NOT NULL
    `.execute(db)
  },
}
```

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
 * PostgreSQL: SQLSTATE '23505' + constraint/index name
 * SQLite/libsql: SQLITE_CONSTRAINT_UNIQUE + error message containing index name
 */
function parseUniqueViolation(
  err: unknown,
): 'idempotency' | 'pending_concurrency' | null {
  // Implementation varies by driver — detect constraint/index name from error
  // 'idx_durably_runs_job_idempotency' → 'idempotency'
  // 'idx_durably_runs_pending_concurrency' → 'pending_concurrency'
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

    // Idempotency race: another concurrent trigger inserted with same idempotency key
    // between our SELECT and INSERT. Re-fetch and return as idempotent.
    if (violation === 'idempotency' && input.idempotencyKey) {
      const existing = await db
        .selectFrom('durably_runs').selectAll()
        .where('job_name', '=', input.jobName)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirstOrThrow()
      return { run: rowToRun(existing), disposition: 'idempotent' }
    }

    // Pending concurrency conflict
    if (violation === 'pending_concurrency' && input.concurrencyKey) {
      if (input.coalesce === 'skip') {
        // Graceful: return the conflicting run.
        // Use (job_name, concurrency_key) without status filter — the pending run
        // may have been leased between our INSERT and this SELECT.
        // Priority: pending first, then most recently created.
        const conflicting = await db
          .selectFrom('durably_runs').selectAll()
          .where('job_name', '=', input.jobName)
          .where('concurrency_key', '=', input.concurrencyKey)
          .where('status', 'in', ['pending', 'leased'])
          .orderBy(sql`CASE WHEN status = 'pending' THEN 0 ELSE 1 END`, 'asc')
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow()
        return { run: rowToRun(conflicting), disposition: 'coalesced' }
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

**Key design**: INSERT first, catch conflict. This is the correct pattern — no TOCTOU race, works on both SQLite and PostgreSQL. The partial unique index is the single source of truth.

**Constraint identification**: `parseUniqueViolation()` distinguishes between idempotency and pending-concurrency violations by inspecting the constraint/index name in the driver error. This prevents misclassifying an idempotency race as a concurrency conflict.

**Post-conflict SELECT race**: After a pending-concurrency conflict, the follow-up SELECT does NOT filter by `status = 'pending'` alone. The pending run may have been leased by a worker between our INSERT failure and the SELECT. Instead, we query `pending OR leased`, preferring pending.

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

  if (options?.coalesce && !options.concurrencyKey) {
    throw new ValidationError('coalesce requires concurrencyKey')
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
      input: validatedInput, labels: run.labels,
    })
  }

  return Object.assign(run as TypedRun<TOutput, TLabels>, { disposition })
}
```

### Step 4: Update `batchTrigger()` — sequential enqueue

**File**: `packages/durably/src/job.ts`

`batchTrigger()` returns `TriggerResult[]` for consistency. Each item carries its own disposition.

**Implementation change**: The current `enqueueMany()` uses bulk INSERT, which cannot handle per-item coalesce/conflict semantics. When the same `concurrencyKey` appears multiple times in a batch, a bulk INSERT would fail entirely on the unique constraint.

`batchTrigger()` switches to **sequential `enqueue()` calls** within a single transaction. This naturally handles:

- Same concurrencyKey in batch: first creates, rest coalesce (with `coalesce: 'skip'`) or throw ConflictError
- Mixed idempotencyKey: each item gets its own disposition
- Per-item error handling: partial success is possible

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
  input: unknown // the new (skipped) input, for audit
  labels: Record<string, string>
}
```

### Step 8: Update callers

Since `trigger()` returns `TriggerResult` (extends `TypedRun`), most existing code works unchanged. Update:

- `triggerAndWait()` — works internally, may expose disposition
- `durably-react` hooks — `useJob` trigger callback
- Server handler — done in Step 6
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

21. **coalesce after worker leases** — pending run gets leased between INSERT failure and follow-up SELECT, still returns the (now leased) run with disposition `'coalesced'`

**migration:**

22. **v2 migration with clean data** — index created successfully
23. **v2 migration with duplicate pending** — fails with descriptive error (shows first N entries)

### Step 10: Documentation

- Update `packages/durably/docs/llms.md`:
  - concurrencyKey now enforces max 1 pending
  - `coalesce: 'skip'` option
  - `trigger()` returns `TriggerResult` with `disposition`
  - ConflictError on duplicate pending
  - Semantic caveats (input/labels ignored on coalesce)
- Add `docs/migration-v2.md` — migration guide for the breaking changes
- Regenerate `website/public/llms.txt`

## File Change Summary

| File                                               | Change                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/durably/src/migrations.ts`               | Add v2 migration: partial unique index + duplicate check           |
| `packages/durably/src/storage.ts`                  | `enqueue()` returns `{ run, disposition }`, catch unique violation |
| `packages/durably/src/job.ts`                      | `trigger()` returns `TriggerResult`, add `coalesce` to options     |
| `packages/durably/src/events.ts`                   | Add `RunCoalescedEvent`                                            |
| `packages/durably/src/errors.ts`                   | Ensure `ConflictError` handles this case                           |
| `packages/durably/src/server.ts`                   | Add `coalesce` to request, `disposition` to response               |
| `packages/durably/src/index.ts`                    | Export `TriggerResult`, `Disposition`                              |
| `packages/durably-react/src/**`                    | Update for `TriggerResult` return type                             |
| `packages/durably/tests/shared/coalesce.shared.ts` | New: shared test suite (20 cases)                                  |
| `packages/durably/tests/node/coalesce.test.ts`     | New: Node.js SQLite runner                                         |
| `packages/durably/tests/browser/coalesce.test.ts`  | New: Browser WASM runner                                           |
| `packages/durably/tests/**`                        | Update existing tests for new return type                          |
| `examples/**`                                      | Update trigger() usage if typed                                    |
| `packages/durably/docs/llms.md`                    | Document all changes                                               |
| `docs/migration-v2.md`                             | New: migration guide                                               |

## Design Decisions

1. **concurrencyKey = max 1 pending** — simpler mental model. "At most 1 running + 1 pending" is the natural invariant. The previous "unlimited pending, serialize execution" allowed unbounded queue buildup that was almost always a bug in webhook workloads.

2. **ConflictError without coalesce** — makes the semantic change visible. Existing code that triggers duplicate pending runs will get an explicit error with a helpful message suggesting `coalesce: 'skip'`. Silent behavior changes are worse than loud errors.

3. **INSERT-first, catch conflict** — no TOCTOU race. The partial unique index is the single source of truth. No SELECT-before-INSERT, no advisory locks, no application-level mutex needed for correctness.

4. **`parseUniqueViolation()` distinguishes constraints** — the codebase has two unique indexes (idempotency + pending-concurrency). A generic `isUniqueViolation()` would misclassify idempotency races as concurrency conflicts. The parser inspects the constraint/index name from the driver error.

5. **Post-conflict SELECT is status-agnostic** — after a pending-concurrency conflict, the follow-up SELECT queries `pending OR leased` (preferring pending). This handles the race where a worker leases the pending run between our INSERT failure and SELECT.

6. **`TriggerResult = TypedRun & { disposition }`** — no destructuring tax. Existing code that reads Run properties works unchanged. `disposition` is available when needed. The persisted `Run` type stays clean.

7. **`coalesce: 'skip'` string union** — extensible for future modes (`'merge'`, etc.) without breaking the API.

8. **Idempotency takes priority** — idempotency check runs before INSERT, so it's evaluated before the unique index can fire. Disposition `'idempotent'` is returned regardless of coalesce flag.

9. **`run:coalesced` event** — carries the skipped input for audit/observability. Webhook storm visibility is operationally important.

10. **Idempotent stops emitting `run:trigger`** — the current codebase emits `run:trigger` even on idempotency hits. This is fixed: `disposition: 'idempotent'` now emits no event. This is a behavior change, documented in the migration guide.

11. **`batchTrigger()` uses sequential enqueue** — bulk INSERT cannot handle per-item coalesce/conflict semantics within the same batch. Sequential enqueue within a transaction is correct and simple.

12. **Fail-fast migration** — if existing data has duplicate pending runs per concurrency key, migration v2 fails with a descriptive error (first N entries shown). No silent data cleanup in an OSS library.

13. **Breaking change is acceptable** — pre-v1 (v0.14.0). TypeScript compiler flags all affected call sites. Migration guide provided.

## Future: merge mode

A merge mode (`coalesce: 'merge'`) that updates the pending run's input could be added later:

- Merge function in a separate option (e.g. `coalesceMerge: fn`)
- Requires `updateRunInput()` in storage layer
- PostgreSQL needs `SELECT ... FOR UPDATE` for atomicity
- Merged input must be re-validated against job schema
- `run:coalesced` event would carry the merged input
