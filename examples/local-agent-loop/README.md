# local-agent-loop — Durably local agent demo

Local-only demo: Durably + local SQLite (better-sqlite3) + **one** logged-in CLI
(Codex **or** Claude Code). No Docker, no cloud workflow infra, no GitHub auth,
no CI changes.

What it does:

1. Copies `subject/` (tiny buggy `calc.js`) into an execution-only
   `runs/<runId>/work/` directory; the selected agent edits only that copy.
2. Runs implement → immutable acceptance-test grading (snapshot + tamper
   check) → local `npm test` (Mac subprocess) in a bounded loop.
3. Runs **two parallel reviews with the same provider in separate sessions**
   via `step.all({ 'review-a:<n>', 'review-b:<n>' })` against a frozen
   read-only snapshot. Adopted `needsChanges` findings route back to
   implement (target invalidated, notes carried); only an explicit
   well-formed `pass` counts — garbled/missing/contradictory verdicts are
   review-incomplete failures, never passes.
4. Suspends on a durable wait for **local human approval** from the terminal,
   bound to the reviewed target hash.
5. Records per-attempt requested/reported model / effort / token usage
   (input/cache/output + source) / elapsed / result into Durably attempt
   metadata; regenerates CLI + JSON/Markdown reports from persisted data
   (stage timings, run elapsed, human `inputWaitMs` vs requeue
   `executionSlotWaitMs`).

Policy → Stage → Event are separated (`src/policy.ts` holds the Stage
registry; the runner persists each `decideNext()` to a `policy:<n>` step,
executes the stage, then reduces the event); transitions use a lookup table,
no giant switch.

## Setup

```bash
pnpm install
node --test examples/local-agent-loop/subject/test/*.test.js  # subject is red until fixed (expected)
pnpm --filter example-local-agent-loop test:unit
```

Only the provider you use must be installed and logged in:

```bash
codex --version   # Codex path
claude --version  # Claude Code path
```

## Run A — Codex only

Terminal 1 (worker):

```bash
pnpm --filter example-local-agent-loop demo worker
```

Terminal 2:

```bash
# trigger (caps: max 2 iterations, 5 min per agent call by default)
pnpm --filter example-local-agent-loop demo trigger --provider codex --max-iterations 2
# status / waits
pnpm --filter example-local-agent-loop demo status --run <runId>
pnpm --filter example-local-agent-loop demo waits --run <runId>
# approve (or reject)
pnpm --filter example-local-agent-loop demo approve --run <runId> --wait <waitId>
pnpm --filter example-local-agent-loop demo reject --run <runId> --wait <waitId>
# reports (regenerated from SQLite, not memory)
pnpm --filter example-local-agent-loop demo report --run <runId> --format md
pnpm --filter example-local-agent-loop demo report --run <runId> --format json --out reports/<runId>.json
```

Optional caps/env:

```bash
AGENT_TIMEOUT_MS=300000 TEST_TIMEOUT_MS=120000 \
  pnpm --filter example-local-agent-loop demo trigger --provider codex --model gpt-5.6-sol
```

## Model presets

`--model` selects a preset; effort defaults from the preset unless overridden
via `--effort` or `CODEX_EFFORT` / `CLAUDE_EFFORT` (precedence:
`--effort` > env > preset).

| provider | model              | default effort | API-equiv $/1M in/out |
| -------- | ------------------ | -------------- | --------------------- |
| codex    | `gpt-6-astra`      | low            | $10 / $50             |
| codex    | `gpt-5.6-sol`      | low            | $5 / $30              |
| codex    | `gpt-5.6-luna`     | max            | $0.20 / $1.20         |
| claude   | `claude-fable-5-1` | low            | $10 / $50             |
| claude   | `claude-opus-5`    | high           | $5 / $25              |
| claude   | `claude-sonnet-5`  | high           | $2 / $10              |

Prices checked 2026-09-21 against OpenAI/Anthropic docs; they feed only the
`api-equivalent-estimate` cost label in reports, never subscription billing.
Effort is **applied**, not just recorded: Codex via `reasoningEffort`,
Claude via the `effort` setting (unsupported values fail fast instead of
being silently dropped). Requested vs provider-reported model/effort are
stored separately — a value the provider never reported is never shown as
reported.

## LLM calls (AI SDK v7, one common path)

All implement/review invocations go through a single runner
(`src/runner.ts`) on top of Vercel AI SDK v7 (`ai@7.0.107`) with the
community local-CLI providers `ai-sdk-provider-codex-cli@2.2.1` (Codex,
`codex login` subscription auth) and `ai-sdk-provider-claude-code@4.3.1`
(Claude, `claude auth login` subscription auth). No per-stage spawn/parse
duplication, no API-key fallback: the unselected CLI is never required to be
installed or authenticated. Per-attempt metadata records the resolved
package + CLI versions (`codex --version` / `claude --version`).

## Permissions (enforced, not just prompted)

- Codex implement runs with `-s workspace-write -C <workdir>`; reviews run
  with `sandboxMode: 'read-only'` against a frozen `review-snapshot-<n>/`
  copy that both reviewers share.
- Claude never uses `--dangerously-skip-permissions` by default
  (`permissionMode: 'default'`); a `canUseTool` guard denies file operations
  outside the execution dir (implement) and everything except `Read` inside
  the snapshot (reviews).
- Acceptance tests (`subject/test/`) are snapshotted at prepare time and
  hash-verified before every grading run: editing `test/` to force green
  fails the run with `acceptance-tampered`.
- Human approval binds to the reviewed target hash (`targetHash` in the wait
  metadata); if the workdir changed after review, the approval is rejected
  instead of reused.

## Cancel / resume semantics

The Durably step signal (cancel / lease-loss) aborts the in-flight AI SDK
call or test subprocess; only the owned child is killed (tracked pids, no
process-group broadcast), and the worker awaits its exit. A `kill -9`ed
worker reconciles a leftover pid marker on restart (pid + start-time match
required — reused pids are never signaled). Note: the Durably lease guards
**database writes only**; it does not guarantee the external CLI ran exactly
once — reports and this README never claim otherwise.

## Run B — Claude Code only

Same flow with `--provider claude` (no Codex needed):

```bash
pnpm --filter example-local-agent-loop demo worker
pnpm --filter example-local-agent-loop demo trigger --provider claude --max-iterations 2
pnpm --filter example-local-agent-loop demo status --run <runId>
pnpm --filter example-local-agent-loop demo waits --run <runId>
pnpm --filter example-local-agent-loop demo approve --run <runId> --wait <waitId>
pnpm --filter example-local-agent-loop demo report --run <runId> --format md
```

```bash
AGENT_TIMEOUT_MS=300000 CLAUDE_MODEL=sonnet CLAUDE_EFFORT=medium \
  pnpm --filter example-local-agent-loop demo trigger --provider claude
```

With a preset:

```bash
pnpm --filter example-local-agent-loop demo trigger --provider claude --model claude-opus-5
```

## Stop / restart resume check (same Mac, same SQLite)

1. Trigger with `--provider fake` and slow down one review branch:
   `FAKE_REVIEW_SLOW_MS=15000 pnpm --filter example-local-agent-loop demo worker`
   in terminal 1, trigger in terminal 2.
2. Wait until `status --run <id>` shows `review-a:<n>` completed (one attempt row),
   then hard-kill the worker: `kill -9 <worker-pid>`.
3. Restart the **same** command against the **same**
   `examples/local-agent-loop/local-agent-loop.db`.
4. Verify: the completed `review-a:<n>` branch is **not** re-executed (single completed
   attempt, old `leaseGeneration`); the unfinished `review-b:<n>` attempt stays
   `started` with `interruptionReason` (`lease-lost`/`unknown`) plus a new
   post-recovery attempt with a newer `leaseGeneration`. `report` shows both.

Real-LLM kill test works the same way (start one review, kill, restart), but
costs model calls; fake mode is the cheap rehearsal.

## fake mode (rehearsal only)

```bash
pnpm --filter example-local-agent-loop demo worker &
pnpm --filter example-local-agent-loop demo trigger --provider fake --max-iterations 2
# ... waits, approve, report as above; report is labeled fake
```

`fake` is deterministic: iteration 1 misses the fix (tests fail), iteration 2
fixes it, both reviews pass. `FAKE_FAIL_FIRST=0` makes iteration 1 pass.
`FAKE_REVIEW_SEQUENCE="needsChanges,pass"` forces a fix loop (round 1 has a
`needsChanges`, later rounds pass). fake success is **never** real-LLM
verification — reports carry `fake: true`, `realLlmCallCount: 0`,
`fullLoopVerified: false`.

## Measurements

- Every implement / test / review branch writes an `AttemptMeasurement`
  (`requestedModel/Effort`, `reportedModel/Effort`, `elapsedMs`, `usage`,
  `costUsdEstimate`, `result`, `error`). Requested values (what you asked
  for) and reported values (what the provider confirmed) are stored
  separately.
- Usage snapshots merge in order into the attempt; a failed tail preserves
  already-reported numbers. Missing values are `null` and render as
  `unknown` — never zero-filled. Both priced legs (input + output) are
  required before any cost is shown; partial usage yields `unknown` cost.
- Cost is an **API-equivalent estimate** (`costBasis: 'api-equivalent-estimate'`,
  source + check date in `priceBasis`), not subscription billing; unknown
  model/usage yields `null`.
- `codex exec` / Claude Agent SDK report usage once at completion
  (`usageSource: 'provider-final'`, `partialUsage: false`) — that constraint
  is recorded, not worked around with estimates.
- Failures and interruptions are recorded too (error text, `interruptionReason`).
- Reports show real-CLI call counts (`realLlmCallCount`) separately from
  `fullLoopVerified` (real CLI + terminal success + approval): usage rows
  alone never imply a verified loop.

## If real-LLM run is not possible here

Keep the evidence: report notes say `unverified` with the reason, plus the
repro command, e.g.:

```bash
pnpm --filter example-local-agent-loop demo trigger --provider codex --max-iterations 2
pnpm --filter example-local-agent-loop demo report --run <runId> --format md
```

## Layout

- `subject/` — pristine buggy template (never edited in place)
- `src/types.ts`, `src/events.ts`, `src/reducer.ts`, `src/policy.ts`
  (Stage registry + `decideNext`)
- `src/providers/` — `codex.ts`, `claude.ts` (AI SDK v7 providers), `fake.ts`,
  lookup factory; `src/runner.ts` — the single common call path
- `src/child.ts` — cancel-aware subprocess + pid reconciliation
- `src/acceptance.ts` — immutable acceptance-test snapshot/tamper check
- `src/usage.ts`, `src/pricing.ts`, `src/versions.ts` — measurement helpers
- `src/job.ts` — `agent-loop` Durably job; `src/durably.ts` — better-sqlite3 instance
- `src/cli.ts` — worker/trigger/status/waits/approve/reject/report
- `src/report.ts`, `src/prompts.ts` (strict verdicts), `src/test-runner.ts`,
  `src/test-step.ts`
- `runs/` (gitignored execution dirs), `local-agent-loop.db` (gitignored SQLite)
