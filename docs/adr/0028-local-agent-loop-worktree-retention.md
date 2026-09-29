# ADR-0028: Remove a local-agent-loop run's worktree once the run no longer needs it

## Status

accepted

## Context

Every repository run of the local-agent-loop example cuts a Git worktree under the state root (`runs/<id>/work`, ADR-0017) and works, grades and reviews in it. Until now nothing ever removed it. The delivery is a branch and a commit in the source repository (ADR-0021), and a fix after delivery is a new run cut from that recorded commit (ADR-0022), so a delivered run's worktree is never read again. Yet each one stays, with the dependencies its setup installed, and the state root grows by a full checkout per run. `demo status` offered a non-forcing `git worktree remove` for each, which a person had to run one by one.

A stopped run is different. Its worktree is the evidence a person reads to decide what went wrong, so it has to stay until that person has decided they are done with the run. Archiving a stop (ADR-0027) is that decision.

Removing a directory inside a durable job has a replay problem. The job checks, outside its steps, that the worktree still holds the sealed candidate before each stage. A worker that dies after removing the worktree, but before the run is marked completed, replays every step on the next worker; those checks would find no worktree and fail a run whose delivery is already recorded.

## Decision

- **What may be removed.** Only a repository run's own worktree, `runs/<id>/work` as its setup recorded it, and its review snapshots. The spec, checkpoints, verification logs, candidate diffs, the delivery patch and record, the report and the database rows stay. The worktree is removed with `git worktree remove --force`, followed by `git worktree prune`. When git refuses, the directory is left as it is and the refusal becomes a warning; it is never removed some other way.
- **When a run removes it itself.** Right after an approved delivery is recorded in its step, the run removes its worktree in a step of its own and records the outcome on its output as `worktreeCleanupWarning`: null when removed, git's message when not. A failed removal never fails the run; the run is approved and delivered either way, and `status`, the report and the web UI show the warning while the worktree is still there. Rejected runs, runs that stopped, and runs that completed without a delivery keep theirs.
- **Replays never ask for a removed worktree.** Before removing, the run writes a marker file in its own directory (`worktree-removed`). While it exists, the repository target skips the integrity checks it makes outside steps and reads the sealed commit where it would have read the worktree's `HEAD`. Every step those checks guard is recorded by then, so the replay reads them back and nothing is delivered or removed twice. Delivery itself reads the sealed candidate commit, not the worktree.
- **Archiving removes it too.** `archiveRun`, shared by `demo archive` and the web UI, keeps its checks and its marker, and also removes the worktree and review snapshots. It does so even when the run already was archived, so running it again retries a removal that failed. Unarchiving does not bring the worktree back.
- **`demo prune` for runs from before this change.** It lists every repository run that has ended, was approved and delivered or is an archived stop, and still has its worktree, with each worktree's size and the total; it removes nothing unless `--apply` is given, and running it again after it succeeded finds nothing. The choice is read from the stored run, its setup, its delivery and the archive markers, never from directory names. A pending, leased or waiting run is never touched, whatever marker it has; neither is a stop nobody archived, a rejected run, or one that completed without a delivery.
- **Branches stay unless asked.** The automatic removal, archiving and `demo prune --apply` keep every branch. `demo archive --delete-branch` and `demo prune --delete-branches --apply` delete the recorded factory branch of an archived run (`factory/issue-<n>-<id>` for a run from an issue) and its `factory/<id>-squashed`, after its worktree, since git refuses to delete a checked-out branch. `prune --delete-branches` without `--apply` lists them. A delivered run's branches are never deleted: they are the delivery, and a repair run is cut from them.
- **Nothing shows a removed path as a place to work.** The report has a `worktree` field with the recorded path, whether it is present, and the warning; its Markdown says the worktree was removed and what is kept. `demo status` says the same in its diagnosis, and the web UI's detail shows "作業ツリーは片付け済み". The UI reads whether the worktree exists again on every request, also when it serves a finished run's cached report, because an archive or a prune changes it without changing the run.

## Consequences

- The state root keeps what explains a run and drops what only served the work: a finished repository run costs its logs and records, not a checkout with installed dependencies.
- A person who wants to look at a delivered run's files checks out its branch, or starts a repair run, instead of opening a directory under the state root.
- A removal git refuses is visible and can be retried (`demo archive` again, or `demo prune --apply`), and it never turns a delivered run into a failed one.
- The worktree marker is one more file in a run's directory. It is read only by the run's own target during a replay.
- Deleting branches is a separate, explicit choice, limited to archived runs, so the default cleanup can never remove the only reference to delivered work.

## Rejected Alternatives

### Keep every worktree and leave removal to the person

Rejected. It is how the example worked, and the state root grew by a checkout per run while nothing read them.

### Remove the worktree of every finished run, stops included

Rejected. A stop's worktree is the evidence a person inspects before deciding what to do. Only archiving says that person is done with it.

### Fall back to deleting the directory when git refuses

Rejected. Git refuses for a reason, such as a locked worktree, and deleting the directory behind its back leaves a registration pointing nowhere and may destroy something a person meant to keep. A warning and a retry keep the decision with the person.

### Move the integrity checks into the steps instead of a marker

Rejected. The approval stage checks the candidate around a durable wait, not a step, so its checks cannot be told whether they run on a replay. A marker written by the run after its delivery is recorded covers every stage the same way.

### Delete a delivered run's branches with its worktree

Rejected. The branch and commit are the delivery (ADR-0021), and a repair run is cut from them (ADR-0022).
