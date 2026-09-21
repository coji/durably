# local-agent-loop — Durably local agent demo

Local-only demo: Durably + local SQLite (better-sqlite3) + **one** logged-in CLI
(Codex **or** Claude Code). No Docker, no cloud workflow infra, no GitHub auth,
no CI changes.

What it does:

1. Copies `subject/` (tiny buggy `calc.js`) into an execution-only
   `runs/<runId>/work/` directory; the selected agent edits only that copy.
2. Runs implement → local `npm test` (Mac subprocess) in a bounded loop.
3. Runs **two parallel reviews with the same provider in separate sessions**
   via `step.all({ 'review-a', 'review-b' })`.
4. Suspends on a durable wait for **local human approval** from the terminal.
5. Records per-attempt model / effort / token usage / elapsed / result into
   Durably attempt metadata; regenerates CLI + JSON/Markdown reports from
   persisted data.

Stage / Event / Reducer / Policy are separated (`src/types.ts`, `src/events.ts`,
`src/reducer.ts`, `src/policy.ts`); transitions use a lookup table, no giant
switch.

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
AGENT_TIMEOUT_MS=300000 TEST_TIMEOUT_MS=120000 CODEX_MODEL=gpt-5 CODEX_EFFORT=medium \
  pnpm --filter example-local-agent-loop demo trigger --provider codex
```

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

## Stop / restart resume check (same Mac, same SQLite)

1. Trigger with `--provider fake` and slow down one review branch:
   `FAKE_REVIEW_SLOW_MS=15000 pnpm --filter example-local-agent-loop demo worker`
   in terminal 1, trigger in terminal 2.
2. Wait until `status --run <id>` shows `review-a` completed (one attempt row),
   then hard-kill the worker: `kill -9 <worker-pid>`.
3. Restart the **same** command against the **same**
   `examples/local-agent-loop/local-agent-loop.db`.
4. Verify: completed `review-a` branch is **not** re-executed (single completed
   attempt, old `leaseGeneration`); the unfinished `review-b` attempt stays
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
fake success is **never** real-LLM verification — reports carry
`fake: true` / `verifiedByRealLlm: false`.

## Measurements

- Every implement / test / review branch writes an `AttemptMeasurement`
  (`provider, model, effort, elapsedMs, usage, costUsdEstimate, result, error`).
- Missing values are `null` and render as `unknown` — never zero-filled.
- Cost is an **API-equivalent estimate** (`costBasis: 'api-equivalent-estimate'`),
  not subscription billing; unknown model/usage yields `null`.
- Failures and interruptions are recorded too (error text, `interruptionReason`).

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
- `src/providers/` — `codex.ts`, `claude.ts`, `fake.ts`, lookup factory
- `src/job.ts` — `agent-loop` Durably job; `src/durably.ts` — better-sqlite3 instance
- `src/cli.ts` — worker/trigger/status/waits/approve/reject/report
- `src/report.ts`, `src/pricing.ts`, `src/prompts.ts`, `src/test-runner.ts`
- `runs/` (gitignored execution dirs), `local-agent-loop.db` (gitignored SQLite)
