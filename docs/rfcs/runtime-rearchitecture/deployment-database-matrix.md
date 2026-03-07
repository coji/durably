# Deployment × Database Matrix

This document summarizes the practical runtime fit of each deployment shape against each database target.

It is a decision aid for Phase 1, not a public support promise.

Related documents:

- `deployment-models.md`
- `database-runtime-fit.md`
- `database-claim-patterns.md`
- `database-adapter-sketches.md`

## Evaluation Axes

Each combination is judged by these questions:

- Can `claimNext()` be defended under real contention?
- Can `renewLease()` / `completeRun()` / `failRun()` reject stale workers reliably?
- Does the deployment shape make lease expiry and reclaim normal and predictable?
- Are connectivity and transaction costs reasonable for the expected trigger model?
- Is the operational story simple enough to recommend?

## Quick Matrix

| Deployment                    | PostgreSQL                     | SQLite (local file)       | libSQL / Turso                             | Cloudflare D1                |
| ----------------------------- | ------------------------------ | ------------------------- | ------------------------------------------ | ---------------------------- |
| Resident worker / VM / Fly.io | **Strong**                     | **Strong on single node** | **Possible, but weaker than local SQLite** | **Not a natural fit**        |
| Vercel                        | **Strong**                     | **Poor fit**              | **Plausible default**                      | **Not relevant**             |
| Netlify                       | **Strong**                     | **Poor fit**              | **Plausible**                              | **Not relevant**             |
| Cloudflare Workers            | **Possible but network-heavy** | **Poor fit**              | **Plausible first path**                   | **Caveated platform target** |
| AWS Lambda                    | **Strong**                     | **Poor fit**              | **Plausible with validation**              | **Not relevant**             |

## Per-Database Reading

### PostgreSQL

Best semantic reference for Durably.

Strengths:

- clean transaction model for `claimNext()`
- straightforward ownership-sensitive guarded updates
- best multi-worker story
- easiest backend to defend for lease reclaim correctness

Constraints:

- heavier operations and cost than SQLite-shaped options
- less attractive as the very first solo-developer onboarding path

Deployment guidance:

- best fit for `Fly.io + PostgreSQL`
- strong fit for `Vercel + PostgreSQL`
- strong fit for `AWS Lambda + PostgreSQL`
- viable on Cloudflare Workers, but remote DB latency becomes part of every lease-sensitive path

### SQLite (local file)

Best when the runtime and database are tightly co-located.

Strengths:

- clear transactional behavior
- simple checkpoint persistence
- good single-node semantics

Constraints:

- not naturally multi-writer across distributed compute
- poor fit for short-lived serverless functions without shared local state
- not the right mental model for distributed reclaim across many machines

Deployment guidance:

- strong for resident workers on one machine
- poor fit for Vercel, Netlify, Cloudflare Workers, and Lambda

### libSQL / Turso

Potentially the most attractive onboarding path, but semantically less settled than PostgreSQL.

Strengths:

- serverless-friendly connectivity
- SQLite-like developer experience
- much easier deploy story than local file SQLite in short-lived runtimes

Constraints:

- must prove transaction/visibility behavior under contention
- should not be assumed equivalent to local SQLite
- reclaim and guarded completion need adapter tests, not intuition

Deployment guidance:

- strongest practical fit for `Vercel + Turso`
- good candidate for `Cloudflare Workers + Turso`
- plausible for Lambda and Netlify
- less compelling than PostgreSQL for heavier multi-worker production loads

### Cloudflare D1

A platform-specific option, not a semantic reference model.

Strengths:

- native Cloudflare deployment story
- operationally simple for Cloudflare-only apps

Constraints:

- correctness confidence must come from contention tests
- not obviously portable to other deployment targets
- harder to present as a universal Durably backend

Deployment guidance:

- only meaningful for Cloudflare Workers
- should start as a caveated adapter target
- should not be a Phase 1 default recommendation

## Per-Deployment Reading

### Resident Worker / Always-On Server

Best DB choices:

- PostgreSQL
- SQLite on a single machine

Why:

- lease renewal is easy
- long-running execution is acceptable
- claim pressure and checkpoint churn stay near the database

Main caution:

- if the deployment is actually multi-node, local SQLite stops being a coherent shared authority

### Vercel

Best DB choices:

- libSQL / Turso for onboarding
- PostgreSQL for stronger production semantics

Why:

- compute is short-lived
- database must be external
- `processOne()` / `processUntilIdle()` fit the invocation model well

Main caution:

- every correctness property depends on the external DB, not on the function lifecycle
- local SQLite is effectively out

### Netlify

Best DB choices:

- PostgreSQL
- libSQL / Turso

Why:

- similar to Vercel, but with a clearer split between ingress and background execution

Main caution:

- background functions still do not own durability; the database does

### Cloudflare Workers

Best DB choices:

- libSQL / Turso
- D1 only as a Cloudflare-specific, caveated path

Why:

- queue-driven wake-up matches `processOne()` well
- external DB keeps the runtime portable

Main caution:

- if the app is Cloudflare-only, Workflows is a serious alternative
- PostgreSQL is semantically strong but may be awkward operationally from Workers

### AWS Lambda

Best DB choices:

- PostgreSQL
- libSQL / Turso as a lower-friction but more caveated option

Why:

- SQS + Lambda + Scheduler maps naturally to enqueue / wake / sweep / reclaim
- external DB is already the normal shape

Main caution:

- queue delivery must not be treated as lease ownership

## Recommended Phase 1 Positioning

If Durably needs a crisp recommendation set for Phase 1, the cleanest positioning is:

### Recommended first paths

- `Vercel + Turso`
- `Cloudflare Workers + Turso`

### Recommended production paths

- `Vercel + PostgreSQL`
- `Fly.io + PostgreSQL`

### Supported but not semantic reference paths

- `AWS Lambda + PostgreSQL`
- `Netlify + PostgreSQL`
- `Netlify + Turso`

### Caveated / adapter-validation paths

- `Cloudflare Workers + D1`
- any libSQL target under meaningful contention until adapter tests are in place

## Phase 1 Questions That Still Need Explicit Answers

These should likely be resolved in the RFC text, not left implicit.

1. Is libSQL a first-class recommendation only for DX, or also a backend we are willing to defend semantically under contention?
2. Is D1 a Phase 1 target at all, or explicitly deferred until adapter tests exist?
3. For serverless-first paths, is `claimNext()` required to perform reclaim inline, or is an explicit sweep operation still part of the contract?
4. Do we want one semantic reference backend only (`PostgreSQL`), with others described as compatible adapters, or do we want both PostgreSQL and SQLite to be co-equal references?
