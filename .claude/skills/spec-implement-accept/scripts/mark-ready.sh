#!/bin/bash

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: mark-ready.sh <pr-number-or-url> <reviewed-head-sha> <validation-evidence>" >&2
  exit 64
fi

pr="$1"
reviewed_head="$2"
validation_evidence="$3"

if [ ! -f "$validation_evidence" ] ||
  ! grep -Fxq "reviewed_head=$reviewed_head" "$validation_evidence" ||
  ! grep -Fxq 'pnpm_validate=pass' "$validation_evidence"; then
  echo "Missing successful validation evidence for $reviewed_head" >&2
  exit 1
fi

read_pr_state() {
  gh pr view "$pr" --json headRefOid,isDraft \
    --jq '[.headRefOid, (.isDraft | tostring)] | @tsv'
}

read -r current_head is_draft < <(read_pr_state)
if [ "$is_draft" != "true" ]; then
  echo "PR is not Draft: $pr" >&2
  exit 1
fi
if [ "$current_head" != "$reviewed_head" ]; then
  echo "PR head changed: reviewed=$reviewed_head current=$current_head" >&2
  exit 1
fi

checks_ok=$(gh pr checks "$pr" --json bucket \
  --jq 'all(.[]; .bucket == "pass" or .bucket == "skipping")')
if [ "$checks_ok" != "true" ]; then
  echo "PR checks are pending, failed, or cancelled: $pr" >&2
  exit 1
fi

# Keep the last comparison adjacent to the state mutation.
read -r current_head is_draft < <(read_pr_state)
if [ "$is_draft" != "true" ] || [ "$current_head" != "$reviewed_head" ]; then
  echo "PR state changed before Ready mutation: $pr" >&2
  exit 1
fi

gh pr ready "$pr"

read -r current_head is_draft < <(read_pr_state)
if [ "$current_head" != "$reviewed_head" ]; then
  gh pr ready --undo "$pr"
  echo "PR head moved during Ready mutation; restored Draft state" >&2
  exit 1
fi

if [ "$is_draft" != "false" ]; then
  echo "PR did not enter Ready state: $pr" >&2
  exit 1
fi
