# ADR-0025: Reuse a passing local-agent-loop baseline result within a fixed age

## Status

accepted

## Context

ADR-0019 added the baseline check: with `"baselineCheck": true`, a repository run sets up a fresh worktree, checks that setup left no untracked file `.gitignore` does not cover, and runs the pinned check on the base commit before any agent call. Every run pays for that check. When several runs start from the same repository and base commit, as when a person triggers a batch of issues or retries after a setting fix, each one repeats a check that takes minutes and gives the same answer.

The baseline only proves that the pinned check can pass on the base commit in this environment. That fact does not change between runs with the same inputs and environment, so a recent passing result can stand in for a new one. What must not change are the guarantees ADR-0019 gives the first candidate: it starts from a worktree that is at the base commit, has no tracked changes, and holds no untracked output that would be sealed into it.

## Decision

- **Setting.** `factory.json` takes `"baselineReuse": { "maxAgeMs": <n> }`. `maxAgeMs` is a positive safe integer; zero, negative numbers, fractions, `NaN`, `Infinity` and values above `Number.MAX_SAFE_INTEGER` are refused at trigger. It is fixed into the run input, inherited by a repair run from its parent's setup, and read again by `retrigger --reload-config`. Left out, nothing changes. It is read only on a repository run with `baselineCheck` on; without the baseline check there is no lookup and no check.
- **What may be reused.** Only a completed baseline step of another run in the same state database whose result was measured in that run and passed. A failed result, an unfinished step, a result that was itself reused, and a record from before this change, which has no identity, are never used. So a reused result always points at the run that actually ran the check.
- **What must match.** The normalized repository root (symbolic links resolved), the base commit, the `check` and `setup` argv, `checkTimeoutMs`, and an environment identity made of the Node.js version, the OS platform, the architecture, and the file the check's first word runs, resolved from the worktree and PATH with symbolic links resolved (a file inside the worktree is named relative to it). If any value cannot be resolved, the run neither reuses a result nor leaves one another run can reuse. Nothing else is compared: installed dependencies, environment variables, the programs the check calls in turn and ignored files are outside the identity. The README says so.
- **Age.** A result's age runs from the completion of its baseline step to the moment the reusing run decides. A reused result never counts as a new measurement, so it never extends the age of the original. Among the results within `maxAgeMs`, the newest is used. A result whose completion time is later than the decision time, as a clock set back can produce, is not used. If reading the candidates fails, the check runs as usual.
- **Setup and the worktree.** Setup still runs on every run and cuts a new worktree, and the ADR-0019 check for untracked setup output is not skipped. Before the check is skipped, the baseline step also proves that the worktree is at the base commit, has no changes to tracked files and has no untracked file `.gitignore` does not cover. Failing that stops the run as `baseline-check-failed`, before any agent call, as a measured baseline would.
- **Recording.** The baseline step's output records whether the result was measured or reused, the identity it was compared by, and for a reused result the source run ID and the source step's completion time. Identity and settings are recorded in the setup step. A replay of a completed baseline step reads the output back and never searches again, so the choice cannot change. A baseline step that has already started measuring in this run (its start checkpoint exists) finishes by measuring, so an interrupted check is never swapped for a reused result.
- **Report and UI.** A reused result cites the source run's check log by path; the log is not copied. When that log no longer exists, the report gives `log: null` with the reason. Whether the verdict was recovered from a checkpoint follows what the source run recorded. The report's JSON (`baseline.reusedFrom`) and Markdown (the Baseline check section's `source` line), and the web UI's baseline stage, label the result as reused and name the source run and its check time, so it is never mistaken for a measurement of this run. Records written before this change still read as before.
- **Config version.** `baselineReuse` changes neither what the agents see nor how candidates are graded, so it is left out of `configVersion`, and the hash is computed as before whether the setting is present or not.

## Consequences

- A batch of runs from one base commit pays for one baseline check within the age, plus one setup per run.
- The identity is deliberately narrow. A change it does not see, such as a dependency updated without a lockfile change or an environment variable the check reads, can let a stale pass stand in for a failing base until the age runs out. The first candidate's verification still runs the check, so such a case surfaces as a verification failure rather than as a wrong approval. A person who expects such changes shortens `maxAgeMs` or leaves the setting out.
- A reused run's report depends on the source run's log for the full output. Removing the source run's directory leaves the verdict and the source, and drops the log with a reason.
- Results are not shared across state databases, and records made before this change are never migrated or reused.

## Rejected Alternatives

### Skip setup when a result is reused

Rejected. The worktree the first candidate is built in would then differ from the one a measured baseline prepares, and ADR-0019's check for untracked setup output would be bypassed.

### Reuse failed results

Rejected. A failing base stops the run before any agent call already; reusing a failure would stop runs whose environment has since been fixed, without letting them try.

### Chain reuse, taking the age from the last reuse

Rejected. A result could then stay valid indefinitely without the check ever running again. Only a measured result can be a source, and its own completion time bounds its age.

### Compare a hash of the whole environment or the dependency tree

Rejected for now. Deciding what belongs in it, and hashing it on every run, costs more than the check it would save for many repositories, and a partial hash would give a false sense of completeness. The identity names exactly what it covers, and the age bounds what it misses.

### Put `baselineReuse` in the config version

Rejected. The setting does not change what the agents are asked or how candidates are graded, so runs with and without it are fair to compare, and compare would split them for no reason.
