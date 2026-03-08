# RFC: Runtime Rearchitecture

## Purpose

This RFC describes the proposed rearchitecture of Durably's runtime.

Durably is a job runtime for Node.js and browsers. You define a job as a sequence of steps; each step's result is saved to the database. If a worker crashes, another picks up where it left off. The database—not the process—is the source of truth.

## Recommended Starting Point

If the goal is to make Durably easy for an individual developer to try with minimal cost and setup complexity, the recommended entry path is:

- `Vercel + Turso`

Why:

- both have generous free entry points
- Vercel is a familiar deployment target for web-first solo projects
- Turso gives a SQLite-shaped database without requiring a long-running local file on the server
- this combination keeps the runtime model portable without forcing users into a heavier infrastructure story

The next most relevant path is:

- `Cloudflare Workers + Turso`

This path is attractive when edge deployment and event-driven execution matter more than Vercel-style app hosting.

Common production-oriented paths that should remain in view are:

- `Vercel + PostgreSQL`
- `Fly.io + PostgreSQL`

These are not the lowest-friction entry points, but they are important real-world deployment shapes for products that move beyond the smallest setup.

## Cloudflare Note

Cloudflare Workflows overlaps with some of the problems Durably wants to solve.

That means the positioning should be explicit:

- if a project is fully committed to Cloudflare and is happy with a Cloudflare-specific durable execution model, Workflows may be the simpler choice
- if a project wants a database-centered runtime that can keep the same execution model across Vercel, Cloudflare, AWS, and local development, Durably still has a clear role

Durably should not pretend that Cloudflare Workflows does not exist. The RFC should treat it as a strong platform-native alternative, especially for Cloudflare-only applications.

The documents in this directory are structured by reading order:

1. `core-runtime.md`
2. `deployment-models.md`
3. `database-runtime-fit.md`
4. `database-claim-patterns.md`
5. `database-adapter-sketches.md`
6. `ambient-agent-concepts.md`

Japanese translations live under `ja/`.

## Reading Guide

> **Which documents should I read?**
>
> - **Using Durably or evaluating it** → Read 1 and 2. That covers the runtime model and how it maps to your deploy target.
> - **Implementing a database adapter** → Add 3 (all three database documents).
> - **Curious about the future direction** → 4 is optional and can be skipped.

### 1. Core

- [core-runtime.md](./core-runtime.md)
  The main RFC. Defines the core runtime model, with `processOne()` as the center of the portable contract, plus the unified store interface and phase split.

### 2. Deployment

- [deployment-models.md](./deployment-models.md)
  How the runtime composes across resident workers and serverless platforms.
  Start here if you want the practical recommendation behind `Vercel + Turso` and `Cloudflare Workers + Turso`.

### 3. Database (adapter implementors)

- [database-runtime-fit.md](./database-runtime-fit.md)
  Choosing a database — which databases are good semantic fits for the runtime.
- [database-claim-patterns.md](./database-claim-patterns.md)
  Implementing an adapter — how each backend implements internal claim paths and lease ownership semantics behind the runtime contract.
- [database-adapter-sketches.md](./database-adapter-sketches.md)
  Concrete PostgreSQL and SQLite query sketches.

### 4. Future Direction (optional — skip if you just want to use Durably)

- [ambient-agent-concepts.md](./ambient-agent-concepts.md)
  Product-level interpretation of ambient agents as an extension on top of the runtime. This is Phase 2 thinking and not required for understanding the core runtime.

## Japanese

- [ja/README.md](./ja/README.md)
- [ja/core-runtime.md](./ja/core-runtime.md)
- [ja/deployment-models-ja.md](./ja/deployment-models-ja.md)
- [ja/database-runtime-fit-ja.md](./ja/database-runtime-fit-ja.md)
- [ja/database-claim-patterns-ja.md](./ja/database-claim-patterns-ja.md)
- [ja/database-adapter-sketches-ja.md](./ja/database-adapter-sketches-ja.md)
- [ja/ambient-agent-concepts-ja.md](./ja/ambient-agent-concepts-ja.md)
