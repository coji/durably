# Output Contracts

Structured report formats used for communication between workflow phases.
These schemas ensure agents produce parseable, consistent output that the orchestrator
and downstream agents can reliably interpret.

## spec-review-report.md

```markdown
# Spec Review Result

## Result: APPROVE / REJECT

Judgment criteria:

- APPROVE: No issues, or only minor improvement suggestions (no impediment to implementation)
- REJECT: Contradictions in requirements, critical omissions in files to change, etc. — proceeding to implementation would certainly cause rework

Minor improvement suggestions (naming alternatives, additional test case ideas, etc.) are filed as issues under APPROVE.
Ambiguity that implementers can reasonably resolve on their own is not grounds for REJECT.

## Summary

{1-2 sentence summary}

## Checklist

| Aspect                               | Result | Notes |
| ------------------------------------ | ------ | ----- |
| Clarity of implementation scope      | OK/NG  |       |
| Completeness of files to change      | OK/NG  |       |
| Verifiability of completion criteria | OK/NG  |       |
| Appropriateness of scope             | OK/NG  |       |
| Leveraging existing patterns         | OK/NG  |       |

## Issues (if any)

Assign a severity to each issue:

- **blocking**: Implementation not possible. Grounds for REJECT
- **suggestion**: Improvement proposal. Communicated to implementer while remaining APPROVE
```

## acceptance-report.md

```markdown
# Acceptance Testing Result

## Result: APPROVE / REJECT

## Summary

{1-2 sentence summary}

## Completion Criteria Check

| #   | Criterion | Result | Notes |
| --- | --------- | ------ | ----- |
| 1   |           | Yes/No |       |

## Validation

Summary of pnpm validate output

## Scope Check

| Aspect                         | Result |
| ------------------------------ | ------ |
| Changed files are within scope | OK/NG  |
| order.md unmodified            | OK/NG  |

## Fix Instructions (if REJECT)

-
```

## supervise-report.md

```markdown
# Final Verification Result

## Judgment: COMPLETE / FIX / SPEC_REVIEW

Judgment criteria:

- COMPLETE: All completion criteria met, validation passes, within scope
- FIX: Implementation-level issues remain (resolvable by code changes)
- SPEC_REVIEW: Spec-level issues (order.md needs modification)

## Summary

{1-2 sentence summary}

## Completion Criteria Check

| #   | Criterion | Result | Notes |
| --- | --------- | ------ | ----- |
| 1   |           | Yes/No |       |

## Validation

Summary of pnpm validate output

## Scope Check

| Aspect                         | Result |
| ------------------------------ | ------ |
| Changed files are within scope | OK/NG  |
| order.md unmodified            | OK/NG  |

## Remaining Issues (if FIX / SPEC_REVIEW)

For each issue:

- Description of the issue
- Reason for routing to fix / spec-review
- Specific fix instructions
```

## code-review-round-N.md

Code-review rounds follow the canonical contract in
`docs/workflow/code-review.md`. Store them under
`$(git rev-parse --git-dir)/durably-review/<pr>/<head-sha>/round-<n>/` so producing a report cannot change the reviewed diff and linked worktrees remain supported.

The `Result` field is exactly one of:

- `GO`: complete review, no blockers, acceptance criteria pass, and fixed target unchanged
- `NO-GO`: at least one blocker requires a code or documentation change
- `INCOMPLETE`: a required perspective, model, verification, validation, or target-integrity check is missing

Only `GO` can proceed to the Ready gate. A later commit invalidates it.
