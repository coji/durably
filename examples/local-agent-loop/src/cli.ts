#!/usr/bin/env tsx
/** CLI: worker | trigger | status | waits | approve | reject | report | compare */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentDurably } from './durably.js'
import { buildReport } from './engine/build-report.js'
import { killOwnedChildren, runChild } from './engine/child.js'
import { compareReports, comparisonToMarkdown } from './engine/compare.js'
import { parseProviderName } from './engine/providers/index.js'
import {
  reportToJson,
  reportToMarkdown,
  type LoopReport,
} from './engine/report.js'

interface IssueRef {
  number: number
  title: string
  url: string
  body: string
}

/** Read one issue through the user's own `gh` login. */
async function fetchIssue(repoPath: string, number: string): Promise<IssueRef> {
  const res = await runChild(
    'gh',
    ['issue', 'view', number, '--json', 'number,title,url,body'],
    { cwd: repoPath, timeoutMs: 60000 },
  )
  if (res.code !== 0)
    throw new Error(
      `gh issue view ${number} failed (${res.code ?? 'null'}): ${res.stderr.slice(-500)}`,
    )
  const parsed = JSON.parse(res.stdout) as IssueRef
  if (typeof parsed.number !== 'number' || typeof parsed.body !== 'string')
    throw new Error(`unexpected gh issue payload for ${number}`)
  return parsed
}

/**
 * Build the job's target from the flags.
 *
 * A check command is required for a repository target and is recorded before
 * the agent starts, so nothing the agent edits can change what grading runs.
 * The value is argv split on whitespace, not a shell line.
 */
async function resolveTarget(a: Record<string, string>) {
  const repo = a['repo']
  if (!repo) {
    if (a['issue'] || a['task'])
      throw new Error('--issue and --task need --repo <path>')
    return { kind: 'subject' as const }
  }
  const repoPath = isAbsolute(repo) ? repo : join(process.cwd(), repo)
  const check = a['check']
  if (!check)
    throw new Error(
      '--check "<command>" is required for --repo: it is the pinned check that decides pass or fail',
    )
  const issueNumber = a['issue']
  if (issueNumber && a['task'])
    throw new Error('pass either --issue or --task, not both')
  if (!issueNumber && !a['task'])
    throw new Error('--repo needs --issue <number> or --task "<text>"')
  const issue = issueNumber
    ? await fetchIssue(repoPath, issueNumber.replace(/^#/, ''))
    : null
  return {
    kind: 'repo' as const,
    repoPath,
    baseRef: a['base'] ?? 'HEAD',
    task: issue ? issue.body : (a['task'] as string),
    issue: issue
      ? { number: issue.number, title: issue.title, url: issue.url }
      : null,
    checkCommand: check.split(/\s+/).filter((part) => part.length > 0),
    setupCommand: a['setup']
      ? a['setup'].split(/\s+/).filter((part) => part.length > 0)
      : null,
    publish: a['publish'] === 'true',
  }
}

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
      real repository:  --repo <path> (--issue 234 | --task "...") --check "pnpm validate"
                        [--setup "pnpm install"] [--base <ref>] [--publish] [--approve auto|manual]
  pnpm demo status --run <id>
  pnpm demo waits --run <id>
  pnpm demo approve --run <id> --wait <waitId>
  pnpm demo reject --run <id> --wait <waitId>
  pnpm demo report --run <id> [--format json|md] [--out <file>]
  pnpm demo compare --runs <id,id,...> [--format json|md] [--out <file>]
Model presets (--model selects one; effort defaults from the preset and is
overridden only by --effort — no environment variable participates, so a run's
configuration is readable off the command line that started it):
  codex:  gpt-6-astra (low) | gpt-5.6-sol (low, default) | gpt-5.6-luna (max)
  claude: claude-fable-5-1 (low) | claude-opus-5 (high) | claude-sonnet-5 (high, default)
Note: effort is applied (Codex reasoningEffort / Claude effort setting), not
just recorded; unsupported values fail fast. Reports keep the raw requested,
resolved effective, and provider-reported settings separate.
Context defaults to reuse: implementation and repair continue one explicit
native session. Reviews always use independent new sessions.
Env: DURABLY_DB, AGENT_TIMEOUT_MS (default 300000), TEST_TIMEOUT_MS (default 120000),
     FAKE_FAIL_FIRST=0, FAKE_REVIEW_SEQUENCE, FAKE_REVIEW_SLOW_MS
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
  const a = args()
  const provider = parseProviderName(a['provider'] ?? 'fake')
  const context = a['context'] ?? 'reuse'
  if (context !== 'reuse' && context !== 'fresh')
    throw new Error('--context must be reuse|fresh')
  // Math.min/Math.max propagate NaN rather than clamping it, so a non-numeric
  // value would reach the job schema as NaN and surface as a zod stack trace.
  const rawIterations = a['max-iterations'] ?? '2'
  if (!/^[1-3]$/.test(rawIterations))
    throw new Error('--max-iterations must be an integer between 1 and 3')
  const maxIterations = Number(rawIterations)
  const target = await resolveTarget(a)
  const approve = a['approve']
  if (approve !== undefined && approve !== 'auto' && approve !== 'manual')
    throw new Error('--approve must be auto|manual')
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.jobs.agentLoop.trigger({
    provider,
    target,
    maxIterations,
    model: a['model'],
    effort: a['effort'],
    context,
    ...(approve ? { autoApprove: approve === 'auto' } : {}),
  })
  console.log(
    JSON.stringify(
      { runId: run.id, status: run.status, target: target.kind },
      null,
      2,
    ),
  )
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
  console.log(
    `binding approval to candidate ${target.candidateId} (${target.sourceHash?.slice(0, 12) ?? 'unknown hash'}).`,
  )
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
} else {
  usage()
  process.exit(1)
}
