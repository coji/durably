#!/usr/bin/env tsx
/** CLI: worker | trigger | status | waits | approve | reject | report */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentDurably } from './durably.js'
import { parseProviderName } from './providers/index.js'
import { reportToJson, reportToMarkdown, toAttemptRow } from './report.js'

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
  pnpm demo trigger --provider codex|claude|fake [--max-iterations 2] [--model X] [--effort Y]
  pnpm demo status --run <id>
  pnpm demo waits --run <id>
  pnpm demo approve --run <id> --wait <waitId>
  pnpm demo reject --run <id> --wait <waitId>
  pnpm demo report --run <id> [--format json|md] [--out <file>]
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
  const receipt = await durably.signal(
    waitId,
    { decision: cmd === 'approve' ? 'approved' : 'rejected' },
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
  const output = run.output as { fake?: boolean } | null
  const isFake = output?.fake ?? fake
  const notes: string[] = []
  if (isFake)
    notes.push(
      'fake mode: deterministic local rehearsal, NOT real-LLM verification.',
    )
  const hasRealUsage = attempts.some((x) => {
    const m = x.metadata as { usage?: unknown; provider?: string } | null
    return (
      m !== null &&
      typeof m === 'object' &&
      m.provider !== 'fake' &&
      m.usage !== null &&
      m.usage !== undefined
    )
  })
  if (!isFake && !hasRealUsage)
    notes.push(
      'unverified: no token usage captured from the selected CLI; rerun with the logged-in CLI and keep the usage rows.',
    )
  const report = {
    runId,
    jobName: run.jobName,
    status: run.status,
    input: run.input,
    output: run.output,
    fake: isFake,
    verifiedByRealLlm: !isFake && hasRealUsage,
    attempts: attempts.map(toAttemptRow),
    waits: waits.map((w) => ({
      id: w.id,
      name: w.name,
      outcome: w.outcome,
      createdAt: w.createdAt,
      resolvedAt: w.resolvedAt,
    })),
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
