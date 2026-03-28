# Spec Review Procedure

Review the task spec (order.md) and the existing code targeted for changes.

## Steps

1. Read order.md and verify the following:
   - Whether the implementation details are clear
   - Whether the files to change are comprehensive (including implicit dependencies)
   - Whether the completion criteria are verifiable
   - Whether the out-of-scope section is clear

2. Actually read the files to change and understand the existing code structure

3. If a supervise report exists (`supervise-report.md`), read it and incorporate its findings into the review

4. Review from the following perspectives:
   - Are any files to change missing?
   - Are the completion criteria sufficient (edge cases, error handling)?
   - Is the scope appropriate (not too large/too small)?
   - Can existing patterns or utilities be leveraged?
