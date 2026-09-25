# ADR-0019: local-agent-loop stops on setting and environment problems before any LLM call

## Status

accepted

## Context

Real runs of `examples/local-agent-loop` (issue #239) paid for implementation tokens before finding out that nothing could succeed. The pinned check already failed on the base commit, so no candidate could ever pass. A review profile named a model the account could not use, and that was only found at review time. Two other problems made results hard to read. A second worker, left over from an earlier experiment, could pick up a run. And timeouts came from whichever worker's environment picked up the run, so the same run could behave differently depending on where it ran.

Two rules had to stay as they were. A verification that was cut off is graded again on resume, because running the check again is free. An agent call that started but has no completed checkpoint is never sent again automatically, because it may already have been billed and acted on.

## Decision

- **Baseline check.** With `"baselineCheck": true` in `factory.json`, the pinned check runs once on the base commit, in the freshly set up worktree, before any agent call. It is off by default. It uses the same checkpoint pair as verification, so a completed result is read back on resume and a check that was cut off is graded again. A failing check stops the run as `baseline-check-failed`. So do a check that cannot start, and setup or a check that leaves changes to tracked files. After a passing check, the untracked files that are not ignored and were not there before the check are removed, so its output is never sealed into the first candidate. Untracked files that setup wrote stay, because the candidates' checks may need them.
- **Preflight.** After the baseline and before the first agent call, including triage, every role's provider, model and effort is checked. Each distinct setting is checked once. A free check comes first (for Codex, `model/list` through the run's CLI). Only a setting the free check cannot decide gets one minimal paid call. That call goes through the same checkpoint and measurement path as every other call, so its usage is reported. A refusal is an explicit answer from the provider: a 4xx, a CLI that never started, or an authentication or model-not-found error. A start handshake that only timed out is not a refusal, because the CLI may just be slow to come up. It is recorded as a completed call, and the run stops as `preflight-failed`, which is safe to retry. The uncertain-call rule does not change: a minimal call with a start checkpoint and no completed one stops the run as `uncertain-invocation` and is never sent again. A model missing from `model/list` does not prove anything, because the list leaves out hidden models, so the minimal call decides.
- **Worker lock.** One worker per state root. The worker holds an exclusive SQLite transaction on `worker.lock` in the state root. SQLite holds it with the operating system's file lock, so it ends with the process, even after `kill -9`. A note beside the lock names the holder's pid, start time and checkout, and a refused second worker prints it.
- **Timeouts fixed at trigger.** `checkTimeoutMs` and `agentTimeoutMs` are resolved at trigger and stored in the run input: `factory.json` first, then the trigger's `TEST_TIMEOUT_MS` / `AGENT_TIMEOUT_MS`, then the target default. Values must be positive integers of at most 2147483647 ms, the largest delay Node's timers keep. The worker never reads those variables for a new run. Only a run stored before this change still reads them.
- **One Codex executable.** `codexPath` in `factory.json` is resolved against the config file, checked to be an executable file, and stored in the run. The preflight, every real call and the version probe all launch that one file, and the report and config version name it. Without it, the existing order stays: the bundled CLI first, then `codex` on PATH.
- **Retry after a config fix.** `retrigger --reload-config` starts a new run with the stored task and input files and the settings read again from the run's `factory.json`. It runs at most once for each version of that file. A plain `retrigger` keeps the stored settings and is for fixes to the environment only. A setting the run took from a command-line flag still wins over `factory.json`, so changing it needs a new trigger. A run that read the default `factory.json` which has since been removed reloads as a trigger without a config would. Only repository runs can reload.

## Consequences

- A broken check or an unusable model now costs at most one minimal call, and usually nothing, instead of an implementation round.
- Every run pays for a preflight at start: a `model/list` for Codex, which is read once per CLI file, and one minimal call for each distinct Claude setting.
- With `baselineCheck` on, every run takes one more full check run of time.
- Only one worker can serve a state root. A worker from before this change holds no lock, so during an upgrade the new worker does not refuse to start next to it.
- A run's timeouts and CLI can be read from its input, whatever environment the worker has.

## Rejected Alternatives

### Paying for a probe call for every role

Rejected. It costs money even when the provider can answer for free, and each probe is another call that can end up uncertain.

### Resending a preflight call whose outcome is unknown

Rejected. Doing this for the preflight alone would break the rule every other call follows: a call that may have been received is never sent again without a person checking.

### A pid file, or the README's `pgrep` / `pkill` advice, for worker exclusion

Rejected. A pid file goes stale after a crash, and the pid can be reused. The advice depended on people remembering it. An operating-system lock through the SQLite driver the example already ships needs no new dependency and is released when the process ends.

### Reading timeouts from the worker's environment

Rejected. Which worker picks up a run would decide how it behaves, and the report could not say which values applied.

### Accepting a `codexPath` directory or command name and looking it up at call time

Rejected. The preflight, the calls and the version record could then launch different files.
