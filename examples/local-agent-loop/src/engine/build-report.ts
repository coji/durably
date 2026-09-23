/** Assemble a LoopReport from persisted Durably data for one run. */
import { createHash } from 'node:crypto'

import type { AnyDurably } from '@coji/durably'

import { classifyRun } from './failure-reasons.js'
import { PRICE_BASIS } from './pricing.js'
import {
  roleUsage,
  stageTimings,
  stageUsage,
  stageVisits,
  summarizeRun,
  totalStageMs,
  toAttemptRow,
  type LoopReport,
  type ReportCandidate,
  type ReportDelivery,
  type ReportInputs,
  type ReportTriage,
  type RoleProfileRow,
} from './report.js'

interface PersistedProfile {
  provider?: string
  requestedModel?: string | null
  requestedEffort?: string | null
}

interface PersistedInput {
  provider?: string
  model?: string
  effort?: string
  profiles?: Record<string, PersistedProfile>
  target?: {
    task?: string
    spec?: string | null
    dispositions?: string | null
    inputFiles?: Record<string, { path?: string } | null>
  }
}

const ROLES = ['code', 'correctness', 'edge-cases'] as const

/**
 * Each role's requested settings, read from the run input. A run triggered
 * without per-role profiles used the single provider, model and effort for
 * every role.
 */
function profileRows(input: PersistedInput | null): RoleProfileRow[] {
  const triage = input?.profiles?.['triage']
  const rows = ROLES.map((role) => {
    const p = input?.profiles?.[role]
    return p
      ? {
          role,
          provider: p.provider ?? null,
          requestedModel: p.requestedModel ?? null,
          requestedEffort: p.requestedEffort ?? null,
        }
      : {
          role,
          provider: input?.provider ?? null,
          requestedModel: input?.model ?? null,
          requestedEffort: input?.effort ?? null,
        }
  })
  // Triage has no fallback: without its own profile it never runs.
  return triage
    ? [
        ...rows,
        {
          role: 'triage',
          provider: triage.provider ?? null,
          requestedModel: triage.requestedModel ?? null,
          requestedEffort: triage.requestedEffort ?? null,
        },
      ]
    : rows
}

function asTriage(value: unknown): ReportTriage | null {
  const v = value as { judgment?: unknown; reason?: unknown } | null
  return v &&
    (v.judgment === 'routine' ||
      v.judgment === 'probe' ||
      v.judgment === 'unknown') &&
    typeof v.reason === 'string'
    ? { judgment: v.judgment, reason: v.reason }
    : null
}

/**
 * The run's triage judgment. A finished run carries it in its output; an open
 * one (running, or waiting for approval) has only the completed triage step.
 */
export async function recordedTriage(
  durably: Pick<AnyDurably, 'storage'>,
  run: { id: string; output: unknown },
): Promise<ReportTriage | null> {
  const fromOutput = asTriage(
    (run.output as { triage?: unknown } | null)?.triage,
  )
  if (fromOutput) return fromOutput
  return asTriage(
    (await durably.storage.getCompletedStep(run.id, 'triage'))?.output,
  )
}

/**
 * Each input file's path, with the SHA-256 of the content the run stored and
 * used. The hash is computed here, so it always describes that content.
 */
function inputHashes(input: PersistedInput | null): ReportInputs {
  const target = input?.target
  const entry = (name: keyof ReportInputs) => {
    const path = target?.inputFiles?.[name]?.path
    const content = target?.[name]
    return path && typeof content === 'string'
      ? { path, sha256: createHash('sha256').update(content).digest('hex') }
      : null
  }
  return {
    task: entry('task'),
    spec: entry('spec'),
    dispositions: entry('dispositions'),
  }
}

export async function buildReport(
  durably: Pick<
    AnyDurably,
    'getRun' | 'getStepAttempts' | 'getWaits' | 'storage'
  >,
  runId: string,
): Promise<LoopReport> {
  const run = await durably.getRun(runId)
  if (!run) throw new Error(`run not found: ${runId}`)
  const attempts = await durably.getStepAttempts(runId)
  const waits = await durably.getWaits(runId)
  const failure = await classifyRun(durably, run)
  const input = run.input as PersistedInput | null
  const fake = (input?.provider ?? '') === 'fake'
  const output = run.output as {
    fake?: boolean
    conclusion?: string
    approved?: boolean
    delivery?: Partial<ReportDelivery> | null
    candidate?: { id?: string; branch?: string; commit?: string } | null
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
          r.measurement.usageScope === 'invocation' &&
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
  const codexUnknownWrites = new Set(
    rows
      .filter(
        (r) =>
          r.measurement?.provider === 'codex' &&
          r.measurement.usage != null &&
          r.measurement.usage.cacheWriteTokens == null,
      )
      .map((r) => r.measurement?.invocationId ?? r.attemptId),
  )
  if (codexUnknownWrites.size > 0)
    notes.push(
      `cache writes unknown for ${codexUnknownWrites.size} Codex invocation(s): on a ChatGPT login the server reports 0 for every request (openai/codex#32479), so the cost estimate excludes the 1.25x cache-write premium and is a lower bound.`,
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
  const configVersion =
    rows
      .map((r) => r.measurement?.configVersion ?? null)
      .find((v): v is string => typeof v === 'string') ?? null
  const waitRows = waits.map((w) => ({
    id: w.id,
    name: w.name,
    outcome: w.outcome,
    createdAt: w.createdAt,
    suspendedAt: w.suspendedAt,
    resolvedAt: w.resolvedAt,
    inputWaitMs: w.inputWaitMs,
    executionSlotWaitMs: w.executionSlotWaitMs,
  }))
  const usage = stageUsage(rows)
  const visits = stageVisits(rows)
  const recorded = output?.delivery
  const delivery: ReportDelivery | null = recorded
    ? {
        kind: recorded.kind ?? 'unknown',
        location: recorded.location ?? '',
        summary: recorded.summary ?? '',
        branch: recorded.branch ?? null,
        commit: recorded.commit ?? null,
      }
    : null
  const sealed = output?.candidate
  const candidate: ReportCandidate | null = sealed?.id
    ? {
        id: sealed.id,
        branch: sealed.branch ?? null,
        commit: sealed.commit ?? null,
      }
    : null
  return {
    runId,
    jobName: run.jobName,
    status: run.status,
    input: run.input,
    output: run.output,
    fake: isFake,
    configVersion,
    summary: summarizeRun({
      status: run.status,
      output: run.output,
      runElapsedMs,
      stageTotalMs,
      waits: waitRows,
      attempts: rows,
      stageUsage: usage,
      stageVisits: visits,
    }),
    triage: await recordedTriage(durably, run),
    stageUsage: usage,
    roleUsage: roleUsage(rows, profileRows(input)),
    inputs: inputHashes(input),
    candidate,
    delivery,
    failure,
    stageVisits: visits,
    realLlmCallCount,
    fullLoopVerified,
    attempts: rows,
    waits: waitRows,
    stageTimings: timings,
    stageTotalMs,
    runElapsedMs,
    versions,
    priceBasis: PRICE_BASIS,
    notes,
  }
}
