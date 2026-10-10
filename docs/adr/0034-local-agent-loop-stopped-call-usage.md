# ADR-0034: local-agent-loop keeps the usage and session of a call it stops

## Status

accepted

## Context

`examples/local-agent-loop` stops agent calls before they end. With `parallelReview`, a failed check supersedes the reviews still running (ADR-0029). The factory's own timer stops a call at its total or idle limit (ADR-0032). A run cancel or a lost lease aborts whatever call is in flight.

The runner already kept any partial usage a provider reported on a stopped call's measurement, and ADR-0032 says a timed-out attempt "keeps its partial usage". That was true only for the fake provider. Neither real provider ever reported usage before the call ended: Claude's usage was read from the Agent SDK's result message, and Codex's from the AI SDK `finish` part. The session ID was likewise read only from the final result. A stopped call therefore recorded `usage: null` and no session.

Issue #296 measured the cost of that gap in artifactshare. From 2026-09-24 to 2026-10-10, 143 superseded reviews had no usage, and a consumer of the report recorded each as `external_usage_unavailable`. A superseded review ran for about 60 seconds at the median, against about 106 seconds for a finished one, so each spent about half a finished review. Together they ran for about 300 minutes.

A replay had a second gap. When a worker resumes and reads a stopped call's completed checkpoint, it builds a fresh measurement for the new attempt. The checkpoint held no usage, so the replayed attempt had none either.

## Decision

- **Real providers report running totals while the call runs.** `onPartialUsage(usage, usageByModel?)` takes the call's running total, never an increment, because the runner merges each snapshot field by field with the newest value winning. A new `onSession(id)` reports the native session ID as soon as the provider knows it. The measurement keeps it; the outcome a caller gets still takes its session from the final result alone, so a call and a replay of its checkpoint return the same one.
  - **Claude** sums the usage of each Agent SDK assistant message. A message arrives once per content block with the same ID, so each ID counts once, at its latest usage. Frames the CLI makes up itself (`<synthetic>`) and frames without tokens count nothing. The scope matches the final usage: subagent messages count only in a command-mode review, whose final usage includes them through `modelUsage`. The split is by the model each message names. The session ID is read from every SDK message.
  - **Codex** asks the app-server stream for raw notifications and reads `thread/tokenUsage/updated`. It sums the growth of the thread's total since the previous update, or the response's own `last` when there is no total to compare, as the provider sums the turn. The first update adds only its `last`, so a resumed thread's earlier turns are not counted. An update without model tokens adds nothing. Raw parts are taken out of the stream before `generateText` reads it, and they are never activity. A usage report made from one restarts the idle timer, as all partial usage does under ADR-0032. Any other raw notification, and a usage update without model tokens, reaches neither activity nor partial usage, so it never restarts the idle timer. The thread ID comes from the public `onSessionCreated` setting before the turn starts. Codex runs one model per call, so its split names the resolved model, which lets a stopped call be priced without a reported model. That model is not recorded as `reportedModel`.
- **The runner keeps what was reported in memory.** Each report updates an in-memory record of the running total, its split, the session ID, the number of reports and the time of the last one. This happens whether or not the advisory metadata write that follows it succeeds. A stopped call's checkpoint and terminal write are built from that record after the pending writes have been awaited.
- **A settled stop keeps its usage on the checkpoint.** A superseded or factory-timed-out call writes a `partial` field into its completed checkpoint, holding the record above. A replay reads it back into the new attempt without sending anything. A checkpoint written before this change has no `partial` field and replays as it did before.
- **A run cancel or a lost lease stays uncertain.** Its outcome is unknown, so it keeps a start-only checkpoint and stops as `uncertain-invocation`, as ADR-0032 requires. What it reported is kept on the attempt's measurement only.
- **The measurement says how far the usage goes.** A call that ended before its final usage gets `usageUntilStop`: the stop reason, the number of reports, the time of the last report, and the time from the call's start to that report. With no report, `usage` stays `null` and the count is 0. It is never 0 tokens.
- **The final usage replaces the running totals.** When a call ends with a final usage, that usage replaces the totals reported before it. If the final result has no split by model, a split that only the running totals had is dropped, so it never prices the finished call.
- **Stopped usage is a lower bound in every sum.** A sum that includes a stopped call reports `complete: false` and `costComplete: false`, even when its token legs are all known. So does a sum with usage that is still `provider-partial`: a call that finished without a final usage after reporting running totals, or an attempt a dead worker left `started`. The attempt keeps its own usage and cost estimate. When several attempts record one invocation, the report counts the one that completed it, then one that settled it as stopped (`cancelled`, `timed-out`), over any other, so a replay that read the stop checkpoint wins over the row a worker left behind. The JSON report lists each stopped invocation once in `stoppedCalls`, and the Markdown report has a "Usage of stopped calls" section and a note.
- **A stopped call's result is still not used.** Its verdict, approval, review cap, `realInvocationIds`, `fullLoopVerified` and the outcome it returns to its caller are unchanged. The outcome still carries no text and no session to continue, so a repair after a timed-out implementation still starts a new session. A call superseded before it was sent stays `not-sent` and counts in no sum.

## Consequences

- A superseded review's report shows the usage and session it had before the stop. A consumer of the report can tell such a call from one that reported nothing.
- ADR-0032's statement that a timed-out attempt keeps its partial usage now holds for Claude and Codex.
- A run with a stopped call still has no complete total cost. The numbers it shows are larger than before, and they are labelled as lower bounds.
- A command-mode Claude review counts subagent usage only from the subagent messages that reached the provider before the stop. Its final `modelUsage` is the complete figure; a stopped call has only the lower bound.
- The last usage report can come before the stop, so a stopped call's usage can miss its last response.
- Every Codex call now asks the app server for raw notifications. This adds traffic on the local connection and changes nothing the call does.
- Attempt metadata and stopped-call checkpoints gain fields. Readers that do not know them ignore them.

## Rejected Alternatives

### Estimate a stopped call's usage

The report could have estimated the missing usage from elapsed time or from finished calls of the same role. Rejected. The report records what providers reported and never makes up a number. A call with no report keeps `usage: null`.

### Settle a run cancel or a lost lease with its usage

Writing a completed checkpoint with the partial usage would have kept that usage on a replay too. Rejected for the reason ADR-0032 gives: the outcome of such a call is unknown, and a completed checkpoint would turn it into a known one. Its usage stays on the attempt that observed it.

### Count a stopped call's usage as a complete total

Partial legs that are all present would otherwise count as a complete sum. Rejected, because the provider may have spent more after its last report. The sum stays incomplete, and the per-attempt numbers stay visible.

### Read Codex usage from the turn's final `finish` part alone

That part does not exist on a call that is stopped, which is the case this decision covers.
