# ADR-0021: local-agent-loop delivers a squashed branch beside the iteration branch

## Status

accepted

## Context

A repository run of `examples/local-agent-loop` (issue #243) seals every iteration as its own commit on `factory/<runId>` (`factory/issue-<n>-<runId>` for an issue), authored by `durably-factory <durably-factory@localhost>` with the message `factory iteration <n>`. That branch is the run's record: each commit is a candidate the check and the reviews saw. It is a poor thing to merge. A pull request from it carries every intermediate iteration, and the author and messages say nothing about the change. People squashed and rewrote the branch by hand before merging, which also destroyed the record.

Delivery is a durable step. A worker can be killed after it made a branch or opened a pull request and before the step's result was stored, so delivery runs again on resume and must find what it left, not make a second one or overwrite something else.

## Decision

- **Iteration branch kept.** Delivery leaves the iteration branch as it is. It stays the run record, one commit per iteration.
- **Squashed branch beside it.** Delivery also makes `factory/<runId>-squashed`: one commit whose only parent is the base commit and whose tree is the last approved candidate's tree. It is built from refs alone, with `git commit-tree` and `git update-ref`, so no checkout or worktree moves. A candidate with the base's tree still gets its own commit, so the branch is always one commit ahead of the base.
- **Replay reuses, a mismatch is refused.** The squash commit is deterministic: its author and committer dates come from the source commit, and its author, message, parent and tree are fixed by the run. Delivery always computes the expected commit first (`commit-tree` writes an object but no ref). An existing branch is reused only when it points at exactly that commit. Any other branch by that name, including one with the same parent and tree but another author or message, stops delivery with an error and is left untouched. The ref is created with an empty old value, so a branch that appears in between is not overwritten either.
- **`publishSquashed` picks the published branch.** `factory.json` `commit.publishSquashed` (default `false`) decides which branch `--publish` pushes and opens the Draft PR from: the iteration branch, or the squashed one. Without `--publish` neither is pushed. Like `--publish`, it is not part of `configVersion`, because it does not change what any agent sees.
- **Existing pull request reused.** Before opening a Draft PR, delivery looks for an open pull request from the same head and returns it if there is one, so a replay never opens a second.
- **Author and message from `factory.json`.** `commit.authorName`, `commit.authorEmail` and `commit.messageTemplate` set the author and committer of every factory commit, iteration and squash alike, and the message template, in which `{iteration}`, `{runId}` and `{task}` (the task's first line) are replaced. Each field is optional and none may be empty. Without them the defaults above apply, and the squash commit says `factory run <runId>`. Identity is set through the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables of the git child process, so variables the worker inherits cannot override it. The settings are resolved at trigger and stored in the run. Author and template enter `configVersion`, because the agent sees them in its worktree history; a run that uses the defaults keeps its old version.

## Consequences

- An approved repository run leaves two branches in the source repository. The squashed one is ready to merge as one commit; the iteration one keeps the record.
- The status output and the report name the squashed branch and commit; the web UI names only the squashed branch. A delivery recorded before this change shows them as null.
- A leftover `factory/<runId>-squashed` branch that is not this run's squash, for example one edited by hand, stops delivery until a person removes or renames it.

## Rejected Alternatives

### Rewrite or replace the iteration branch with the squash

Rejected. The iteration branch is the run record: each commit is a candidate that was checked and reviewed. Replacing it loses that record, and it would also move a ref a replay needs to find.

### Squash inside the agent worktree or a checkout

Rejected. A `git reset --soft` and commit in a worktree moves a checkout, which could be the one the user is sitting in, and an interruption between the reset and the commit leaves a state a replay cannot tell apart from other work. Building from refs is idempotent.

### Make the squashed branch the only delivery by default

Rejected. It changes what existing runs publish and drops the record by default. Publishing the squashed branch stays an explicit choice through `publishSquashed`.
