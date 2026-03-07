# Design: Database Adapter Sketches

## Goal

This document gives concrete adapter sketches for the two most important database targets:

- PostgreSQL
- SQLite

These are sketches, not final migrations or production-ready query builders.

Their purpose is to make the intended semantics concrete enough that implementation work can begin with fewer unknowns.

## Scope

The focus is on:

- `enqueue()`
- `claimNext()`
- `renewLease()`
- `completeRun()` / `failRun()`

The examples assume a `runs` table conceptually similar to:

```sql
id
job_name
status
idempotency_key
concurrency_key
lease_owner
lease_expires_at
started_at
completed_at
created_at
updated_at
input
output
error
```

The exact schema can vary. The important point is the guarded mutation shape.

## Shared Assumptions

The adapter sketches assume:

- `status` is one of `pending`, `leased`, `completed`, `failed`, `cancelled`
- reclaimable runs are `pending` or expired `leased`
- `started_at` is set on first successful claim only
- `completed_at` is set on successful completion or failure
- `updated_at` is refreshed on every mutation

## PostgreSQL Sketch

PostgreSQL is the semantic reference model.

### Idempotent `enqueue()`

Use a unique index that applies only when `idempotency_key` is present.

```sql
CREATE UNIQUE INDEX runs_job_idempotency_key_unique
ON runs (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

Insert with conflict handling.

```sql
INSERT INTO runs (
  id,
  job_name,
  input,
  status,
  idempotency_key,
  concurrency_key,
  created_at,
  updated_at
)
VALUES (
  $1, $2, $3, 'pending', $4, $5, $6, $6
)
ON CONFLICT (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;
```

Then:

- if insert succeeded, return the new row
- if insert was skipped, fetch and return the existing row

### `claimNext()`

The preferred shape uses a transaction plus `FOR UPDATE SKIP LOCKED`.

```sql
BEGIN;

WITH candidate AS (
  SELECT id
  FROM runs
  WHERE
    (
      status = 'pending'
      OR (status = 'leased' AND lease_expires_at < $1)
    )
    AND (
      concurrency_key IS NULL
      OR concurrency_key <> ALL($2)
    )
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE runs
SET
  status = 'leased',
  lease_owner = $3,
  lease_expires_at = $4,
  started_at = COALESCE(started_at, $1),
  updated_at = $1
WHERE id = (SELECT id FROM candidate)
RETURNING *;

COMMIT;
```

Properties:

- at most one worker locks and updates a candidate row
- expired leased runs are reclaimed by the same path
- `started_at` is preserved on reclaim

### `renewLease()`

Use a guarded update:

```sql
UPDATE runs
SET
  lease_expires_at = $3,
  updated_at = $2
WHERE
  id = $1
  AND status = 'leased'
  AND lease_owner = $4
  AND lease_expires_at >= $2;
```

Interpretation:

- updated row count `= 1` means success
- updated row count `= 0` means the worker no longer owns the lease

### `completeRun()`

```sql
UPDATE runs
SET
  status = 'completed',
  output = $3,
  error = NULL,
  completed_at = $4,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = $4
WHERE
  id = $1
  AND status = 'leased'
  AND lease_owner = $2;
```

### `failRun()`

```sql
UPDATE runs
SET
  status = 'failed',
  output = NULL,
  error = $3,
  completed_at = $4,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = $4
WHERE
  id = $1
  AND status = 'leased'
  AND lease_owner = $2;
```

### Optional Indexes

Typical supporting indexes:

```sql
CREATE INDEX runs_claim_idx
ON runs (status, lease_expires_at, created_at);

CREATE INDEX runs_concurrency_key_idx
ON runs (concurrency_key)
WHERE concurrency_key IS NOT NULL;
```

## SQLite Sketch

SQLite should preserve the same behavioral contract with a different concurrency shape.

### Idempotent `enqueue()`

Use a unique index:

```sql
CREATE UNIQUE INDEX runs_job_idempotency_key_unique
ON runs (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

Insert with conflict handling:

```sql
INSERT INTO runs (
  id,
  job_name,
  input,
  status,
  idempotency_key,
  concurrency_key,
  created_at,
  updated_at
)
VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
ON CONFLICT(job_name, idempotency_key) DO NOTHING;
```

Then:

- if changes count is `1`, return the new row
- otherwise fetch the existing row

### `claimNext()`

SQLite should use a write transaction.

One viable shape is:

```sql
BEGIN IMMEDIATE;

SELECT id
FROM runs
WHERE
  (
    status = 'pending'
    OR (status = 'leased' AND lease_expires_at < ?)
  )
  AND (
    concurrency_key IS NULL
    OR concurrency_key NOT IN (?, ?, ?)
  )
ORDER BY created_at ASC
LIMIT 1;
```

Then, in the same transaction:

```sql
UPDATE runs
SET
  status = 'leased',
  lease_owner = ?,
  lease_expires_at = ?,
  started_at = COALESCE(started_at, ?),
  updated_at = ?
WHERE id = ?;

COMMIT;
```

Interpretation:

- `BEGIN IMMEDIATE` forces write-intent early
- write serialization keeps two writers from racing through the same mutation path
- correctness depends on the transaction, not on row-level locks

### Safer Guard for Candidate Update

If the adapter wants extra defense, the update can also repeat eligibility conditions:

```sql
UPDATE runs
SET
  status = 'leased',
  lease_owner = ?,
  lease_expires_at = ?,
  started_at = COALESCE(started_at, ?),
  updated_at = ?
WHERE
  id = ?
  AND (
    status = 'pending'
    OR (status = 'leased' AND lease_expires_at < ?)
  );
```

This is not a substitute for the transaction, but it makes the mutation more self-defending.

### `renewLease()`

```sql
UPDATE runs
SET
  lease_expires_at = ?,
  updated_at = ?
WHERE
  id = ?
  AND status = 'leased'
  AND lease_owner = ?
  AND lease_expires_at >= ?;
```

Success means `changes() = 1`.

### `completeRun()`

```sql
UPDATE runs
SET
  status = 'completed',
  output = ?,
  error = NULL,
  completed_at = ?,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = ?
WHERE
  id = ?
  AND status = 'leased'
  AND lease_owner = ?;
```

### `failRun()`

```sql
UPDATE runs
SET
  status = 'failed',
  output = NULL,
  error = ?,
  completed_at = ?,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = ?
WHERE
  id = ?
  AND status = 'leased'
  AND lease_owner = ?;
```

### Practical Note

SQLite adapters should prefer correctness over cleverness.

A simple transactionally serialized claim path is better than a more elaborate pattern that becomes harder to reason about.

## Concurrency Key Note

The sketches above show `excludeConcurrencyKeys` conceptually, but actual implementation details may vary.

The important semantic rule is:

- a run should not be claimed if its `concurrency_key` conflicts with an already-active run that the runtime wants to exclude

If that logic becomes awkward to express inline, it may be acceptable to split it into:

- a query for active concurrency keys
- a guarded claim query that excludes them

As long as the final claim remains correctness-preserving.

## Step and Event Writes

These adapter sketches focus on claim and lease handling, but checkpoint and event persistence should follow the same discipline:

- append writes should be durable
- read-after-write visibility should be predictable
- step completion should be safe to re-read after crash and reclaim

## Recommended Next Step

The next implementation-oriented document should likely define:

- the exact `runs` table schema for the new runtime
- required indexes
- adapter test fixtures that all backends must pass

That would turn these sketches into a more direct implementation plan.
