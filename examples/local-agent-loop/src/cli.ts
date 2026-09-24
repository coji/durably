#!/usr/bin/env tsx
/** CLI: worker | trigger | status | waits | approve | reject | report | compare | ui | seed */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { signalApproval } from './approval.js'
import { createAgentDurably, dbPath, legacyDbWarning } from './durably.js'
import { buildReport, recordedTriage } from './engine/build-report.js'
import { killOwnedChildren } from './engine/child.js'
import { compareReports, comparisonToMarkdown } from './engine/compare.js'
import { classifyRun } from './engine/failure-reasons.js'
import {
  reportToJson,
  reportToMarkdown,
  type LoopReport,
} from './engine/report.js'
import { diagnose, diagnosisLines } from './engine/status.js'
import { buildTriggerInput } from './trigger-input.js'

async function emit(text: string, out: string | undefined): Promise<void> {
  if (out) {
    const here = dirname(fileURLToPath(import.meta.url))
    // `join` does not reset on an absolute segment, so without this an
    // absolute --out lands under the example directory instead.
    const dest = isAbsolute(out) ? out : join(here, '..', out)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, text)
    console.log(`wrote ${dest}`)
  } else {
    console.log(text)
  }
}

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
      bundled sample (default): no further flags
      real repository:  --repo <path> (--issue 234 | --task "..." | --task-file <file>)
                        [--spec-file <file>] [--dispositions-file <file>] [--config <file>]
                        [--check "pnpm validate"] [--setup "pnpm install"] [--base <ref>]
                        [--publish] [--approve auto|manual]
  pnpm demo status                          open and stopped runs: reason and next command
  pnpm demo status --run <id>
  pnpm demo waits --run <id>
  pnpm demo approve --run <id> --wait <waitId>
  pnpm demo reject --run <id> --wait <waitId>
  pnpm demo retrigger --run <id>            new run with the stored input (only for stops safe to repeat)
  pnpm demo report --run <id> [--format json|md] [--out <file>]
  pnpm demo compare --runs <id,id,...> [--format json|md] [--out <file>]
  pnpm demo ui [--port 4380]                read-only web UI on 127.0.0.1 (runs, reports, comparison)
  pnpm demo seed [--home <dir>] [--latency 20000-90000]
                                            demo data on the fake provider in a throwaway HOME
Repository config: factory.json at the repository root, or --config <file>:
  { "check": ["pnpm", "validate"], "setup": ["pnpm", "install"], "base": "main",
    "profiles": { "code": { "provider": "codex", "model": "...", "effort": "..." },
                  "review": { "correctness": { ... }, "edge-cases": { ... } },
                  "triage": { ... } } }
  --check, --setup and --base override the config. A role the config leaves
  out uses --provider/--model/--effort. A field a role leaves out comes from
  --model/--effort when the role uses --provider's provider, and otherwise
  from that provider's preset defaults. "triage" is optional: when present,
  one read-only call records a routine or probe judgment before the code
  stage (shadow mode; it changes nothing about the run).
  The config and input files are read once at trigger; the run keeps the
  input file contents, and the report shows each one's SHA-256.
State: database and run data live in ${dirname(dbPath())}
  (worktrees, checkpoints, verification scratch, delivery patches under runs/<id>/).
Model presets (--model selects one; effort defaults from the preset and is
overridden only by --effort — no environment variable participates, so a run's
configuration is readable off the command line that started it):
  codex:  gpt-6-astra (low) | gpt-6-sol (medium) | gpt-6-luna (medium)
          gpt-5.6-sol (low, default) | gpt-5.6-terra (medium) | gpt-5.6-luna (max)
          (gpt-6-sol and gpt-6-luna need an API key; a ChatGPT login is refused)
  claude: claude-fable-5-1 (low) | claude-opus-5-5 (medium) | claude-opus-5 (high)
          claude-sonnet-5 (high, default)
Note: effort is applied (Codex reasoningEffort / Claude effort setting), not
just recorded; unsupported values fail fast. Reports keep the raw requested,
resolved effective, and provider-reported settings separate.
Context defaults to reuse: implementation and repair continue one explicit
native session. Reviews always use independent new sessions.
Env: AGENT_TIMEOUT_MS (default 300000), TEST_TIMEOUT_MS (default 120000),
     FAKE_FAIL_FIRST=0, FAKE_REVIEW_SEQUENCE, FAKE_REVIEW_SLOW_MS, FAKE_TRIAGE,
     FAKE_LATENCY_MS=<min>-<max>, FAKE_USAGE=realistic
`)
}

const cmd = process.argv[2]
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage()
  process.exit(0)
}

const legacyWarning = legacyDbWarning()
if (legacyWarning) console.error(legacyWarning)

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
    // Children lead their own process group, so an interrupt reaches the
    // worker but not the agent CLI it launched.
    killOwnedChildren()
    await durably.stop()
    await durably.db.destroy()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  await new Promise(() => {})
} else if (cmd === 'trigger') {
  const input = await buildTriggerInput(args())
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.jobs.agentLoop.trigger(input)
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        status: run.status,
        target: input.target.kind,
        db: dbPath(),
      },
      null,
      2,
    ),
  )
  await durably.db.destroy()
} else if (cmd === 'status' && !args()['run']) {
  const durably = createAgentDurably()
  await durably.migrate()
  const now = Date.now()
  const open: string[][] = []
  const leftovers: string[][] = []
  for (const run of await durably.getRuns({
    jobName: durably.jobs.agentLoop.name,
  })) {
    const d = await diagnose(durably, run, now)
    if (d.kind !== 'finished') open.push(diagnosisLines(run, d))
    else if (d.cleanup) leftovers.push(diagnosisLines(run, d))
  }
  const out: string[] = []
  if (open.length === 0)
    out.push(
      'No runs need attention: nothing is pending, running, waiting or stopped.',
    )
  else {
    out.push(`${open.length} run(s) need attention:`)
    for (const lines of open) out.push('', ...lines)
  }
  if (leftovers.length > 0) {
    out.push('', 'Finished runs whose worktree is still on disk:')
    for (const lines of leftovers) out.push('', ...lines)
  }
  out.push('', `database: ${dbPath()}`)
  console.log(out.join('\n'))
  await durably.db.destroy()
} else if (cmd === 'status') {
  const runId = args()['run'] as string
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.getRun(runId)
  const attempts = await durably.getStepAttempts(runId)
  const waits = await durably.getWaits(runId)
  console.log(
    JSON.stringify(
      {
        // Why the run is where it is, and the next command to run.
        diagnosis: run ? await diagnose(durably, run, Date.now()) : null,
        // Where the work ended up. The sealed candidate names the branch and
        // commit a repository run leaves behind, whatever its conclusion.
        delivery:
          (run?.output as { delivery?: unknown } | null)?.delivery ?? null,
        candidate:
          (run?.output as { candidate?: unknown } | null)?.candidate ?? null,
        // Null when the run has no triage profile or has not reached it.
        triage: run ? await recordedTriage(durably, run) : null,
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
  const receipt = await signalApproval(
    durably,
    runId,
    waitId,
    cmd === 'approve' ? 'approved' : 'rejected',
    (line) => console.log(line),
  )
  console.log(JSON.stringify(receipt, null, 2))
  await durably.db.destroy()
} else if (cmd === 'retrigger') {
  const runId = args()['run']
  if (!runId) throw new Error('--run <id> required')
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.getRun(runId)
  if (!run) throw new Error(`no run ${runId}`)
  // Only a stop the failure table calls safe to repeat: a fresh run resends
  // every agent call, so an uncertain call or a possible push must be checked
  // by a person first.
  const failure = await classifyRun(durably, run)
  if (!failure?.retryable)
    throw new Error(
      `refusing to retrigger ${runId}: ${failure ? failure.reason : `it is ${run.status}, not stopped`}`,
    )
  // One retry per stopped run: pasting the command again returns the run it
  // already started instead of paying for another, or pushing twice.
  const next = await durably.jobs.agentLoop.trigger(
    run.input as Parameters<typeof durably.jobs.agentLoop.trigger>[0],
    { idempotencyKey: `retrigger-of-${runId}` },
  )
  console.log(
    next.disposition === 'created'
      ? `new run ${next.id} with the input of ${runId}`
      : `already retriggered as ${next.id}; nothing new started`,
  )
  await durably.db.destroy()
} else if (cmd === 'report') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const format = a['format'] ?? 'md'
  const durably = createAgentDurably()
  await durably.migrate()
  const report = await buildReport(durably, runId)
  const text =
    format === 'json' ? reportToJson(report) : reportToMarkdown(report)
  await emit(text, a['out'])
  await durably.db.destroy()
} else if (cmd === 'compare') {
  const a = args()
  const runIds = (a['runs'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (runIds.length === 0)
    throw new Error('--runs <id,id,...> required (comma-separated run ids)')
  const format = a['format'] ?? 'md'
  const durably = createAgentDurably()
  await durably.migrate()
  const reports: LoopReport[] = []
  for (const runId of runIds) reports.push(await buildReport(durably, runId))
  const comparison = compareReports(reports)
  const text =
    format === 'json'
      ? JSON.stringify(comparison, null, 2)
      : comparisonToMarkdown(comparison)
  await emit(text, a['out'])
  await durably.db.destroy()
} else if (cmd === 'seed') {
  const { seedCommand } = await import('./demo-seed.js')
  await seedCommand(args())
} else if (cmd === 'ui') {
  const rawPort = args()['port'] ?? '4380'
  // Checked before anything listens: a typo must not silently pick a port.
  if (!/^\d{1,5}$/.test(rawPort) || +rawPort < 1 || +rawPort > 65535)
    throw new Error('--port must be an integer between 1 and 65535')
  const { startUiServer } = await import('./ui/server.js')
  const ui = await startUiServer({ port: Number(rawPort) })
  console.log(`web UI (read-only): ${ui.url}`)
  console.log(`database: ${dbPath()}`)
  console.log('Ctrl-C to stop')
  const shutdown = async () => {
    // Nothing is written, so a close that hangs is safe to cut short.
    setTimeout(() => process.exit(0), 2000).unref()
    await ui.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
} else {
  usage()
  process.exit(1)
}
