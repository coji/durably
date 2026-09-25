# ADR-0020: Stop local-agent-loop runs on explicit provider refusals at every stage

## Status

accepted

## Context

ADR-0019 records an explicit provider refusal during preflight as a completed call, so a replay reads it back instead of resending, and the run stops as `preflight-failed`. Every other stage still treated a refused call like any other provider error: it left a start-only checkpoint, and the run stopped as `uncertain-invocation` with retry NO. Real runs hit this with an HTTP 400 `invalid_request_error` from a review role. Nothing had been accepted, so sending again could not duplicate work, yet the run told a person to inspect the provider's session history and refused `retrigger`.

## Decision

- A call that the provider explicitly refuses (an HTTP 4xx invalid request, an unknown model, an authentication failure, a Codex CLI that cannot start) is recorded as a completed call carrying the refusal, at every stage: implement, repair, review, triage and preflight. Refusals are recognised by the same provider-specific rules preflight uses.
- Outside preflight, an error counts as a refusal only when the call showed no agent activity before it failed: no text, reasoning, tool call or reported usage. Codex watches its stream parts and Claude its assistant messages. Once any activity was seen, the agent may already have acted, so the error stays `uncertain-invocation` even when the refusal rules match it. Preflight asks only for a reply, so its refusal is read as before.
- A refused call outside preflight stops the run as `rejected-invocation`, retryable after a configuration change. Status, report and the web UI name the refusal and point at `retrigger --reload-config` for repository runs.
- On replay the stored refusal is read back; the provider is not called again.
- Everything else is unchanged. A call whose outcome is unknown — a start-only checkpoint, a timeout, a cancel, an error after agent activity, or an error the provider rules do not recognise as a refusal — still stops as `uncertain-invocation` and is never resent automatically.

## Consequences

- A configuration mistake found after preflight, such as a model that passes the free check but is refused on first use, no longer strands the run as uncertain.
- The refusal rules now decide retryability for every stage, so a wrong rule would make an uncertain call look safe to retry. The rules only match explicit refusals the providers report, they apply only before any agent activity on the call, and any unrecognised error stays uncertain. A login that expires mid-turn is therefore uncertain, not a refusal.

## Rejected Alternatives

### Resend refused calls automatically

Rejected. A refusal almost always comes from configuration, so resending would fail the same way and spend the run's budget.

### Keep treating refusals as uncertain outside preflight

Rejected. It tells a person to check for work that cannot have happened and blocks the retry that would fix the run.
