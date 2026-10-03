# ADR-0026: Write and review the local-agent-loop spec as stages of the run

## Status

accepted

## Context

A local-agent-loop run fixes, at trigger, the spec it was given with `--spec-file` and the check that grades its candidates, and then runs setup, the baseline check, preflight, triage and the implementation. Writing that spec and having it reviewed happened outside the run, in an orchestrating session that went back and forth with the factory. Each round trip cost a session, and none of that work was measured, checkpointed or reported like the calls inside a run.

The run already has everything a spec needs: a checkpointed LLM call path that never resends an uncertain call and classifies explicit refusals, reviewer invocations with a command, a context location and an output contract (ADR-0023), parallel review steps, a durable wait for a person's decision, a report built from completed steps, and a failure table for stops. Issue #256 agreed to move the spec into the run on those parts rather than build new ones.

A good check often depends on the spec: which test files grade the work is only known once the spec says what changes. A fixed `check` in `factory.json` cannot express that.

## Decision

- **When.** A repository run gets spec stages only when `factory.json` has a `spec` block that configures them (any of `template`, `reviewTemplate`, `maxRounds`, `author`, `fix`, `review`) and the run was given no `--spec-file`. Every other run keeps its stage order, prompts, check and `configVersion` exactly as before, with one exception: a `--spec-file` run whose `factory.json` sets `spec.checkFromSpec` runs `spec-check` before the baseline, grades with the check it chose, and hashes `checkFromSpec` into its `configVersion` (see **checkFromSpec**). A repair run never runs spec stages: it inherits the spec its parent confirmed and the check its parent chose.
- **Order.** With spec stages the run goes setup, preflight, spec (author), spec review, spec fix and review again as needed, `checkFromSpec`, baseline, triage, code. Preflight moves ahead of the baseline in these runs so that the spec author, the fix, every named reviewer and every later role are proven usable before the first spec call. Runs without spec stages keep baseline before preflight.
- **Roles.** `spec.author` writes the spec. `spec.fix` fixes it and falls back to the author's profile; the fields it leaves out come from the author's, as a repair profile's come from code's. `spec.review` is an object of named reviewers, each a role with its own profile and ADR-0023 invocation. Each role is preflighted, reported and priced on its own (`spec-author`, `spec-fix`, `spec-review:<name>`).
- **The spec file.** The spec lives at `runs/<runId>/spec/spec.md`, owned by the factory and outside the worktree. The author and the fix read the repository and may write that file only: Claude gets `Read`, `Grep`, `Glob`, `Edit` and `Write` in `dontAsk` mode, no project settings, and a guard (as `canUseTool` and a `PreToolUse` hook) that holds reads to the spec directory and the worktree and writes to the spec file, with symbolic links resolved; Codex runs in workspace-write with the spec directory as its working directory, and that directory holds the spec file alone. The Codex sandbox cannot be narrowed to one file, so the rule is enforced after the call instead: once an author or fix call finishes, whether it returns or fails, every entry of the spec directory other than `spec.md` is deleted; on a successful call the step output names what was removed (`removed`, `warning`). A stray file left by a successful call is a warning, not a failure. The same sweep runs after a Claude writer, where the guard leaves it nothing to find. After a successful call, `spec.md` itself is also checked: if it is not a regular file (for example, a symlink), it is removed and the step fails. Reviewers are read-only and read the worktree and the spec file. Every step that reads the file first writes the version it works on, and a writer's step writes its starting version only before its call has started, so a replay never loses what a call wrote.
- **Rounds.** Each round runs the named reviewers as independent durable steps under `step.all`. A reviewer's `command`, `context`, `output`, command-mode working directory (the base commit's `CLAUDE.md` and `.claude/` and a factory `CLAUDE.local.md`) and `findings-json` validation are the candidate reviewers'. The one difference is placeholders: no candidate commit exists yet, so a spec reviewer's command may use `{effort}` and `{base}` and trigger refuses `{head}`. The spec's location is in `CLAUDE.local.md` in local-instructions mode, or in the prompt. A blocker (a `needsChanges` verdict, or any `blocker` finding) sends the round's blockers, the blockers earlier fixes settled, and any human notes to the fix, then back to review. Non-blockers never hold the spec back; they are kept in the report. The spec is confirmed as soon as a round has no blocker.
- **Pure transitions.** The spec stages' results are events (`spec.authored`, `spec.fixed`, `spec.reviewed`, `spec.decided`) folded by a pure reducer; a pure policy picks the next action (author, review, fix, wait, confirm, reject). Step and wait names are derived from that state, so a replay reaches the same names and reads the same stored results.
- **Blocked spec.** If blockers remain after `maxRounds` rounds (default 3, a positive safe integer), the run waits on `spec-wait:<n>`, a durable wait of the same kind as the candidate approval (ADR-0010). Its metadata names the run and the SHA-256 of the spec version the reviewers blocked, and a signal must carry both. `approve` confirms the spec as it is; its remaining blockers become advice. `reject` ends the run as `rejected` before any implementation call. `spec-revise --run <id> --notes-file <path>` reads the notes once, puts them in the signal, and adds one fix and one review round; a spec still blocked waits again. The stored signal is what a replay reads, notes included.
- **checkFromSpec.** `spec.checkFromSpec` is an argv fixed at trigger. It runs once on the run's fixed spec (confirmed by the spec stages, or given with `--spec-file`), with the spec file's absolute path appended, in the worktree, within `checkTimeoutMs`. It must print JSON with a non-empty `check: string[]` and an optional string `notes`. The chosen check is stored in its own step (`spec-check`) with the baseline identity resolved for it, and replaces `check` and `--check` for the baseline, its reuse identity and every verification. A failure, a timeout, output that is not that JSON, or an empty check stops the run as `spec-check-failed` before the baseline and any implementation call; the failure table calls it safe to retry, with the settings read again. The script is local, so an interrupted attempt runs it again, and a completed step is never re-read on replay. With `checkFromSpec`, `check` is optional; `checkFromSpec` on a run with no spec at all is refused at trigger.
- **Untrusted inputs.** The confirmed spec reaches the implementer and the candidate reviewers as the existing `SPEC` block. The confirming round's advice goes to the implementer as `SPEC_ADVICE`, and the script's notes to the implementer and the candidate reviewers as `CHECK_NOTES`, both in the fenced untrusted section. The fix gets blockers, settled findings and human notes the same way. The templates come from the person who wrote `factory.json` and are given as trusted instructions.
- **Fixed at trigger.** The templates are read once at trigger, relative to the config file, and their contents stored in the run input; the worker never reads them. The spec stages' roles, invocations, round limit and template contents enter `configVersion`, and so does `checkFromSpec` (in place of the check in the target string). A run without them hashes exactly as before.
- **Report and UI.** `specRounds[]` has the shape of `reviewRounds[]`, with the reviewer's name as `lens`, and is read from completed steps so an open run has it. `spec` records the confirmed content (or, on a `--spec-file` run, which has no `spec:final` step, the spec from the run input, marked `source: "input"`, whatever state `spec-check` is in, including when it has not completed or has failed), the round that confirmed it, whether a person approved it over remaining blockers (`blocked`; amended 2026-10-03, #290: a revise that a later round passed is not approval, and before any round confirms a spec, `content` and `sha256` hold the latest draft with `round` null), the advice, and the chosen check with its notes. Stage timings and usage name `spec`, `spec-review` and `spec-check`, and compare includes them. `status`, `wait` and the web UI tell a spec decision apart from a candidate approval and print the three commands.

## Consequences

- One run carries a task from a bare issue to a delivered candidate, with the spec work measured, checkpointed and priced like the rest.
- Runs with spec stages pay for preflight before the baseline. A baseline that would fail now fails after the spec work instead of before it; the spec is still written before any implementation call.
- A spec reviewer that fails its output contract, a writer that leaves the spec empty, or an uncertain spec call stops the run, as the corresponding candidate-stage failures do. Nothing is resent.
- Changing a template or the round limit changes the config version, so compare keeps such runs apart.
- The Codex writer's boundary is its sandbox's workspace: the spec directory, plus whatever the sandbox always allows (such as a temporary directory). Files it leaves beside the spec are removed after the call, whether the call succeeds or fails, and reported as a warning on success; what it writes to the sandbox's other writable locations is not swept. The Claude writer's boundary is input inspection, as for implementation, and not an OS sandbox.
- A command-mode spec reviewer's extracted base tree is removed if the run fails or is cancelled anywhere from the spec stages through triage, not only inside the spec stages themselves; a suspension on the spec-blocked wait leaves it in place, as candidate review snapshots do around the human approval wait.

## Rejected Alternatives

### Keep spec work in the orchestrating session

Rejected. It is the round trip this change removes. Outside the run, the spec calls are neither checkpointed nor in the report, and the orchestrator has to relay every blocker by hand.

### Put the spec file in the worktree

Rejected. The author would then need write access to the worktree, which the boundary exists to deny, and the file would be sealed into the first candidate unless every stage remembered to remove it.

### A new wait kind, output format or call path for the spec

Rejected. The candidate approval wait, the reviewer invocation, `findings-json` and the checkpointed call path already give the guarantees the spec needs (bound signals, strict parsing, no resend), and a second copy of each would drift.

### Read the templates in the worker

Rejected. Editing a template during a run would change what a resumed run's prompts say without changing its config version.

### Let a person approve every spec

Rejected. Most specs pass review within the round limit; a wait on every run would hold a worker for a decision nobody needs to make. The wait is kept for a spec the reviewers still block.

### Retry a failed checkFromSpec within the run

Rejected. A script that fails or prints a bad check needs a person to fix it; a new run with the settings read again is the retry, and the stored step keeps a run from re-reading a changed script.
