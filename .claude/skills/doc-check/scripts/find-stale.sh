#!/usr/bin/env bash
# Find stale patterns across docs, examples, skills, and config.
#
# Usage:
#   ./find-stale.sh                    # Check all known patterns
#   ./find-stale.sh 'oldName|oldPath'  # Check custom patterns
#
# Exit code: 0 = clean, 1 = stale patterns found
#
# Why this exists:
#   API/type changes almost always leave stale docs and examples behind.
#   Running this script catches them before they become follow-up PRs.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

# Only check docs, examples, skills, config — NOT source code or tests
DOC_DIRS=(
  website/
  examples/
  README.md
  CLAUDE.md
  .claude/skills/
  packages/durably/README.md
  packages/durably/docs/
  packages/durably-react/README.md
  packages/durably-react/docs/
)

EXCLUDE="--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.vitepress/cache --exclude=pnpm-lock.yaml --exclude=llms.txt"

found=0

check_pattern() {
  local label="$1"
  local pattern="$2"
  local why="${3:-}"
  local exceptions="${4:-}"

  # shellcheck disable=SC2086
  results=$(grep -rn $EXCLUDE --include='*.md' --include='*.ts' --include='*.tsx' "$pattern" "${DOC_DIRS[@]}" 2>/dev/null || true)

  # Filter out known exceptions
  if [ -n "$exceptions" ] && [ -n "$results" ]; then
    results=$(echo "$results" | grep -v "$exceptions" || true)
  fi

  if [ -n "$results" ]; then
    echo -e "${RED}[STALE]${NC} $label"
    if [ -n "$why" ]; then
      echo -e "  ${YELLOW}Why:${NC} $why"
    fi
    echo "$results" | sed 's/^/  /'
    echo ""
    found=1
  fi
}

if [ $# -gt 0 ]; then
  # Custom pattern mode — search broadly
  check_pattern "Custom pattern" "$1" "User-specified pattern check"
else
  # ── Renamed APIs ──

  check_pattern \
    "createDurablyClient (renamed to createDurably)" \
    "createDurablyClient" \
    "Renamed in v0.10. Use createDurably from @coji/durably-react"

  check_pattern \
    "createDurablyHooks (renamed to createDurably)" \
    "createDurablyHooks" \
    "Renamed in v0.10. Use createDurably from @coji/durably-react"

  # ── Old import paths ──

  check_pattern \
    "Old import: @coji/durably-react/client" \
    "durably-react/client" \
    "Fullstack hooks are now the root import: @coji/durably-react" \
    "SKILL.md"  # Skills mention old paths as examples of what to check

  check_pattern \
    "Old import: @coji/durably-react/browser" \
    "durably-react/browser" \
    "SPA hooks moved to @coji/durably-react/spa" \
    "SKILL.md"

  # ── Old directory/file names ──

  check_pattern \
    "Old dir: browser-vite-react" \
    "browser-vite-react" \
    "Renamed to spa-vite-react"

  check_pattern \
    "Old dir: browser-react-router" \
    "browser-react-router" \
    "Renamed to spa-react-router"

  check_pattern \
    "Old file: durably.hooks" \
    "durably\.hooks" \
    "Use durably.ts (framework-agnostic)" \
    "SKILL.md"

  # ── Preferred patterns in guides/examples ──
  # (API ref pages like create-durably.md, define-job.md document these as valid API — excluded)

  API_REF_EXCLUDE="create-durably\.md\|define-job\.md\|step\.md\|http-handler\.md\|events\.md\|llms\.md\|CLAUDE\.md"

  check_pattern \
    ".register() chain in guides/examples" \
    '\.register({' \
    "Prefer createDurably({ jobs: {} }) in guides and examples" \
    "$API_REF_EXCLUDE"

  check_pattern \
    "migrate() in guides/examples" \
    'await durably\.migrate()' \
    "Prefer await durably.init() in guides and examples" \
    "$API_REF_EXCLUDE"

  check_pattern \
    "durably.start() in guides/examples" \
    'durably\.start()' \
    "Prefer await durably.init() in guides and examples" \
    "$API_REF_EXCLUDE"

  # ── Old terminology ──

  check_pattern \
    "Old terminology: Browser Hooks/Browser Mode" \
    'Browser Hooks\|Browser Mode\|Browser mode' \
    "Renamed to SPA Hooks / SPA Mode" \
    "SKILL.md"

  check_pattern \
    "Old terminology: Server Hooks/Client Hooks" \
    'Server Hooks\|Client Hooks' \
    "Renamed to Fullstack Hooks" \
    "SKILL.md"
fi

if [ $found -eq 0 ]; then
  echo -e "${GREEN}All clean. No stale patterns found.${NC}"
  exit 0
else
  echo -e "${RED}Review each [STALE] hit above and fix or confirm intentional.${NC}"
  exit 1
fi
