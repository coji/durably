# Tasks: PostgreSQL Support

## 1. Schema Extensions

- [ ] 1.1 Add `durably_concurrency_locks` table schema
- [ ] 1.2 Create PG-specific migration path
- [ ] 1.3 Handle dialect detection in migrations

## 2. Atomic Run Claiming

- [ ] 2.1 Implement `FOR UPDATE SKIP LOCKED` claiming for PG
- [ ] 2.2 Keep SQLite claiming logic unchanged
- [ ] 2.3 Abstract claiming into dialect-specific methods

## 3. Concurrency Key Protection

- [ ] 3.1 Acquire lock in `durably_concurrency_locks` on claim
- [ ] 3.2 Release lock on Run completion/failure/cancel
- [ ] 3.3 Prevent same `concurrency_key` running simultaneously

## 4. Stale Run Recovery

- [ ] 4.1 Implement `recoverStaleRuns()` for PG
- [ ] 4.2 Ensure recover → claim ordering
- [ ] 4.3 Release orphaned locks

## 5. Testing

- [ ] 5.1 Two-worker concurrent claim test
- [ ] 5.2 Concurrency key mutual exclusion test
- [ ] 5.3 Stale run recovery test
- [ ] 5.4 Ensure SQLite tests still pass

## 6. Documentation

- [ ] 6.1 Document PG connection setup
- [ ] 6.2 Add PG example to examples/
- [ ] 6.3 Note "experimental" status
