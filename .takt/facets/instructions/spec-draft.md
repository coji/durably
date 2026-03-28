# Spec Draft Procedure

Generate order.md based on the task description (issue body or user input).

## Steps

1. Read the task description and understand the purpose and scope of the implementation

2. Investigate existing code:
   - Identify files likely to be changed
   - Review existing structure, patterns, and dependencies
   - Check for test files and their organization

3. Generate order.md (with the following structure):

   ```markdown
   # Task Name

   ## Overview

   What to do (1-3 sentences)

   ## Background

   Why this is needed (may quote from the issue)

   ## Files to Change

   - path/to/file.ts — Summary of changes

   ## Implementation Details

   - List specific changes as bullet points
   - Do not include code examples (describe what to do, not how)

   ## Completion Criteria

   - [ ] List verifiable conditions
   - [ ] pnpm validate passes

   ## Out of Scope

   - Explicitly state what will not be done
   ```

4. Run the quality checklist before finalizing

## Quality Checklist

Before completing order.md, verify each item:

- [ ] For refactoring tasks: existing behaviors that must be preserved are listed as explicit completion criteria (not just "keep behavior unchanged")
- [ ] Negative test cases are required where applicable (e.g., "X does NOT happen when Y")
- [ ] Each completion criterion is independently verifiable (can be checked Yes/No without ambiguity)
- [ ] Files to change are confirmed by reading the actual code (not guessed from names)
- [ ] Out of scope items do not contradict the implementation details or files to change
- [ ] Implicit dependencies of changed files are accounted for (e.g., if a function signature changes, callers are in scope)
- [ ] New public API options require invalid input handling tests (e.g., 0, negative, NaN for numeric params)
- [ ] Async operations in intervals/loops have in-flight guards to prevent concurrent request buildup

## Rules

- Do not include code examples or snippets (keep it at the requirements level)
- Only list files to change after actually reading the code to confirm
- Completion criteria must be granular enough to be judged as Yes/No
- Do not use vague expressions ("appropriately", "as needed")
