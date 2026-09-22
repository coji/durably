#!/usr/bin/env tsx
/** CLI: worker | trigger | status | waits | approve | reject | report */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { reconcileRunPidFiles } from './child.js'
import { createAgentDurably } from './durably.js'
import { PRICE_BASIS } from './pricing.js'
import { parseProviderName } from './providers/index.js'
import {
  reportToJson,
  reportToMarkdown,
  stageTimings,
  totalStageMs,
  toAttemptRow,
  type LoopReport,
} from './report.js'

function args(): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = process.argv.slice(3)
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]
    if (!t) continue
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const next = raw[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = 'true'
      }
    }
  }
  return out
}

function usage(): void {
  console.log(`local-agent-loop — Durably local agent demo
Commands (run from examples/local-agent-loop):
  pnpm demo worker                          start worker (long-running; kill -9 to test resume)
  pnpm demo trigger --provider codex|claude|fake [--context reuse|fresh] [--max-iterations 2] [--model X] [--effort Y]
  pnpm demo status --run <id>
  pnpm demo waits --run <id>
  pnpm demo approve --run <id> --wait <waitId>
  pnpm demo reject --run <id> --wait <waitId>
  pnpm demo report --run <id> [--format json|md] [--out <file>]
Model presets (--model selects one; effort defaults from the preset,
overridable via --effort or CODEX_EFFORT / CLAUDE_EFFORT):
  codex:  gpt-6-astra (low) | gpt-5.6-sol (low, default) | gpt-5.6-luna (max)
  claude: claude-fable-5-1 (low) | claude-opus-5 (high) | claude-sonnet-5 (high, default)
Note: effort is applied (Codex reasoningEffort / Claude effort setting), not
just recorded; unsupported values fail fast. Requested shows the resolved
settings saved before launch; reported shows only natively-confirmed values.
Context defaults to reuse: implementation and repair continue one explicit
native session. Reviews always use independent new sessions.
Env: DURABLY_DB, AGENT_TIMEOUT_MS (default 300000), TEST_TIMEOUT_MS (default 120000),
     CODEX_MODEL/CODEX_EFFORT, CLAUDE_MODEL/CLAUDE_EFFORT, FAKE_FAIL_FIRST=0, FAKE_REVIEW_SLOW_MS
`)
}

const cmd = process.argv[2]
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage()
  process.exit(0)
}

if (cmd === 'worker') {
  const durably = createAgentDurably()
  const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs')
  const reconciled = await reconcileRunPidFiles(runsRoot)
  if (reconciled.checked > 0) {
    console.log(
      `[reconcile] pid markers checked=${reconciled.checked} cleaned=${reconciled.cleaned} residualKilled=${reconciled.residualKilled}`,
    )
  }
  durably.on('run:leased', (e) =>
    console.log(`[run:leased] ${e.jobName} ${e.runId}`),
  )
  durably.on('run:waiting', (e) => console.log(`[run:waiting] ${e.runId}`))
  durably.on('run:complete', (e) =>
    console.log(`[run:complete] ${e.runId} output=${JSON.stringify(e.output)}`),
  )
  durably.on('run:fail', (e) => console.log(`[run:fail] ${e.runId} ${e.error}`))
  durably.on('step:complete', (e) =>
    console.log(`[step:complete] ${e.stepName} run=${e.runId}`),
  )
  await durably.init()
  console.log('worker running (Ctrl-C to stop; kill -9 <pid> to test resume)')
  const shutdown = async () => {
    await durably.stop()
    await durably.db.destroy()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  await new Promise(() => {})
} else if (cmd === 'trigger') {
  const a = args()
  const provider = parseProviderName(a['provider'] ?? 'fake')
  const context = a['context'] ?? 'reuse'
  if (context !== 'reuse' && context !== 'fresh')
    throw new Error('--context must be reuse|fresh')
  const maxIterations = Math.min(
    3,
    Math.max(1, parseInt(a['max-iterations'] ?? '2', 10)),
  )
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.jobs.agentLoop.trigger({
    provider,
    maxIterations,
    model: a['model'],
    effort: a['effort'],
    context,
  })
  console.log(JSON.stringify({ runId: run.id, status: run.status }, null, 2))
  await durably.db.destroy()
} else if (cmd === 'status') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.getRun(runId)
  const attempts = await durably.getStepAttempts(runId)
  const waits = await durably.getWaits(runId)
  console.log(
    JSON.stringify(
      {
        run,
        attempts: attempts.map((x) => ({
          id: x.id,
          stepName: x.stepName,
          stepIndex: x.stepIndex,
          leaseGeneration: x.leaseGeneration,
          status: x.status,
          metadata: x.metadata,
          interruptionReason: x.interruptionReason,
        })),
        waits,
      },
      null,
      2,
    ),
  )
  await durably.db.destroy()
} else if (cmd === 'waits') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const durably = createAgentDurably()
  await durably.migrate()
  console.log(JSON.stringify(await durably.getWaits(runId), null, 2))
  await durably.db.destroy()
} else if (cmd === 'approve' || cmd === 'reject') {
  const a = args()
  const runId = a['run']
  const waitId = a['wait']
  if (!runId || !waitId) throw new Error('--run <id> --wait <waitId> required')
  const durably = createAgentDurably()
  await durably.migrate()
  const pending = await durably.getWaits(runId)
  const target = pending.find((w) => w.id === waitId)?.metadata as {
    candidateId?: string
    sourceHash?: string
    reviews?: unknown
    reviewRounds?: number
  } | null
  if (!target?.candidateId)
    throw new Error('wait metadata has no candidateId; refusing unbound signal')
  if (target?.candidateId) {
    console.log(
      `binding approval to candidate ${target.candidateId} (${target.sourceHash?.slice(0, 12) ?? 'unknown hash'}).`,
    )
  }
  const receipt = await durably.signal(
    waitId,
    {
      candidateId: target.candidateId,
      decision: cmd === 'approve' ? 'approved' : 'rejected',
    },
    { signalId: `local-${cmd}-${Date.now()}` },
  )
  console.log(JSON.stringify(receipt, null, 2))
  await durably.db.destroy()
} else if (cmd === 'report') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const format = a['format'] ?? 'md'
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.getRun(runId)
  if (!run) throw new Error(`run not found: ${runId}`)
  const attempts = await durably.getStepAttempts(runId)
  const waits = await durably.getWaits(runId)
  const input = run.input as { provider?: string } | null
  const fake = (input?.provider ?? '') === 'fake'
  const output = run.output as {
    fake?: boolean
    conclusion?: string
    approved?: boolean
  } | null
  const isFake = output?.fake ?? fake
  const notes: string[] = []
  if (isFake)
    notes.push(
      'fake mode: deterministic local rehearsal, NOT real-LLM verification.',
    )
  const rows = attempts.map(toAttemptRow)
  // A real CLI call happened when a non-fake attempt completed its provider
  // invocation — independent of whether usage numbers were captured.
  const realInvocationIds = new Set(
    rows
      .filter(
        (r) =>
          r.measurement !== null &&
          r.measurement.provider !== 'fake' &&
          r.measurement.fake === false &&
          (r.measurement.result?.endsWith('-done') ||
            r.measurement.result === 'checkpoint-recovered'),
      )
      .map((r) => r.measurement?.invocationId)
      .filter((id): id is string => typeof id === 'string'),
  )
  const realLlmCallCount = realInvocationIds.size
  const conclusion = output?.conclusion ?? null
  const fullLoopVerified =
    !isFake &&
    run.status === 'completed' &&
    conclusion === 'approved' &&
    output?.approved === true &&
    realLlmCallCount > 0
  if (!isFake && realLlmCallCount === 0)
    notes.push(
      'unverified: no completed call from the selected CLI was observed; rerun with the logged-in CLI.',
    )
  if (!isFake && realLlmCallCount > 0 && !fullLoopVerified)
    notes.push(
      `real CLI calls observed (${realLlmCallCount}) but the full loop did not succeed (status=${run.status}, conclusion=${conclusion ?? 'unknown'}); this run is NOT full-loop verified.`,
    )
  if (
    rows.some(
      (r) =>
        r.measurement?.usage != null &&
        (r.measurement.usage.inputTokens === null ||
          r.measurement.usage.outputTokens === null),
    )
  )
    notes.push(
      'partial usage: some attempts report incomplete token legs; those legs render unknown and are excluded from cost.',
    )
  notes.push(
    'Completed invocation checkpoints are reused without resending. A start-only checkpoint is reported as uncertain and stops the run.',
  )
  const timings = stageTimings(rows)
  // Unknown when any stage timing is partial (missing attempts), so a
  // known-only sum is never presented as the whole-run stage cost.
  const stageTotalMs = totalStageMs(timings)
  const runElapsedMs =
    run.completedAt != null
      ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.createdAt))
      : null
  const versions: Record<string, string | null> = {}
  for (const r of rows) {
    const v = r.measurement?.versions
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (versions[k] == null && typeof val === 'string') versions[k] = val
      }
    }
  }
  const report: LoopReport = {
    runId,
    jobName: run.jobName,
    status: run.status,
    input: run.input,
    output: run.output,
    fake: isFake,
    realLlmCallCount,
    fullLoopVerified,
    attempts: rows,
    waits: waits.map((w) => ({
      id: w.id,
      name: w.name,
      outcome: w.outcome,
      createdAt: w.createdAt,
      suspendedAt: w.suspendedAt,
      resolvedAt: w.resolvedAt,
      inputWaitMs: w.inputWaitMs,
      executionSlotWaitMs: w.executionSlotWaitMs,
    })),
    stageTimings: timings,
    stageTotalMs,
    runElapsedMs,
    versions,
    priceBasis: PRICE_BASIS,
    notes,
  }
  const text =
    format === 'json' ? reportToJson(report) : reportToMarkdown(report)
  const out = a['out']
  if (out) {
    const here = dirname(fileURLToPath(import.meta.url))
    const dest = join(here, '..', out)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, text)
    console.log(`wrote ${dest}`)
  } else {
    console.log(text)
  }
  await durably.db.destroy()
} else {
  usage()
  process.exit(1)
}
