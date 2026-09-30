# ADR-0030: local-agent-loop repairs a verification-failed candidate in a new run

## Status

accepted

## Context

A repository run of `examples/local-agent-loop` can use up its repair iterations while the pinned check still fails on its last candidate (issue #280). The run then completes as `verification-failed`. It leaves a sealed candidate commit and branch that often need only one more repair, but the only way to act was `demo retrigger`, which starts implementation again from the original base and pays for the work already done.

ADR-0022 already has a mechanism that starts from another run's candidate: `demo repair` triggers a child run based on the parent's last candidate commit, with the parent's settings frozen, a fresh repair budget, and outside findings as untrusted input. It limited the parent to an approved, delivered run.

## Decision

This amends ADR-0022's decision "Which runs may be a parent". Everything else in ADR-0022 applies to the new kind of parent unchanged, except that its child skips the baseline check (below).

- **A second kind of parent.** Besides a completed, approved repository run whose delivered commit is its last candidate, `demo repair` accepts a completed repository run whose output is `verification-failed` and that recorded a last candidate commit and branch. It needs no delivery. Every other conclusion and status stays refused, `rejected` included, even when the run left a candidate. (`review-cap-reached` is added by the 2026-10-01 amendment below.) The candidate branch is checked in the CLI and again in the child's setup exactly as for an approved parent, and a moved or missing branch stops the child as `candidate-moved` before any agent call.
- **The findings file is optional for this parent only.** An approved parent still needs `--findings-file`. For a verification-failed parent a given file is used as before. Without one, the CLI builds a short Markdown document from the parent's stored record: the output tail and exit code of the check that failed on the last candidate, and the check command the parent graded with. The output tail is the `VerificationOutcome.stdout` the run already stored for its own repair prompt, which holds stdout and stderr together. The check is found by pairing: the last sealed candidate's step must be the recorded candidate, and the first completed `stage:<n>:verify:acceptance` step after it must have failed with stored output. Sequential and parallel verification (ADR-0029) name that step the same way. The log files are not read, since they can change after the run, and an earlier candidate's result is never used instead. When the result is missing or has no output, the CLI refuses and asks for a findings file. (A review-cap-reached parent, added by the 2026-10-01 amendment below, also makes the file optional.)
- **Stored like a findings file.** The built text is stored in the child input as the findings, with a reference that names the parent run (`{ parentRun }`) instead of a path. It is hashed into the idempotency key and into the report like a file's content, so the same parent, findings and dispositions return the same child. The text depends on the stored record alone, so repeating the command returns the same child. Existing file references and stored repair runs keep their path.
- **Prompts say how the parent ended.** The child input, its setup record and the target's repair context carry the parent's conclusion; a run stored before it was kept counts as an approved parent. For a verification-failed parent, the repairer and both reviewers are told that the base is the last candidate of a run that stopped on the check and was never approved. The reviewers judge the candidate as a whole, base and repair together, against the task and the spec, since no review ever passed the base. The findings stay in the fenced, untrusted `FINDINGS` block for all three.
- **No baseline check for this parent.** The child's base is the candidate the pinned check failed on, so a baseline check would always stop it as `baseline-check-failed` before the repair, and that failure is already its findings. A child of a verification-failed parent therefore skips the baseline, and the setup's untracked-file check and baseline identity that exist only for it. It still records the inherited `baselineCheck` and `baselineReuse`, so its own children inherit them, and its report shows no baseline.
- **Reviewers see the repair's changed paths.** The factory lists only the changes from the parent's candidate. Reviewers of a verification-failed child are told that the list is the repair alone and to read the rest of the candidate in the candidate tree the CANDIDATE FILES section names, or in their working directory when it names none; either holds the whole tree. The parent's original base is not passed.
- **The same child in every other way.** Settings are inherited and frozen, the base is the candidate commit, the first code stage is a `repair` at iteration 1 with no triage and no implementation, the inherited `maxIterations` counts the child's own repairs only, and the labels, `repairOf` lineage, status and web UI links are those of any repair run.
- **Suggested next step.** A verification-failed repository run names `demo repair --run <id>` beside `retrigger`. The bundled sample, which has no candidate branch, does not.

## Consequences

- A run that nearly finished can continue from its candidate with a new repair budget, without a person writing findings and without paying for implementation again.
- A child of a verification-failed parent starts from a candidate no reviewer passed, so its reviews cover the whole change, not the repair alone.
- The findings a child gets without a file are the check output only. Reviews that completed beside the parent's failed check are not passed to the child unless a person supplies them as a findings file. Within one run, those reviews do go to the next repair, by ADR-0029's amendment (#281); that is separate from a `demo repair` child. (A review-cap-reached parent's child gets the parent's stored reviews instead, by the 2026-10-01 amendment below.)

## Deferred

- Passing a verification-failed parent's completed reviews to a `demo repair` child.
- A pre-check before the repair, and the `maxIterations` cap (#282): decided in ADR-0031.

## Amendment (2026-10-01): a review-cap-reached parent, and the repair budget

A run whose last candidate passed the check but still had a blocking review after the review cap stopped as `review-cap-reached`, and the only way on was `retrigger`, which pays for the implementation again. The owner decided that such a run may be repaired like a verification-failed one. The repair budget was also fixed to the parent's, so a child could not be given more repairs than the parent had.

### Decision

- **A third kind of parent.** `demo repair` also accepts a completed repository run whose output is `review-cap-reached` and that recorded a last candidate commit and branch. It needs no delivery. The candidate branch is checked as for the other parents. `approved` still needs its delivery and a findings file; `rejected`, and every status but `completed`, stay refused.
- **Findings from the stored reviews.** A given `--findings-file` is used as it is. Without one, the CLI builds a short Markdown document from the parent's stored output `reviews`, which holds each lens's last verdict: every review whose decision is `needsChanges` and whose notes are not blank, as a heading naming the lens and its notes. For a lens answering in `findings-json`, the notes are already the bounded blocker lines the run stored. No step or log is read, and a `pass` review's notes are left out. When no such review is stored, the CLI refuses and asks for a findings file. The text is stored with the `{ parentRun }` reference, and the child input records the parent's conclusion as `review-cap-reached`; both are hashed and reported as for a verification-failed parent.
- **The baseline check runs.** The parent's last candidate passed the pinned check, so the child runs the inherited baseline as any repair run does. Only a child of a verification-failed parent skips it.
- **Prompts say the base was never approved.** The repairer and both reviewers are told that the base is the last candidate of a run that passed the check but stopped because reviewers still found blocking issues after the review cap. The reviewers judge the candidate as a whole, base and repair together, and read the rest of the candidate in the candidate tree, as for a verification-failed parent. The findings stay in the untrusted `FINDINGS` block.
- **`--max-iterations` on repair.** `demo repair` accepts `--max-iterations` with trigger's validation, an integer from 1 to 5. Without it the child inherits the parent's value as before. With it, the value is stored as the child input's `maxIterations`, so the child's `configVersion` reflects it and `compare` groups the child by it. It is the only setting a repair may change: ADR-0022's inheritance keeps the experiment the parent measured, and the repair budget is not part of that experiment once it is recorded. `--reload-config` and every other flag stay refused. A value other than the parent's is added to the idempotency key, so a different budget makes a different child, while the same budget, given or inherited, returns the child a repeated command returned before.
- **Suggested next step.** A review-cap-reached repository run names `demo repair --run <id>` beside `retrigger`, with the findings file optional.

### Consequences

- A run stopped only by reviewer findings can continue from its checked candidate without paying for implementation again and without a person writing the findings.
- The derived findings are the reviewers' own notes, which a person has not weighed. They reach the repairer as untrusted input, and the child's reviewers judge the whole candidate again.
- A repair run may use a larger or smaller repair budget than its parent, recorded in its input and its config version.

## Rejected Alternatives

### Resume the stopped parent

Rejected for the reason ADR-0022 gives: a finished run is a closed record that `report` and `compare` read, and Durably cannot move a terminal run back to pending without rewriting it. A child keeps the parent's record and measurements as they were.

### A separate `continue` command

Rejected. Continuing from a stopped candidate needs exactly the repair child's mechanics: frozen settings, a candidate base, a branch check, a fresh budget and lineage. A second command would duplicate them and split one kind of child across two names.

### Allow `review-cap-reached` too

Deferred at first: its findings are review findings that a person should weigh before a new run repairs from them. Adopted by the owner's decision in the 2026-10-01 amendment, with the findings kept as untrusted input and the whole candidate reviewed again.

### Build the findings from the check's log files

Rejected. The log files live in the run directory and can be changed or removed after the run; the stored output tail is part of the run's record and gives the same findings every time.
