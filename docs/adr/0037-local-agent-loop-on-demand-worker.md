# ADR-0037: local-agent-loop starts a worker when a run needs one, and the worker stops when it has no work

## Status

accepted

## Context

`examples/local-agent-loop` ran its runs on one long-lived process, `demo worker`, that the person started in a terminal and kept up until they stopped it. In practice an agent such as Claude Code often started it. The worker then joined the process group of the shell the agent launched, and when the agent cleaned up that group, the worker received SIGTERM and ended. Its shutdown recorded nothing about the signal. Issue #302 reports that this happened repeatedly: the worker disappeared after a run finished or while one waited on a person, and the next `trigger` or `repair` run stayed `pending` with no sign of why.

A resident service (a LaunchAgent, a systemd unit) would keep a worker up, but it is one more piece of setup for every machine the factory runs on, which the issue explicitly wants to avoid. What the factory needs is a worker for as long as some run needs one, started where the run is started, and a record of why each worker stopped.

Deciding when a worker is no longer needed has to follow Durably's own run states. A `pending` run needs a worker, and so does a `leased` one, whether its lease is live or has expired and will be reclaimed. A run a person has approved, rejected or answered with `spec-revise` stays `waiting`, with its wait row `resolved`, until a worker claims it. A worker that counted only `pending` and `leased` runs could stop right after an `approve` and leave that run behind.

## Decision

- **A worker that stops when idle.** `demo worker --exit-when-idle [--idle-ms <ms>]` stops once it has had no work for the idle period, 30000 ms by default. `--idle-ms` takes an integer from 1 to 2147483647 and is refused without `--exit-when-idle`. Work is a `pending` run, a `leased` run whatever its lease, or a `waiting` run whose current wait is `resolved`. A `waiting` run whose wait nobody has decided is not work. The check reads the database through the existing `getRuns` and `getWait`; `@coji/durably` itself does not change.
- **The check never overlaps itself and fails safe.** The worker checks every 500 ms, or every idle period when that is shorter, and starts a check only after the previous one settled. A check that cannot read the database is not idle: the error goes to stderr and the idle clock starts again.
- **One more look before stopping.** When the idle period has passed, the worker stops polling and checks once more. If work appeared, it starts polling again and handles it. A run created between this last check and the release of the lock sees a worker and its command starts none. So on the idle path only (not on SIGTERM or SIGINT), the worker checks for work once more after releasing the lock and, if there is some and no worker holds the lock, starts a successor the same way a command does (the same opt-out and lock probe apply), logs `[idle] work arrived as the worker stopped; started a successor (pid N)`, and then closes the database. Each command stores its run before probing the lock, so a run the command saw as covered by a worker was stored before that worker let go and is seen by this check. A successor does the same on its own idle exit. A run is left behind only when the successor fails to start or auto-start is switched off; `demo wait --worker-timeout` reports such a run (exit 6), and the README says to start `demo worker` then.
- **Commands that create work start a worker.** After `trigger`, `repair`, `retrigger`, `approve`, `reject` and `spec-revise` succeed, the CLI checks for work. When there is some, it probes the existing single-worker lock. With no worker it starts `worker --exit-when-idle`; with one it does nothing. When the probe cannot tell (`running: null`), it starts none and prints a warning. A command that failed or whose input was refused starts nothing. The worker lock (`acquireWorkerLock`) remains the only guard against two workers on one state root. `trigger` starts the worker before it prints its JSON, so the JSON's `worker` field never tells the caller to start a worker by hand that the command has just started: with an auto-started worker, `start` is null and `autoStarted` gives its pid and log file; otherwise the field is unchanged.
- **The started worker is detached.** It runs from the same Node executable and `process.execArgv` as the command, so `pnpm demo`'s tsx loader carries over, in a new session (`detached: true`), with stdin ignored and `unref()`, and the command does not wait for it. Ending the launching shell's process group does not end the worker. It runs the CLI of the checkout where the command was run, which `worker.json` records as `checkout`. On a shared state root, a command run from a checkout other than the pinned one (ADR-0017) can therefore start a worker from that checkout; a person who wants the pinned checkout's worker keeps one running there or switches auto-start off.
- **Stdout stays the command's.** Every auto-start message, the success line with the worker's pid and log file and every warning, goes to stderr, so the JSON that `trigger`, `approve` and the others print stays parseable. A failed start (spawn error, a log file that cannot be opened, an invalid idle period) is a warning and does not change the command's exit code, because the run is already stored.
- **Opt-out and idle period.** `--no-auto-worker` on any of these commands, or `LOCAL_AGENT_LOOP_NO_AUTO_WORKER=1`, starts no worker; the run stays `pending` until one comes. `LOCAL_AGENT_LOOP_IDLE_MS` sets the started worker's idle period, with the same range as `--idle-ms`.
- **A dated log and a recorded reason.** The started worker appends its stdout and stderr to `<state root>/logs/worker-YYYY-MM-DD.log`, named by the local date it started, and never truncates it. Every worker, with or without `--exit-when-idle`, logs `[shutdown] reason=<SIGTERM|SIGINT|idle>` when it stops. The first reason wins and a later signal does not start a second shutdown. It then stops the agent CLIs it launched, stops Durably, releases the lock, (after an idle stop) starts a successor if work arrived, closes the database, waits until stdout and stderr have taken every line, and exits 0. A signal received during startup stops the worker once the migration and snapshot sweep finish, without it ever polling for runs.
- **Plain `demo worker` is unchanged.** Without `--exit-when-idle` it stays up until stopped and keeps the single-worker lock. The web UI still never starts a worker (ADR-0027): a decision made on the page waits for a worker as before.

## Consequences

- A run started from an agent session no longer depends on a worker someone remembered to keep up, and a worker started this way survives the agent cleaning up its own process group.
- No worker runs while nothing needs one, and no resident service has to be installed.
- Every worker stop now leaves its reason in the output, and a started worker's output is kept in a dated file under the state root.
- Tests and scripts that expect a run to stay `pending` without a worker must opt out. The example's existing CLI test harnesses set `LOCAL_AGENT_LOOP_NO_AUTO_WORKER=1`, and the tests that exercise auto-start use a temporary `HOME` and stop every worker they start.
- The idle-exit window is closed by the successor check; a run is left behind only when the successor fails to start or auto-start is switched off, and `demo wait` reports it.
- A decision made on the web UI is picked up only by a worker that is already running or by the next CLI command that starts one.

## Rejected Alternatives

### A LaunchAgent or systemd service

Rejected. It would keep a worker up, but it adds per-machine setup outside the repository, which issue #302 set out to avoid, and it keeps a worker running when nothing needs one.

### Keep only the manual long-lived worker

Rejected. That is the setup that failed: a worker started from an agent session ends with the agent's process group, records nothing, and leaves the next run `pending`.

### Start the worker in the launching command's process group

Rejected. A worker attached to the command's session or process group is cleaned up with it, which is the failure this decision fixes. The worker has to lead a session of its own.

### Start a worker from the web UI

Rejected for now. ADR-0027 made the UI server write through the CLI's functions without taking the worker lock or starting a worker, and auto-starting from the page is outside the scope of #302.

### Count only `pending` and `leased` runs as work

Rejected. A run a person has decided stays `waiting` with a resolved wait until a worker claims it, so a worker that ignored it could stop right after `approve` and leave the run stuck.
