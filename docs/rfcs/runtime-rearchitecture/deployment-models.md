# Design: Deployment Runtime Models

## Goal

This document describes how Durably's runtime should be composed on different deployment targets.

It focuses on:

- what components exist on each platform
- how jobs are triggered
- how execution continues across short-lived invocations

It does not define storage contracts or core runtime semantics. Those remain in `core-runtime.md`.

## Recommended Entry Paths

If developer experience and low-friction adoption are primary goals, the recommended starting paths are:

1. `Vercel + Turso`
2. `Cloudflare Workers + Turso`

These are not the only viable deployments. They are the most attractive entry points for individual developers who want to start for free or near-free and avoid operating their own worker infrastructure.

At the same time, two production-oriented paths should remain highly visible:

- `Vercel + PostgreSQL`
- `Fly.io + PostgreSQL`

These are especially relevant when the project expects heavier concurrency, a more conventional operational database story, or long-running worker processes.

### Why `Vercel + Turso` Comes First

- familiar web application hosting model
- easy HTTP-first deployment story
- strong fit for side projects and solo-built SaaS products
- Turso preserves a SQLite-shaped data model without requiring a resident file-based database

### Why `Cloudflare Workers + Turso` Comes Second

- excellent edge and event-driven story
- clean separation between ingress and short-lived execution
- still portable because the database can remain outside the platform runtime

### Production-Oriented Paths Worth Keeping in View

`Vercel + PostgreSQL`

- keeps a familiar app-hosting model
- uses the clearest semantic database target
- is a natural next step when `Vercel + Turso` starts feeling too caveated or too small

`Fly.io + PostgreSQL`

- pairs well with resident workers
- is a strong fit when long-running processes are acceptable
- keeps the execution story simple while preserving a clear PostgreSQL-based semantic model

### Important Caveat About Cloudflare

Cloudflare Workflows is a serious platform-native alternative for durable execution.

That means the recommendation should be:

- use Durably on Cloudflare when portability across platforms or a database-centered runtime model matters
- use Cloudflare Workflows directly when a project is Cloudflare-only and wants the simplest platform-native durable execution model

Durably should position itself honestly here rather than pretending there is no overlap.

## Core Principle

Durably should not treat one process invocation as the unit of execution.

Instead:

- a `Run` is the durable execution unit
- an invocation is a temporary compute slice
- the database is the source of truth
- each useful boundary must be checkpointable
- correctness must not depend on a resident process

This principle makes both daemon and serverless deployments possible.

## Trigger Types

Across platforms, it is useful to separate triggers into four roles:

1. `Ingress`: create a run by calling `enqueue()`
2. `Kick`: try to start work soon after enqueue
3. `Sweep`: periodically recover backlog and expired leases
4. `Resume`: continue work in a later invocation

In most deployments, these roles are implemented by different platform features.

## Shared Runtime Shape

Regardless of deployment target, the desired shape is:

- API or webhook handlers call `enqueue()`
- short-lived workers call `processOne()` or `processUntilIdle()`
- checkpoints are persisted at step boundaries
- event streams are persisted before or as output is delivered
- later invocations can reclaim expired work and continue

## Model 1: Resident Worker / Always-On Server

This is the simplest deployment model.

### Composition

- application server
- resident worker loop
- database

### Trigger Flow

- HTTP or webhook handler calls `enqueue()`
- worker loop polls or blocks waiting for claimable runs
- worker renews leases while executing
- worker completes or fails the run

### Operational Shape

- best fit for VM, container, ECS, Fly.io machine, or Kubernetes worker
- lease renewal is straightforward
- low scheduling overhead
- easiest environment for long external calls or high-throughput draining

### Mental Model

The worker is a convenience layer over the runtime, not the runtime itself.

## Model 2: Vercel

Vercel is best treated as an ingress-and-short-worker environment.

### Composition

- Vercel HTTP functions for API and webhook ingress
- Vercel Cron for periodic sweep
- external database
- optional external queue for faster wake-up under load

### Trigger Flow

1. user action or webhook calls a Vercel function
2. the handler calls `enqueue()`
3. the handler may do a best-effort `processOne()`
4. Vercel Cron periodically calls a worker endpoint
5. that endpoint runs `processUntilIdle({ maxRuns })`
6. unfinished work is resumed by later invocations

### Recommended Use

- small to medium workloads
- products where HTTP ingress is primary
- cases where eventual progress is acceptable as long as durability is preserved
- individual developers who want the easiest low-cost starting point

### Important Constraint

Do not make correctness depend on in-function background continuation.

The safe design is:

- persist state often
- keep steps short
- assume the function may stop between steps

### Practical Variant

For higher urgency or larger backlog:

- keep Vercel for ingress
- add an external queue
- use queue messages as wake-up signals

The queue should not become the source of truth. The run record in the database remains authoritative.

## Model 3: Netlify

Netlify is naturally split into synchronous ingress and background processing.

### Composition

- Netlify Functions for ingress
- Netlify Background Functions for longer processing
- Scheduled Functions for sweep
- external database

### Trigger Flow

1. user action or webhook hits a normal function
2. the handler calls `enqueue()`
3. the handler triggers a background function
4. the background function runs `processUntilIdle({ maxRuns })`
5. Scheduled Functions recover backlog and expired leases

### Recommended Use

- products that want a hosted serverless model without adding many external moving parts
- workloads that benefit from explicit async background handoff

### Important Constraint

Background execution is still temporary compute, not durable ownership.

The database lease remains the execution authority.

## Model 4: Cloudflare Workers

Cloudflare is the cleanest serverless fit when paired with Queues and Cron Triggers.

### Composition

- Workers HTTP handlers for ingress
- Cloudflare Queues for wake-up and deferred processing
- Queue consumers for processing
- Cron Triggers for sweep
- external durable database

### Trigger Flow

1. HTTP ingress calls `enqueue()`
2. the handler pushes a wake-up message to a queue
3. a queue consumer calls `processOne()` or `processUntilIdle({ maxRuns })`
4. Cron Triggers recover stale or missed work
5. later consumers reclaim and continue unfinished runs

### Recommended Use

- event-driven systems
- workloads that already fit queue-based wake-up
- applications that want a strong separation between ingress and execution
- developers who want an edge-first alternative to the Vercel entry path

### Important Constraint

Queue messages should be treated as wake-up signals, not as the durable job state.

The database must remain the continuity boundary.

## Model 5: AWS Lambda

AWS Lambda is the most explicit queue-driven serverless model.

### Composition

- API Gateway or webhook endpoint for ingress
- Lambda functions for handlers and workers
- SQS for wake-up and retry
- EventBridge Scheduler for sweep
- external durable database
- optional DLQ and alarms

### Trigger Flow

1. HTTP or webhook ingress reaches Lambda
2. the handler calls `enqueue()`
3. the handler sends a wake-up message to SQS
4. an SQS-triggered Lambda calls `processOne()` or `processUntilIdle({ maxRuns })`
5. EventBridge periodically runs sweep jobs
6. later Lambda invocations reclaim and continue unfinished runs

### Recommended Use

- systems that want the clearest operational separation
- workloads that need mature retry, queueing, alarm, and DLQ patterns
- higher-scale background execution

### Important Constraint

SQS delivery is not the source of truth for execution ownership.

Lease ownership still belongs to the run record in the database.

## Choosing a Platform Model

A rough heuristic is:

- choose `Vercel + Turso` as the default recommendation for solo developers and small new projects
- keep `Vercel + PostgreSQL` in view for web-first products that want the clearest production database story
- keep `Fly.io + PostgreSQL` in view for products that are comfortable with resident workers and want operational simplicity at runtime
- choose resident workers when you control long-running processes and want the simplest execution model
- choose Vercel when ingress-first product development matters more than background throughput
- choose Netlify when you want a simpler hosted split between sync and async functions
- choose Cloudflare when queue-driven edge-oriented event handling is the natural platform shape and platform lock-in is acceptable
- choose AWS Lambda when you want the clearest serverless operations model with explicit queueing and scheduling

Another heuristic is:

- if you are already committed to Cloudflare and do not need runtime portability, evaluate Cloudflare Workflows before choosing Durably

## Design Rules That Should Hold Everywhere

These rules should not change across platforms:

- `enqueue()` is durable and idempotency-aware
- `claimNext()` is atomic
- completion and failure are lease-owner-sensitive
- every long task is broken into checkpointable steps
- streaming output is recoverable from persisted events
- correctness does not depend on a polling loop, a single machine, or in-memory state

## Recommended First-Class Story for Durably

Durably should explicitly support two first-class runtime stories:

1. resident worker deployments
2. short-lived invocation deployments centered on `processOne()`

Everything else should be documented as platform adapters around those two shapes.
