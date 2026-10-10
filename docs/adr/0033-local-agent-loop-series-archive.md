# ADR-0033: Archive every stopped run of a local-agent-loop task at once, and never clear stops on delivery

## Status

accepted

## Context

A task of the local-agent-loop example is a first run and every repair run below it (ADR-0022), grouped by `groupTasks`. A task that took several repairs often ends delivered with stops left behind: the first run stopped as `verification-failed`, a repair stopped at the review cap, a later repair was approved. A stop leaves the top of `demo status` only when a person archives it (ADR-0027) or a later approved repair of the same parent replaces it. Until now a person archived the stops one at a time: `demo archive --run` on the run `status` showed, then `status` again to find the next.

Archiving is more than hiding a row. It is the signal that a person is done with the stop, and ADR-0028 ties the removal of a stopped run's worktree, and with `--delete-branch` its branches, to that signal. A stop's worktree is the evidence a person reads to decide what went wrong.

## Decision

- **`demo archive --series <runId>`.** It finds the task the run belongs to, by the same parents `repairParentId` reads (the `repairOf` label, else the stored input) and the same grouping `taskRunIds` uses, and applies the existing `archiveRun` to each of its runs that `archivable` allows, oldest first. Any run of the task may be named: the first run, a repair, a repair of a repair, one still open, or one approved and delivered. The shared function `archiveSeries` lives in `src/actions.ts` beside `archiveRun`.
- **Only stops, and every stop.** Runs that wait on a person, run, are queued, or finished approved are skipped without an error; nothing about the task's delivery limits or widens what is archived. A stop that is already archived is passed to `archiveRun` again, so the worktree cleanup it retries on a second archive (ADR-0028) is retried for the whole task. `--delete-branch` applies to each archived stop with the existing rule: a delivered run's branches are never deleted.
- **A failure does not end the walk.** When `archiveRun` throws for one stop, its reason is collected with its run ID and the next stop is archived. The command prints what it did for each run, each line and warning prefixed with the run ID, and exits nonzero when any stop was not archived.
- **`--run` is unchanged.** `--series` and `--run` exclude each other, and one of them is required. `demo archive --run` still takes exactly one stopped run and refuses any other, with the same messages.
- **`status` points at it.** Each task block in the text output of `demo status` has a `stops:` line when the task has stopped runs that are not archived: their count, a replaced stop included, and `demo archive --series <first run ID>`. The `Task` type, `status --format json` and the web UI's `/api/runs` are not changed, and the web UI gets no series action.

## Consequences

- Clearing a long series after it was delivered is one command, and `status` prints it.
- A person still decides when a stop is done: delivery never clears a stop, so a stop's worktree stays until someone archives it, and a mid-series run can still be archived, or kept, on its own with `--run`.
- A task whose stops are all archived leaves the top of `status` unless another of its runs waits on a person.
- The count is in the text only. A reader of `status --format json` or `/api/runs` counts a task's `runs` whose `kind` is `stopped` and `archived` is false.
- The web UI offers no series archive; a person there archives stop by stop, or runs the command `status` prints.

## Rejected Alternatives

### Count a delivered task's stops as resolved automatically

Rejected. Archiving is the signal ADR-0028 removes a stop's worktree on, and with `--delete-branch` its branches; resolving stops on delivery would either remove that evidence without a person's word or leave a resolved stop holding a worktree nothing would ever clean up. It would also take away the choice to keep a mid-series stop in view on its own: the delivered repair does not say the earlier failures were understood. A replaced stop (one a later approved repair of the same parent supersedes) already leaves the top of the list without being archived, and that narrower rule stays.

### Allow `--series` only on a delivered task

Rejected. The stops of a task that was abandoned, or is still being repaired, need the same cleanup, and a person who has read them should not have to wait for a delivery that may never come. Archiving only ever touches stops, so an open run of the task is safe either way.
