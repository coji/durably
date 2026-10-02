# ADR-0029: Verify and review a local-agent-loop candidate side by side

## Status

accepted

## Context

A local-agent-loop run seals each candidate, verifies it with the pinned check, and only then reviews it with two reviewers. On a real repository both halves take minutes, and they run one after the other even though neither reads what the other produces. In the ten real runs of #269, every verification passed, and starting the reviews together with the check would have shortened each run by an estimated 12 to 23 percent.

Running them together raises four questions the sequential order never had to answer:

- The check runs in the run's worktree, where it may write build output and caches. A reviewer that reads the same worktree while the check runs could read that output as if it were the candidate.
- When the check fails, the reviews still running are no longer wanted. They have to be stopped without being mistaken for a crash, a lease loss or a call whose result is unknown, which the runner otherwise stops a run for (`uncertain-invocation`).
- A review may finish before the check fails. Its verdict is about a candidate that will not be delivered.
- Reviews spent on candidates that failed cost money, and that cost should be visible rather than hidden in the total.

## Decision

- **An opt-in setting.** `factory.json` gains `parallelReview`, a boolean, false when absent. It is fixed in the run input at trigger, like `baselineCheck`; a plain retrigger keeps it, `--reload-config` reads it again, and a repair run inherits its parent's. It is left out of `configVersion`: it changes when the reviews run, not what they are. With it off, the stage order, step names, review calls and their cost are exactly as before.
- **One step group per candidate.** With it on, the policy still chooses `verify` after `code`, and the verify stage starts the check and one review per reviewer in one `step.all`. The steps keep the names the two stages give them in sequence (`stage:<n>:verify:acceptance`, `stage:<n>:review:<lens>`), so the report, the timings and the trace read them as before, and the trace shows their real overlap. A new event carries the check's result and, only when it passed, both verdicts.
- **Reviewers read the sealed candidate, never the worktree.** With the setting on, a repository target extracts the candidate commit's tree (the head snapshot) and the base tree for every review round, for every reviewer. A prompt review works in the head snapshot and may read the candidate's diff and changed-file list; a command or local-instructions review works in its own directory and may read the diff's directory and both trees. The worktree is in no reviewer's working directory, readable directories or prompt, and `reviewLocations()` and the review prompt name the head snapshot. What a reviewer sees of the candidate is therefore the same in both modes and on Codex and Claude alike: the sealed tree, the diff and the changed-file list. The bundled sample already reviews a sealed copy and keeps doing so.
- **A failed check cancels the reviews still running.** The round has one `AbortController`. When the check fails, the verify branch aborts it before returning. The runner treats that abort, and only that one, as settling the call: it writes a completed checkpoint marked `cancelled` with the reason `superseded-by-verify`, keeps the partial usage already recorded on the attempt, and returns instead of throwing. A replay reads the checkpoint back and neither resends the call nor classifies it as uncertain or as a lost lease. A review whose round was aborted before its call was sent sends nothing; its attempt is recorded as `not-sent`, which no usage or cost sum counts, since nothing was spent. The stage ends only when every branch has.
- **A review that finished first is discarded.** Its step keeps its verdict and findings as recorded. The report marks the round `discarded` with the reason `verify-failed` when the check at the same stage sequence failed; a round with a cancelled review is `cancelled` with `superseded-by-verify`. The report calls a round `completed` only when the check at its sequence completed and passed. While that check has no completed result, still running or ended by an error, the round is `pending` with the reason `verify-pending`, and like a cancelled or discarded round it feeds neither the review highlights, the last verdicts nor the review round count.
- **A review that fails on its own still fails the run.** A review that throws before the check fails, such as an unparseable reply or a provider refusal while refusals are not accepted, fails the `step.all` and with it the run, as it would in sequential mode. Turning such a failure into a discard would salvage a review, which is out of scope here. (Amended 2026-10-02: a refused tool call alone no longer fails a review; it is recorded, per ADR-0023's amendment.)
- **Only a verified candidate's reviews count.** When the check failed, the state keeps no review from that round and its round is not counted, so it never reaches `review-cap-reached`, and the repair is given the check's failure alone. The 2026-10-01 amendment below also gives the repair the reviews that completed. When the check passed, the verdicts go through the same approval and repair paths as a sequential review. A candidate is approved only when both passed.
- **A worker that stops mid-review is handled as before.** A review with a started checkpoint and no completed one stops the run as `uncertain-invocation` on replay and is not resent.
- **The cost is shown apart.** The report adds `discardedReviews`, the call count and usage of the review calls in cancelled and discarded rounds, and its summary carries their cost. `demo compare` shows that cost per config group and `demo compare --trend` per week, beside the total that includes it. A call with no usage or no price makes the cost unknown, never zero. The web UI shows it in the reviews panel and the comparison, and names cancelled and discarded rounds and reviews, with their reasons, in the reviews panel and the trace.

## Consequences

- A run whose candidates pass their check finishes sooner by roughly the length of its reviews, at the price of paying for reviews of candidates that fail. That price is measured and shown, so the setting can be judged from real runs, with one gap: the real Codex and Claude providers do not stream partial usage, so a cancelled review's usage and cost are unknown. That makes the run's total cost and its cost of reviews on failed candidates unknown, and the report shows both as unknown, never as zero. `demo compare` and `--trend` then leave such a run out of their cost medians and count it as unknown.
- Every review round with the setting on extracts two trees, also for reviewers that previously read the worktree, which costs disk and time on a large repository.
- A verdict a reviewer gave on a candidate that then failed is kept for reading but used for nothing. Findings that might still apply to the repair are not passed on. Superseded by the 2026-10-01 amendment below.
- The runner has a third settled outcome besides a result and a refusal: a call cancelled because its result is no longer wanted.

## Deferred

- Handing the findings of a cancelled review to the repair. A cancelled review has no verdict, and reusing its partial output needs its own design. The completed reviews of a failed candidate are decided in the 2026-10-01 amendment below.
- Reusing a cancelled review's partial output, or retrying a cancelled review.
- Changing timeouts, or running the spec stages in parallel in any new way.
- The baseline reuse proposal of #253, which is a separate decision (ADR-0025).
- Races beyond the paths above, such as a worker stopping after the check failed but before a review started its call.

## Amendment (2026-10-01): completed reviews of a failed candidate go to the next repair

Parallel reviews often answer before the check fails. Their verdicts and findings were recorded in the review steps and shown in the report, but the repair that followed saw only the check's output, and a finding that still applied after the fix waited for the next review round to be raised again.

### Decision

- **Completed reviews go to the next repair.** When the check at a stage sequence fails, the stage event carries every review of that round that completed, with its verdict, notes and structured findings as its step stored them. The state keeps them apart from its counted reviews and hands them to the next repair only; the next code call clears them.
- **The check failure comes first.** The repair prompt lists the check failure as before, then says to fix it first, then gives the reviews in an untrusted `FAILED_CANDIDATE_REVIEWS` block fenced like the other untrusted inputs. The prompt labels them as reviews of the candidate that failed its check, whose findings may be moot once the failure is fixed, and asks the repair to weigh each against the task and the spec. A review with structured findings is given as those findings, blockers then non-blockers, one bounded line each with the rest counted, as the repair notes are; a verdict review is given as its notes.
- **Cancelled reviews give nothing.** A review ended by the failed check has no verdict, and its partial output is not passed on. A round with one completed and one cancelled review hands on the completed one alone.
- **Nothing else changes.** Such a round is still `discarded` or `cancelled` in the report, is not counted toward `review-cap-reached`, and feeds neither the review highlights nor the last verdicts. The repaired candidate is reviewed in a round of its own, which counts as usual when its check passes. Sequential mode still starts no review for a candidate whose check fails.

### Consequences

- A repair after a failed check can address review findings on the same candidate in the same iteration, instead of only after the next review round raises them.
- The repair prompt grows by at most two reviews, each bounded as the review notes and findings already are.
- A finding about a candidate that no longer exists may be followed where it does not apply. The prompt's labelling and the check-failure-first rule are the guard; the next review round judges the result.

## Rejected Alternatives

### Let reviewers keep reading the worktree

Rejected. The check writes into the worktree while it runs, so a reviewer could read build output or a half-written file as part of the candidate, and what two reviewers saw would depend on timing.

### Use the Durably step signal to stop the reviews

Rejected. The step signal means a cancel or a lost lease, which the runner records as an uncertain call and the run stops on. Stopping a review because its candidate failed is an ordinary outcome, so it needs its own signal and its own settled checkpoint.

### Record a cancelled review as failed and let the run continue

Rejected. A failed step inside `step.all` fails the run. A completed step whose output says `cancelled` lets the stage finish normally and replays to the same result.

### Count a discarded round toward the review cap

Rejected. A round on a candidate that failed says nothing about whether a verified candidate needs more work, and counting it would stop runs earlier than the sequential order does for the same candidates.
