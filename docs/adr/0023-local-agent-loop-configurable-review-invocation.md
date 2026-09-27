# ADR-0023: local-agent-loop reviewers choose their command, context and output

## Status

accepted

## Context

The two reviewers of `examples/local-agent-loop` (`correctness` and `edge-cases`) are called with a fixed review prompt and read with a fixed `DECISION`/`NOTES` parser (issue #248). A repository that already has a formal review procedure, such as a Claude Code slash command backed by subagents, cannot run that same procedure inside the factory: the factory sends its own prompt, the subagents never see the review context, and the procedure's structured findings do not fit the verdict format.

Running such a procedure needs three things the factory did not have: a way to send the repository's own command, a way to give the review context to subagents that do not see the parent prompt, and a way to read structured findings strictly enough that an unfinished review never passes. It must not weaken what the factory already guarantees: a review never writes, an uncertain call is never resent, a reply that cannot be read is never a pass, and a run whose settings did not change keeps its `configVersion`.

## Decision

- **Three optional fields per reviewer.** `profiles.review.correctness` and `profiles.review.edge-cases` in `factory.json` take `command`, `context` (`prompt` or `local-instructions`) and `output` (`verdict` or `findings-json`), each independently. A lens that names none keeps the factory prompt and the verdict. A lens that names any has all three fixed at trigger, defaults filled in, stored in the run input and the setup record, and hashed into `configVersion`; with no lens configured the hash input is unchanged.
- **Commands are opaque.** The engine knows no command name and no lens-specific behaviour. `command` accepts only `{effort}`, `{base}` and `{head}`, expanded in one pass to the role's effective effort, the run's fixed base commit and the reviewed candidate's commit. An unknown placeholder, an unclosed or unmatched brace, a blank command and an `{effort}` the role cannot resolve are refused at trigger, and again in setup, before any worktree or LLM call. The expanded command is the reviewer's single input for that call.
- **Context in the prompt or in `CLAUDE.local.md`.** With `context: prompt` the review context and the output contract follow the command in the input. With `local-instructions` they are written to `CLAUDE.local.md` at the worktree root, where the parent and every subagent load them as local instructions, and the input is the command alone. The instructions hold the lens's checks, the trusted context, the hash-fenced `TASK`/`SPEC`/`DISPOSITIONS`/`FINDINGS` blocks, the locations of the diff, the changed-file list and the base and head snapshots, the dispositions rule, the repair-run rule and the chosen output contract.
- **Only the factory's own file is touched.** The file starts with a marker line. An existing `CLAUDE.local.md` without it is never changed or removed: the review is refused before its call. The factory's file is removed when the call ends, whether it succeeded, failed, was cancelled or lost its lease; a file a killed worker left is removed before the resumed review writes its own, and before any candidate is sealed.
- **Reviews that read local instructions take turns.** When either lens uses `local-instructions`, the two review branches of a round run one at a time in one process, so neither reads the other's file. Otherwise they still run side by side.
- **Materials outside the worktree.** When a lens uses a command or local instructions, sealing a candidate also extracts the base and candidate commits' trees with `git archive` into `base/` and `head/` beside the candidate's diff and changed-file list. They are rebuilt from the commits on replay and never enter the candidate's diff, an iteration commit or the squashed branch.
- **Claude command mode.** A Claude reviewer with a command or local instructions runs with `tools` and `allowedTools` set to `Read`, `Grep`, `Glob` and `Agent`, `permissionMode: 'dontAsk'`, `settingSources: ['project', 'local']`, and `additionalDirectories` set to the worktree and the candidate's materials directory. `canUseTool` and the `PreToolUse` hook share one check that allows only those four tools and only paths inside those directories; hooks also run for subagents, so the same rule binds them. Every other Claude call keeps its settings. Codex reviewers refuse `command` and `local-instructions` at trigger; the fake provider accepts them so tests can exercise the engine.
- **`findings-json` is a provider-independent contract.** The reply's last line must be exactly `REVIEW_STATUS: COMPLETE` — one conventional trailing newline (`\n` or `\r\n`) is allowed after it, but any other trailing whitespace on that line makes the review incomplete — with no other `REVIEW_STATUS:` line. The last ` ```json ` block is read from its opening fence to the first closing fence at which the text parses as a JSON array, so a fence inside a finding does not cut it short, and an earlier block is never read instead. Each finding needs `severity` `blocker` or `non-blocker` and a non-empty `title` and `body`; `file` and `line` are optional, but when a key is present its value must have the declared type — `null` counts as present-with-the-wrong-type, not absent, so it makes the review incomplete; other keys are ignored. One blocker makes the review `needsChanges`, with the blockers as the notes (`- [file:line] title — body`, one per line) that reach the repair; an empty array or non-blockers alone pass.
- **Interpretation after the checkpoint.** Every call still goes through the started and completed checkpoints. The reply is read after the completed checkpoint, so a missing status line, broken JSON, a malformed finding, a truncated reply or a Claude permission denial stops the review as `review-incomplete` and is never resent. Explicit provider refusals and uncertain failures keep their existing classification.
- **Usage from `modelUsage`.** A Claude call's usage is the final result's `modelUsage`, which covers the main loop and every subagent, summed across models once and never added to the main-loop numbers it already contains. A leg some model does not report stays unknown. Cost and per-role totals use the existing measurement path.

## Consequences

- A repository can run its own review procedure as one reviewer and have its findings drive the factory's repair loop, while the other reviewer keeps the factory prompt.
- A Claude command-mode reviewer loads the repository's `.claude/` settings and `CLAUDE.md`, which the candidate may have changed. The tool list and the guard still hold, but what the reviewer is told can come from the candidate.
- A run with a local-instructions reviewer spends the sum of the two review times instead of the longer one.
- Candidates of such runs take extra disk for two tree copies each.
- A permission denial in a command-mode review stops the run even if the reply looks complete, so a procedure that needs Bash cannot run as a reviewer.
- Runs without the new fields keep their `configVersion`, prompts, verdict parsing and parallel reviews.

## Rejected Alternatives

### Build a specific review command into the engine

Rejected. It would tie the example to one repository's procedure and one tool, and every other procedure would need engine changes. The engine only expands three placeholders and passes the result on.

### Put the review context in a subagent prompt or a settings file

Rejected. The parent prompt does not reach subagents started by a slash command, and a generated settings file would change more than instructions. `CLAUDE.local.md` is what Claude Code loads for every agent in the working directory, and it is outside version control by convention.

### Run local-instructions reviews in separate worktrees

Rejected. A second worktree would need its own dependency install and would not be the sealed candidate the other stages address. Taking turns in the one worktree keeps a single candidate.

### Read the first JSON block, or retry when the reply cannot be read

Rejected. The first block is often a draft or an example, and a retry would resend a call that may already have been paid for and acted on. The last block, read strictly, with the call never resent, keeps an unfinished review from passing.

### Add each model's usage to the main loop's usage

Rejected. `modelUsage` already contains the main loop, so adding it would count the parent call twice.
