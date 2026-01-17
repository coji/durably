# Tasks: Job Definition Auto-Versioning

## 1. Hash Generation

- [ ] 1.1 Decide hash algorithm (SHA-256 recommended)
- [ ] 1.2 Define what to include in hash (name + input/output JSON Schema)
- [ ] 1.3 Implement `computeJobHash()` function
- [ ] 1.4 Ensure hash stability (order-independent)

## 2. Schema Changes

- [ ] 2.1 Add `job_hash` column to `runs` table
- [ ] 2.2 Add migration for `job_hash`
- [ ] 2.3 Update `Run` interface

## 3. Storage Integration

- [ ] 3.1 Store `job_hash` at trigger time
- [ ] 3.2 Add `validateJobHash()` to storage

## 4. Validation Logic

- [ ] 4.1 Add hash check to `retry()`
- [ ] 4.2 Add hash check to `resume()` (HITL integration)
- [ ] 4.3 Implement `allowIncompatible` option
- [ ] 4.4 Return appropriate error codes

## 5. Testing

- [ ] 5.1 Test hash stability across restarts
- [ ] 5.2 Test mismatch detection
- [ ] 5.3 Test `allowIncompatible` bypass

## Open Questions (to resolve before implementation)

- [ ] How to hash the `run` function? (string serialization? manual tag? skip it?)
- [ ] How to serialize Zod schemas stably?
- [ ] Should we hash only schemas or include function body?
