# Server Node.js Example (libSQL/Turso)

Minimal Node.js example using Durably with libSQL (Turso-compatible) as the storage backend.

## Getting Started

```bash
# Install dependencies
pnpm install

# Run the example
pnpm dev
```

This runs `basic.ts`, which initializes Durably, triggers a job, and displays run statistics.

## Standalone Use

To use this example outside the monorepo, remove the `workspace:*` dependency and install from npm:

```bash
pnpm add @coji/durably
```

## What It Demonstrates

- Creating a Durably instance with libSQL dialect
- Defining and registering jobs with `defineJob()`
- Triggering jobs with `triggerAndWait()`
- Joining concurrent named steps with `step.all()` and branch-specific `attempt.log`
- Subscribing to run and step events
- Querying run statistics via Kysely

## Durable external wait

Run `pnpm --filter example-server-libsql exec tsx durable-wait.ts` from the repository root. The example prepares an approval address, suspends one run, processes other work, recreates the runtime against the same SQLite file, and delivers an idempotent signal to resume the original run. It uses manual processing so each stage is visible. The database is saved as `durable-wait-example.db` in this example directory.

A real approval UI or CI poller must authorize the decision and validate its target before calling `signal`. This example demonstrates a durable timeout.

Run `pnpm --filter example-server-libsql exec tsx ci-poller.ts` for an outbound CI polling flow. It suspends run A with one worker slot, completes B, recreates the runtime against SQLite, skips an old commit result, delivers the current result through the HTTP handler, and verifies that a duplicate signal does not start downstream work twice. The provider query is an offline mock; replace it with your CI provider's authenticated read API and use `fetch` for the handler request in a separate poller process. Keep the expected commit in wait metadata and validate the returned commit against both the wait and run before signaling.

Run `pnpm --filter example-server-libsql exec tsx human-input.ts` to answer a local approval prompt. It reads the saved wait and submits a boolean decision through the HTTP handler with run-label authorization and application payload validation.
