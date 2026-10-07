# ADR-0032: local-agent-loop stops silent agent calls, and a call it stops is a known outcome

## Status

accepted

## Context

A repository run of `examples/local-agent-loop` gave every agent call one limit, `agentTimeoutMs`, counted from the start of the call, with a default of 30 minutes. In artifactshare run `01M4AKNXMBXBHHHDJ7NCJBREZG` (issue #292), the first implementation was still working when it reached that limit. The run ended as `uncertain-invocation`, the stop for a call whose outcome nobody can know, and the work the agent had left in the worktree never became a candidate.

That classification was wrong for this stop. When a worker dies or loses its lease mid-call, nothing records whether the provider received the prompt or what it did, so the factory refuses to send it again. When the factory's own timer stops a call, the factory knows why the call ended and what it left in the worktree. One limit also cannot tell a long call that is still working from a call that has stopped making progress. A limit high enough for the first is far too high for the second.

## Decision

- **Two limits on every agent call.** `agentTimeoutMs` stays the total limit from the start of the call. A new `agentIdleTimeoutMs` stops a call that shows no sign of the agent at work for that long. Activity, agent output and partial usage each restart the idle timer. Codex reports every stream part that shows work, including preliminary tool-result deltas, and Claude reports assistant messages, tool results and tool progress messages. Both timers stop the call through the same controller, and the runner records which one fired and its limit. Once the call ends, both timers are cleared, and a late notice does not restart them.
- **The runner's timers decide.** The provider gets a total limit 60 seconds later than the runner's, so its own copy never ends the call first. A stop counts as the factory's only when the runner's own timer fired. A timeout error from the provider is handled like any other error.
- **A factory timeout is a settled outcome.** When the runner's timer stopped the call, and neither the run signal (cancel, lost lease) nor supersede did, the runner writes a completed checkpoint with `result: null` and `timedOut: { kind, limitMs }`. The attempt keeps its partial usage and is recorded as `timed-out`. A replay reads the checkpoint back and never sends the prompt again. A worker that dies before the checkpoint is written still leaves a start-only checkpoint, which stays `uncertain-invocation`.
- **Partial work from implement and repair is sealed.** After a timed-out implement or repair call, the code stage checks the worktree against the candidate the call started from (the base for the first implementation). If it changed, the work is sealed the same way a finished call's work is, and the candidate and its iteration record that a timed-out call produced it. The candidate is verified as usual. If the check fails, the run spends one of its existing repair iterations, and the next repair prompt says that the previous call was stopped at its time limit and that its unfinished work is the current candidate. If the worktree did not change, the run stops as `agent-timeout`.
- **Every other role stops the run.** A factory timeout on spec authoring, spec fixing, spec review, review or preflight stops the run as `agent-timeout`. Triage keeps its existing rule: any error, a timeout included, is recorded as `unknown` and the run goes on. `agent-timeout` is `retryable: true` and offers `demo retrigger --run <id>`, plus the `--reload-config` retry for a repository run whose limits come from `factory.json`.
- **New defaults.** A repository run allows 2 hours in total and 15 minutes without activity. The bundled sample keeps its 5-minute total, and its idle limit is also 5 minutes. When the idle limit comes from a default, it is shortened to the total limit if that is lower. An idle limit given in `factory.json` or `AGENT_IDLE_TIMEOUT_MS` that is longer than the total is refused at trigger, before any worktree exists.
- **Fixed like the other timeouts.** The idle limit is resolved at trigger from `factory.json`, then `AGENT_IDLE_TIMEOUT_MS`, then the default. It is stored in the run input and read from the setup on every replay. A plain `retrigger` keeps it, `--reload-config` reads the file again, and a `demo repair` child inherits its parent's value. Like `agentTimeoutMs`, it is part of `configVersion`. The report shows both limits.

## Consequences

- A long call that keeps working is no longer cut off at 30 minutes, and a call that has gone silent is stopped after 15 minutes instead of being left to run.
- Work the agent did before a factory timeout is kept, verified and either repaired or delivered, instead of being lost with an `uncertain-invocation` stop.
- A sealed candidate can now contain unfinished work. It goes through the pinned check and the reviews like any other candidate, and the report and the trace mark where it came from.
- Every run's `configVersion` changes, because the idle limit is now part of the hash.
- A run set up before this change has no idle limit in its setup and keeps the total limit only.

## Rejected Alternatives

### Make `uncertain-invocation` runs repair parents

A `demo repair` child could start from whatever a run that stopped as `uncertain-invocation` left in its worktree. Rejected. That stop exists for calls whose outcome is unknown: the worker stopped or lost its lease, and the call may still be running somewhere, or may have finished, or may never have started. Building on its worktree would treat an unknown outcome as a known one. The timeout case did not need that path, because the factory knows the outcome when its own timer stops the call.

### Raise the total limit only

Raising `agentTimeoutMs` alone would have let the artifactshare call finish, but a stuck call would then hold a worker for hours before anything noticed. The idle limit catches a stuck call quickly without cutting off one that is still working.

### Treat every timeout as a known outcome

A provider's own timeout, or a timeout error that arrives together with a cancel or a lost lease, does not tell the factory that the call ended where it thinks it did. Only the runner's own timer, with neither the run signal nor supersede aborted, is read as the factory's stop. Every other error keeps the existing rules.
