---
name: spec-implement-accept
description: >-
  End-to-end autonomous development workflow: spec generation, review loop, implementation,
  acceptance testing loop, code simplification, supervision, documentation, a Draft PR,
  and a verified code-review/fix loop before the PR becomes Ready.
  Uses codex CLI for spec/review/acceptance/supervision, cursor agent for implementation,
  and Claude Code agents for fixes/simplify/docs. Includes git branch management, per-phase
  commits, Draft PR creation, and a blocker-free Ready gate without takt. Use this skill when the user wants to implement a
  feature or fix from an issue description, or says "run the full workflow", "spec-implement",
  "implement this issue end-to-end", or similar. Accepts an issue number as argument
  (e.g., "/spec-implement-accept #184" or "/spec-implement-accept 184").
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - Bash
  - Skill
---

# Spec-Implement-Accept Orchestrator

End-to-end development workflow that takes a task description through spec, implementation,
acceptance testing, simplification, supervision, documentation, and a reviewed Draft PR — with git management throughout. This workflow does not invoke takt or read `.takt/` state.

## Input

This skill accepts arguments in these forms:

- `/spec-implement-accept #184` or `/spec-implement-accept 184` — GitHub issue number
- `/spec-implement-accept https://github.com/coji/durably/issues/184` — GitHub issue URL
- `/spec-implement-accept <task description>` — free-form task description
- `/spec-implement-accept` (no args) — ask the user what to implement

Parse the argument:

1. If it matches `#?\d+` or a GitHub issue URL, extract the issue number
2. If it's free text, use it as the task description
3. If empty, ask the user: "What issue or task should I implement?"

## Workflow

Before Phase 0, read `references/policies.md` and `references/output-contracts.md`. Pass the
relevant policy and contract to each phase rather than relying on duplicated memory.

Count every phase transition. Stop with the PR Draft and report the current head and remaining
work if the workflow reaches 35 transitions. Phase 6 may run at most three times; if the same
finding survives two consecutive supervision rounds, stop rather than cycling back through the
pipeline.

### Phase 0: Setup

1. Require an unchanged starting checkout. Resolve and fetch the remote default branch, then record
   its SHA. If `git status --porcelain=v1 -z` is non-empty, stop and report the paths; never stash,
   delete, commit, or silently include pre-existing work.
   Run all repository-relative commands from `git rev-parse --show-toplevel`.
2. Fetch the task input:
   - **Issue number**: `gh issue view <number> --json title,body,labels` and use title + body as task description
   - **Issue URL**: extract the number from the URL, then fetch as above
   - **Free text**: use directly as task description
3. Create a feature branch from the recorded remote-default SHA, not from the current branch:
   - From issue: `feat/<issue-number>-<slug>` (e.g., `feat/184-add-retry-option`)
   - From description: `feat/<descriptive-slug>`
     Stop if the branch name already exists rather than reusing unknown history.
4. Create a task directory outside the worktree at
   `$(git rev-parse --git-dir)/durably-workflow/<branch-name>/`.
5. Save the task description as `input.md` and the immutable starting SHA as `base-sha` there. Pass
   this task directory and base SHA to every later phase. Workflow reports and specs never enter
   the feature diff.

### Phase 1: Spec Draft (codex)

Run codex to generate the task spec:

```bash
codex exec -m gpt-6-sol -c model_reasoning_effort=medium -s read-only \
  -o "<task-dir>/order.md" "$(cat <<'PROMPT'
<prompt from agents/spec-drafter.md, with input.md content appended>
PROMPT
)"
```

**Routing:**

- `order.md` generated successfully -> Phase 2
- Task description too vague -> Ask user for clarification, then retry

### Phase 2: Spec Review Loop (codex, max 4 iterations)

For each iteration:

**2a. Review:**

```bash
codex exec -m gpt-6-sol -c model_reasoning_effort=medium -s read-only \
  -o "<task-dir>/spec-review-report.md" "<prompt from agents/spec-reviewer.md>"
```

Output: `spec-review-report.md` following the output contract in `references/output-contracts.md`

**2b. Route based on review result:**

- `APPROVE` (no blocking issues) -> Phase 3. If the approved task is a proposal-only ADR,
  confirm `order.md` lists the ADR and `docs/adr/README.md` as change targets so Phases 3–4
  can create and verify both as `proposed`. Its completion criteria must require both entries to
  be `proposed`. If either check fails, record the missing target or criterion as a blocking
  spec-review issue, run 2c with that issue, and repeat 2a before Phase 3.
- `REJECT` (blocking issues) -> Run spec revision (2c), then loop back to 2a
- `ABORT` (fundamentally broken) -> Stop and report to user

**2c. Revise (if needed):**
Use Claude Code Agent tool with prompt from `agents/spec-reviser.md`.
Pass the current `order.md` and `spec-review-report.md` contents as context. The agent returns a
complete revised spec; the orchestrator replaces `<task-dir>/order.md` outside the worktree.

**Convergence check (after threshold of 3 iterations):**
Read the latest `spec-review-report.md`. If the same blocking issue remains for three rounds,
stop and request the missing product decision. Never force an implementation from a rejected spec.

**After Phase 2 completes:** Save the approved spec as `<task-dir>/order.md`, save the review as
`<task-dir>/spec-review-report.md`, and record the SHA-256 of `order.md` in
`<task-dir>/order.sha256`. Subagents return content; the orchestrator writes these files outside
the worktree. Do not commit workflow artifacts.

### Phase 3: Implementation (cursor agent)

```bash
cursor agent -p --yolo "<prompt from agents/implementer.md>"
```

**Routing:**

- Implementation complete, ready for review -> Phase 4
- Cannot implement -> Stop and report to user

**After Phase 3 completes:**

```bash
git add -A
git commit -m "feat: implement <task-name>"
```

### Phase 4: Acceptance Testing Loop (codex + claude, max 3 iterations)

For each iteration:

**4a. Acceptance test:** Run `pnpm validate` first. Pass its complete output, `base_sha`,
`order_sha256`, and task context to read-only Codex:

```bash
codex exec -m gpt-6-sol -c model_reasoning_effort=medium -s read-only \
  -o "<task-dir>/acceptance-report.md" "<prompt from agents/acceptor.md>"
```

Output: `acceptance-report.md` following the output contract

**4b. Route based on result:**

- `APPROVE` (all criteria met) -> Phase 5
- `REJECT` (issues found) -> Run fix (4c), then loop back to 4a

**4c. Fix (if needed):**
Use Claude Code Agent tool with prompt from `agents/fixer.md`.
The agent has access to: Read, Glob, Grep, Edit, Write, Bash.

**Convergence check (after threshold of 2 iterations):**
If the same issues keep repeating, proceed to Phase 6 (supervise) for triage.

**After Phase 4 completes (if any fixes were made):**

```bash
git add -A
git commit -m "fix: address acceptance test issues"
```

### Phase 5: Simplify (claude)

Use Claude Code Agent tool with prompt from `agents/simplifier.md`.
This invokes the `/simplify` skill internally, then runs `pnpm format:fix && pnpm validate`.

**After Phase 5 completes (if changes were made):**

```bash
git add -A
git commit -m "refactor: simplify implementation"
```

### Phase 6: Supervision (codex)

Run `pnpm validate`, then pass its complete output and task context to read-only Codex:

```bash
codex exec -m gpt-6-sol -c model_reasoning_effort=medium -s read-only \
  -o "<task-dir>/supervise-report.md" "<prompt from agents/supervisor.md>"
```

Output: `supervise-report.md` following the output contract

**Routing:**

- `COMPLETE` -> Phase 7
- `FIX` -> Run fix via Claude Code Agent, commit if changed, then re-run Phase 6
- `SPEC_REVIEW` -> Go back to Phase 2

**After Phase 6 fix (if any):**

```bash
git add -A
git commit -m "fix: address supervision findings"
```

### Phase 7: Documentation Update (claude)

Use Claude Code Agent tool with prompt from `agents/doc-updater.md`.
Before deciding whether to run it, compare the approved spec and completed implementation with
the ADR criteria in `CLAUDE.md`, and inspect `docs/adr/README.md` plus existing `proposed` ADRs.
Do not infer the need for an ADR solely from changed paths: a relevant proposal may already be on
`main`, or a new non-API architectural decision may need its first ADR. Run this phase if the task
needs an ADR, has public API changes, or already changes an ADR.
For the public API part of this decision, inspect the complete recorded `base...HEAD` change set
plus current uncommitted paths, not only the latest working-tree diff.

For a decision completed in this PR, create or update its ADR and index entry on this feature branch
and set both to `accepted` before Phase 8. For a proposal-only PR, create or keep its ADR and index
entry as `proposed`; a partial implementation also keeps both as `proposed`. Merging the
implementation PR publishes the accepted status without a follow-up PR.
If an approved proposal-only task lists its ADR and index as change targets, Phases 3 and 4 may
create them as `proposed` so acceptance testing can verify that deliverable before Phase 7.

**After Phase 7 completes (if changes were made):**

```bash
git add -A
git commit -m "docs: update documentation"
```

### Phase 8: Draft PR Creation

Read [the review workflow](../../../docs/workflow/code-review.md) before this phase. A clean,
pushed commit is required before review. Check the completed implementation against the ADR
criteria and existing proposed ADRs, even if no ADR path changed yet. If a completed decision
lacks an ADR or its ADR/index is not `accepted`, return to Phase 7 to make and commit that change.
For a proposal-only or partial-implementation PR, return to Phase 7 if its ADR or index entry is
missing or not `proposed`.
Create the PR as Draft immediately after the implementation pipeline is complete; do not wait for
code review to create it.

```bash
git push -u origin <branch-name>
gh pr create --draft --title "<PR title>" --body-file <prepared-body-file>
```

PR body format:

```markdown
## Summary

<from order.md overview>

## Changes

<list of phases completed and key decisions>

## Test plan

<from order.md completion criteria as checklist>

## Review gate

Draft — code review has not passed yet.

Generated with spec-implement-accept skill
```

For an issue-driven task, include `Closes #<issue-number>`. Record the base SHA and current head
SHA. Link any ADR created or accepted by this PR. Use a body file so shell interpolation cannot
change Markdown or execute task text.

### Phase 9: Code Review and Fix Loop

Run this phase only on pushed commits. The authoritative process, blocker definition, stopping
conditions, model pair, and report schema are in `docs/workflow/code-review.md`.

For round `N`:

1. Confirm the PR is still Draft. Read its base/head SHAs and source issue from GitHub.
2. Run `pnpm validate` for the pushed head and write `<task-dir>/validation.env` containing the
   exact `reviewed_head=<sha>` and `pnpm_validate=pass`. Freeze the pushed head and create
   `$(git rev-parse --git-dir)/durably-review/<pr>/<head-sha>/` with snapshot hashes, the source
   issue acceptance criteria, and applicable rule files. Set their absolute paths as
   `snapshot_dir`, `hash_file`, `criteria_file`, and `rules_file`.
3. Dispatch both finder tracks independently. Run the repository Codex skill without showing it
   the Opus prompt or result:

   ```bash
   report_dir="$(git rev-parse --git-dir)/durably-review/<pr>/<head-sha>/round-<N>"
   mkdir -p "$report_dir"
   cat > "$report_dir/codex-prompt.md" <<EOF
   \$code-review high <PR URL>
   Fixed head: <head-sha>
   Fixed snapshot: $snapshot_dir
   Snapshot hashes: $hash_file
   Acceptance criteria: $criteria_file
   Applicable rules: $rules_file
   Return only the independent Codex track result. Do not launch the Opus track.
   EOF
   codex exec -m gpt-6-sol -c model_reasoning_effort=medium \
     -s read-only -C "$(git rev-parse --show-toplevel)" \
     -o "$report_dir/codex-track.md" - < "$report_dir/codex-prompt.md"
   ```

   Create an independent `opus-prompt.md` with the same fixed-target facts and all eight
   perspectives, without Codex candidates. Dispatch it concretely and record the observed model and
   execution metadata:

   ```bash
   CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude -p \
     --model opus --effort high --output-format json --restricted \
     --add-dir "$snapshot_dir" --tools Read,Glob,Grep \
     --allowedTools Read,Glob,Grep --strict-mcp-config \
     < "$report_dir/opus-prompt.md" > "$report_dir/opus-track.json"
   ```

   Reviewers do not create snapshots, run validation, write files, or dispatch one another. After
   both finish, the orchestrator consolidates their candidates and sends every candidate to a
   verifier that did not discover it. Write the canonical combined result to
   `$report_dir/code-review-round-<N>.md`.

4. Route on the report:
   - `GO`: continue to Phase 10.
   - `NO-GO`: run `agents/review-fixer.md` with the issue, `order.md`, and review report. Repair any
     missing ADR or incorrect ADR/index status for the approved decision on the same branch. If a
     fix changes that decision, update its ADR body and index there too. Run focused checks and
     `pnpm validate`; commit and push actual fixes. Begin a new round against the new SHA.
   - `INCOMPLETE`: finish the missing review, verification, or check without declaring success.

   Include ADR presence and status in the combined report's acceptance table whenever the PR
   completes, partially implements, or proposes a decision that meets the repository ADR criteria,
   even when no ADR path changed.

5. Update the Draft PR body with the round number, reviewed SHA, blocker counts, and report summary.
   Keep non-blocking findings visible.

Do not amend reviewed commits, reuse a GO after a push, or force-proceed because a round limit was
reached. When the policy stopping condition is met, leave the PR Draft and report what is needed.

### Phase 10: Ready Gate

Before changing the PR state:

1. Confirm the final report is `GO` for the PR's current remote head SHA.
2. Confirm every source-issue acceptance criterion is `PASS` with evidence.
3. Wait for every check reported for that exact SHA; all must complete successfully.
4. Confirm the worktree has no workflow-created uncommitted changes and the remote head has not moved.
5. Update the PR body to show the final reviewed SHA, validation, checks, and non-blocking findings.
6. Run `.claude/skills/spec-implement-accept/scripts/mark-ready.sh <PR URL> <reviewed SHA>
<task-dir>/validation.env`. It re-reads `headRefOid` immediately before
   the mutation, rejects pending/failed/cancelled checks, and enters Ready only when the SHA still
   matches.
7. The script re-reads the head after the mutation. If it changed, it restores Draft state and the
   workflow returns to Phase 9 for the new head.

If any condition changes or fails, return to Phase 9 and keep the PR Draft.

## Error Handling

- If any codex/cursor command fails (non-zero exit), read stderr and report to user
- If a phase produces no output, retry once before stopping
- If validation (`pnpm validate`) fails after implementation or fix, treat as acceptance failure
- If a reviewer/model/check is unavailable, classify the round `INCOMPLETE`; never infer GO
- On any unrecoverable error, leave the PR Draft and report the current branch, head, and blockers

## Reading Agent Prompts

When executing each phase, read the corresponding file from `agents/` to get the full prompt.
Append the current task context (order.md content, previous reports) to the prompt.

Key context to pass between phases (all report/spec files live under `<task-dir>` outside the
worktree):

- `order.md` — the authoritative spec (all phases)
- `spec-review-report.md` — review findings (spec-revise, implement)
- `acceptance-report.md` — test results (fix)
- `supervise-report.md` — supervision findings (fix, spec-review)
- `$(git rev-parse --git-dir)/durably-review/<pr>/<sha>/round-<n>/code-review-round-<n>.md` — immutable review result for that head

## Git Conventions

- Branch names: `feat/<issue>-<slug>` or `feat/<slug>`
- Commits use conventional commit prefixes: `spec:`, `feat:`, `fix:`, `refactor:`, `docs:`
- Stage intended paths, then commit only when the index is non-empty:
  `git add <paths>; git diff --cached --quiet || git commit -m "..."`
- Never commit to main directly
- Create PRs as Draft and change them to Ready only through Phase 10
- Never use takt for this workflow
