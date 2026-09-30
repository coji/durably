# ADR-0030: local-agent-loop repairs a verification-failed candidate in a new run

## Status

accepted

## Context

A repository run of `examples/local-agent-loop` can use up its repair iterations while the pinned check still fails on its last candidate (issue #280). The run then completes as `verification-failed`. It leaves a sealed candidate commit and branch that often need only one more repair, but the only way to act was `demo retrigger`, which starts implementation again from the original base and pays for the work already done.

ADR-0022 already has a mechanism that starts from another run's candidate: `demo repair` triggers a child run based on the parent's last candidate commit, with the parent's settings frozen, a fresh repair budget, and outside findings as untrusted input. It limited the parent to an approved, delivered run.

## Decision

This amends ADR-0022's decision "Which runs may be a parent". Everything else in ADR-0022 applies to the new kind of parent unchanged.

- **A second kind of parent.** Besides a completed, approved repository run whose delivered commit is its last candidate, `demo repair` accepts a completed repository run whose output is `verification-failed` and that recorded a last candidate commit and branch. It needs no delivery. Every other conclusion and status stays refused, `rejected` and `review-cap-reached` included, even when the run left a candidate. The candidate branch is checked in the CLI and again in the child's setup exactly as for an approved parent, and a moved or missing branch stops the child as `candidate-moved` before any agent call.
- **The findings file is optional for this parent only.** An approved parent still needs `--findings-file`. For a verification-failed parent a given file is used as before. Without one, the CLI builds a short Markdown document from the parent's stored record: the output tail and exit code of the check that failed on the last candidate, and the check command the parent graded with. The output tail is the `VerificationOutcome.stdout` the run already stored for its own repair prompt, which holds stdout and stderr together. The check is found by pairing: the last sealed candidate's step must be the recorded candidate, and the first completed `stage:<n>:verify:acceptance` step after it must have failed with stored output. Sequential and parallel verification (ADR-0029) name that step the same way. The log files are not read, since they can change after the run, and an earlier candidate's result is never used instead. When the result is missing or has no output, the CLI refuses and asks for a findings file.
- **Stored like a findings file.** The built text is stored in the child input as the findings, with a reference that names the parent run (`{ parentRun }`) instead of a path. It is hashed into the idempotency key and into the report like a file's content, so the same parent, findings and dispositions return the same child. The text depends on the stored record alone, so repeating the command returns the same child. Existing file references and stored repair runs keep their path.
- **Prompts say how the parent ended.** The child input, its setup record and the target's repair context carry the parent's conclusion; a run stored before it was kept counts as an approved parent. For a verification-failed parent, the repairer and both reviewers are told that the base is the last candidate of a run that stopped on the check and was never approved. The reviewers judge the candidate as a whole, base and repair together, against the task and the spec, since no review ever passed the base. The findings stay in the fenced, untrusted `FINDINGS` block for all three.
- **The same child in every other way.** Settings are inherited and frozen, the base is the candidate commit, the first code stage is a `repair` at iteration 1 with no triage and no implementation, the inherited `maxIterations` counts the child's own repairs only, and the labels, `repairOf` lineage, status and web UI links are those of any repair run.
- **Suggested next step.** A verification-failed repository run names `demo repair --run <id>` beside `retrigger`. The bundled sample, which has no candidate branch, does not.

## Consequences

- A run that nearly finished can continue from its candidate with a new repair budget, without a person writing findings and without paying for implementation again.
- A child of a verification-failed parent starts from a candidate no reviewer passed, so its reviews cover the whole change, not the repair alone.
- The findings a child gets without a file are the check output only. Reviews of the parent's failed candidate are not passed on (#281).

## Deferred

- Passing the parent's reviews of failed candidates to the child (#281).
- A pre-check before the repair, and any cap on `maxIterations` (#282).
- Repairing a `review-cap-reached` run.

## Rejected Alternatives

### Resume the stopped parent

Rejected for the reason ADR-0022 gives: a finished run is a closed record that `report` and `compare` read, and Durably cannot move a terminal run back to pending without rewriting it. A child keeps the parent's record and measurements as they were.

### A separate `continue` command

Rejected. Continuing from a stopped candidate needs exactly the repair child's mechanics: frozen settings, a candidate base, a branch check, a fresh budget and lineage. A second command would duplicate them and split one kind of child across two names.

### Allow `review-cap-reached` too

Deferred, not adopted. Its candidate passed the check, and what it lacks is a reviewer's approval. Its findings are review findings that a person should weigh before a new run repairs from them, and passing reviews on is the separate question of #281.

### Build the findings from the check's log files

Rejected. The log files live in the run directory and can be changed or removed after the run; the stored output tail is part of the run's record and gives the same findings every time.
