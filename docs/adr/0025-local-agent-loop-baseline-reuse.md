# ADR-0025: Reuse a passing local-agent-loop baseline result within a fixed age

## Status

accepted

## Context

ADR-0019 added the baseline check: with `"baselineCheck": true`, a repository run sets up a fresh worktree, checks that setup left no untracked file `.gitignore` does not cover, and runs the pinned check on the base commit before any agent call. Every run pays for that check. When several runs start from the same repository and base commit, as when a person triggers a batch of issues or retries after a setting fix, each one repeats a check that takes minutes and gives the same answer.

The baseline only proves that the pinned check can pass on the base commit in this environment. That fact does not change between runs with the same inputs and environment, so a recent passing result can stand in for a new one. What must not change are the guarantees ADR-0019 gives the first candidate: it starts from a worktree that is at the base commit, has no tracked changes, and holds no untracked output that would be sealed into it.

## Decision

- **Setting.** `factory.json` takes `"baselineReuse": { "maxAgeMs": <n> }`. `maxAgeMs` is a positive safe integer; zero, negative numbers, fractions, `NaN`, `Infinity` and values above `Number.MAX_SAFE_INTEGER` are refused at trigger. It is fixed into the run input, inherited by a repair run from its parent's setup, and read again by `retrigger --reload-config`. Left out, nothing changes. It is read only on a repository run with `baselineCheck` on; without the baseline check there is no lookup and no check.
- **What may be reused.** Only a completed baseline step of another run in the same state database whose result was measured in that run and passed. A failed result, an unfinished step, a result that was itself reused, and a record from before this change, which has no identity, are never used. So a reused result always points at the run that actually ran the check.
- **Finding a candidate.** The factory keeps an index under the state root, `baseline-index/<SHA-256 of the identity>/<run ID>.json`, one file per run. Each file names one run whose measured baseline passed under that identity and when its check completed. A run writes only its own file, through a temporary file and a rename, after a measured baseline passes and again whenever that completed step is replayed, so an entry lost to a crash is made up. No run ever overwrites another run's file, so concurrent writers cannot replace a newer entry with an older one; pruning (below) is what keeps the directory bounded. A write failure is ignored, and later runs measure again. The index is only a list of pointers. A decision reads and parses every entry file in the identity's directory (bounded by pruning to about 20), drops entries that do not parse, are dated after the decision time (as a clock set back leaves them) or are older than `maxAgeMs`, and tries the rest newest first: it reads that run's completed baseline step from Durably and requires it to parse as a measured pass with an equal identity and within the age. The first that holds is used. If none holds, or reading fails, the check runs. A decision therefore costs reading every entry file in that one identity's directory (bounded by pruning), plus, per tried entry, one read of the named run's step, and one read of the chosen run's attempts.
- **Pruning.** Each write then prunes the identity's directory: it removes entries that do not parse, always keeps the writer's own entry, and among the rest keeps only the newest 19 by `checkedAt`, dropping the rest — 20 entries in total. Always keeping the writer's own entry means a run's freshly written entry is never pruned by its own write, even when 20 or more future-dated entries (as a clock set back can leave) already fill the identity's directory; a concurrent writer's entry, being among the newest, survives the same way. A file a concurrent writer has already removed is skipped, and a lookup never reads more than about 20 entries per identity. Directories for identities that stop being reused, such as an old base commit, are not removed by pruning or by anything else; they are left as documented, low-volume housekeeping (see Consequences).
- **What must match.** The normalized repository root (symbolic links resolved), the base commit, the `check` and `setup` argv, `checkTimeoutMs`, and an environment identity made of the Node.js version, the OS platform, the architecture, and the file the check's first word runs, resolved from the worktree and PATH with symbolic links resolved (a file inside the worktree is named relative to it). That lookup follows `spawn` on POSIX: a word with a slash is a path from the worktree, and otherwise the PATH entries are tried in order, an empty entry meaning the worktree. With PATH unset, or on Windows, whose lookup it does not reproduce, the executable is unresolved. The identity is resolved once, in the setup step, and a replay compares those values: a worker restarted between setup and the baseline step with another Node.js or PATH checks, or reuses, under the identity recorded at setup. If any value cannot be resolved, the run neither reuses a result nor leaves one another run can reuse. Nothing else is compared: installed dependencies, environment variables, the programs the check calls in turn and ignored files are outside the identity. The README says so.
- **Age.** A result's age runs from the completion of its check, as its completed checkpoint records it, to the moment the reusing run decides. A source whose step was saved only on a resume after the check completed therefore ages from the check, not from the resume. A record written before this time was kept falls back to its step's completion. A reused result never counts as a new measurement, so it never extends the age of the original. Among the results within `maxAgeMs`, the newest is used. A result whose completion time is later than the decision time, as a clock set back can produce, is not used. If reading the candidates fails, the check runs as usual.
- **Setup and the worktree.** Setup still runs on every run and cuts a new worktree, and the ADR-0019 check for untracked setup output is not skipped. Before the check is skipped, the baseline step also proves that the worktree is at the base commit, has no changes to tracked files and has no untracked file `.gitignore` does not cover. Failing that stops the run as `baseline-check-failed`, before any agent call, as a measured baseline would.
- **Recording.** The baseline step's output records whether the result was measured or reused, the identity it was compared by, the check's completion time for a measured result, and for a reused result the source run ID and the source check's completion time. Identity and settings are recorded in the setup step. A replay of a completed baseline step reads the output back and never searches again, so the choice cannot change. A baseline step that has already started measuring in this run (its start checkpoint exists) finishes by measuring, so an interrupted check is never swapped for a reused result.
- **Report and UI.** A reused result cites the source run's check log by path; the log is not copied. When that log no longer exists, the report gives `log: null` with the reason. Whether the verdict was recovered from a checkpoint follows what the source run recorded. The report's JSON (`baseline.reusedFrom`) and Markdown (the Baseline check section's `source` line), and the web UI's baseline stage, label the result as reused and name the source run and its check time, so it is never mistaken for a measurement of this run. Records written before this change still read as before.
- **Config version.** `baselineReuse` changes neither what the agents see nor how candidates are graded, so it is left out of `configVersion`, and the hash is computed as before whether the setting is present or not.

## Consequences

- A batch of runs from one base commit pays for one baseline check within the age, plus one setup per run.
- The identity is deliberately narrow. A change it does not see, such as a dependency updated without a lockfile change or an environment variable the check reads, can let a stale pass stand in for a failing base until the age runs out. The first candidate's verification still runs the check, so such a case surfaces as a verification failure rather than as a wrong approval. A person who expects such changes shortens `maxAgeMs` or leaves the setting out.
- A reused run's report depends on the source run's log for the full output. Removing the source run's directory leaves the verdict and the source, and drops the log with a reason.
- Results are not shared across state databases, and records made before this change are never migrated or reused.
- A new identity directory is created whenever the base commit, setup, check, timeout, Node.js version or PATH changes. Nothing removes an identity's directory once its base commit is no longer current; only its own entries are pruned. Over a long-lived state root this leaves one small directory of up to 20 small files per distinct identity ever seen. This is left undone deliberately: state roots are per-project and the volume is small, so cleanup was not worth adding at this time.

## Rejected Alternatives

### One index file per identity, replaced by a newer result

Rejected. A single entry replaced only by a newer one blocks reuse for good once an entry dated in the future is left by a clock set back, and two writers that read the entry at the same time can replace the newer result with the older one. A directory where each run writes only its own file has nothing to overwrite, and the lookup skips future-dated or invalid entries and falls back to the next.

### Scan every run's baseline step on each decision

Rejected. Reading every run of the job, with its stored input and output, and then one baseline step per run makes each decision grow with the retained history, although only the newest matching result can be chosen. The index names that result directly, and validating it against Durably keeps the database the source of truth.

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
