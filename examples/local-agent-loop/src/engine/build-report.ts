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
  TRIAGE_JUDGMENTS,
  type LoopReport,
  type ReportCandidate,
  type ReportCandidateChanges,
  type ReportDelivery,
  type ReportInputs,
  type ReportReview,
  type ReportReviewRound,
  type ReportSealedCandidate,
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

/** The reads a report makes; a caller may pass a per-request cache of them. */
export type ReportSource = Pick<
  AnyDurably,
  'getRun' | 'getStepAttempts' | 'getWaits'
> & {
  storage: Pick<AnyDurably['storage'], 'getCompletedStep' | 'getSteps'>
}

/**
 * Each role's requested settings, read from the run input. A run triggered
 * without per-role profiles used the single provider, model and effort for
 * every role.
 */
function profileRows(input: PersistedInput | null): RoleProfileRow[] {
  const row = (role: string, p: PersistedProfile): RoleProfileRow => ({
    role,
    provider: p.provider ?? null,
    requestedModel: p.requestedModel ?? null,
    requestedEffort: p.requestedEffort ?? null,
  })
  const fallback: PersistedProfile = {
    provider: input?.provider,
    requestedModel: input?.model,
    requestedEffort: input?.effort,
  }
  const rows = ROLES.map((role) =>
    row(role, input?.profiles?.[role] ?? fallback),
  )
  // Triage has no fallback: without its own profile it never runs.
  const triage = input?.profiles?.['triage']
  return triage ? [...rows, row('triage', triage)] : rows
}

function asTriage(value: unknown): ReportTriage | null {
  const v = value as Partial<ReportTriage> | null
  return v?.judgment &&
    TRIAGE_JUDGMENTS.includes(v.judgment) &&
    typeof v.reason === 'string'
    ? { judgment: v.judgment, reason: v.reason }
    : null
}

/**
 * The run's triage judgment. A finished run carries it in its output; an open
 * one (running, or waiting for approval) has only the completed triage step.
 */
export async function recordedTriage(
  durably: Pick<ReportSource, 'storage'>,
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

function asReviews(value: unknown): ReportReview[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((v) => {
    const r = v as Partial<ReportReview> | null
    return typeof r?.lens === 'string' &&
      typeof r.decision === 'string' &&
      typeof r.notes === 'string'
      ? [{ lens: r.lens, decision: r.decision, notes: r.notes }]
      : []
  })
}

/**
 * The last review round. A run with an output carries it there; a run
 * waiting for approval has it only in the approval wait's metadata, so the
 * latest wait that recorded reviews is used.
 */
function lastReviews(
  output: unknown,
  waits: { metadata: unknown }[],
): ReportReview[] {
  if (output != null)
    return asReviews((output as { reviews?: unknown }).reviews) ?? []
  for (const wait of [...waits].reverse()) {
    const fromWait = asReviews(
      (wait.metadata as { reviews?: unknown } | null)?.reviews,
    )
    if (fromWait) return fromWait
  }
  return []
}

type StoredStep = Awaited<
  ReturnType<ReportSource['storage']['getSteps']>
>[number]

function asChanges(value: unknown): ReportCandidateChanges | null {
  const v = value as Partial<ReportCandidateChanges> | null | undefined
  return typeof v?.files === 'number' &&
    typeof v.additions === 'number' &&
    typeof v.deletions === 'number' &&
    typeof v.diffPath === 'string' &&
    typeof v.changedFilesPath === 'string'
    ? {
        files: v.files,
        additions: v.additions,
        deletions: v.deletions,
        diffPath: v.diffPath,
        changedFilesPath: v.changedFilesPath,
      }
    : null
}

/** A stored candidate, as the report shows it; null when it has no id. */
export function asReportCandidate(value: unknown): ReportCandidate | null {
  const v = value as {
    id?: unknown
    branch?: unknown
    commit?: unknown
    changes?: unknown
  } | null
  return typeof v?.id === 'string'
    ? {
        id: v.id,
        branch: typeof v.branch === 'string' ? v.branch : null,
        commit: typeof v.commit === 'string' ? v.commit : null,
        changes: asChanges(v.changes),
      }
    : null
}

/** `stage:<sequence>:<stage>:<part>` split up; null for other step names. */
function stageStep(
  name: string,
): { sequence: number; stage: string; part: string } | null {
  const [kind, seq, stage, part] = name.split(':')
  const sequence = Number(seq)
  return kind === 'stage' && Number.isInteger(sequence) && stage && part
    ? { sequence, stage, part }
    : null
}

/** Every completed `stage:<n>:code:candidate` step, in sealing order. */
function sealedCandidates(steps: StoredStep[]): ReportSealedCandidate[] {
  const sealed = steps
    .flatMap((s) => {
      const where = stageStep(s.name)
      const candidate = asReportCandidate(s.output)
      return s.status === 'completed' &&
        where?.stage === 'code' &&
        where.part === 'candidate' &&
        candidate
        ? [{ ...candidate, sequence: where.sequence }]
        : []
    })
    .sort((x, y) => x.sequence - y.sequence)
  return sealed.map((c, i) => ({ ...c, iteration: i + 1 }))
}

/**
 * Every review round, from the stored review step outputs. Each round is
 * paired with the last candidate sealed before it, which is the candidate
 * the review stage checked.
 */
function reviewRoundsOf(
  steps: StoredStep[],
  candidates: ReportSealedCandidate[],
): ReportReviewRound[] {
  const rounds = new Map<number, Map<string, ReportReview>>()
  for (const s of steps) {
    const where = stageStep(s.name)
    if (s.status !== 'completed' || where?.stage !== 'review') continue
    const [review] = asReviews([s.output]) ?? []
    if (!review || review.lens !== where.part) continue
    const round = rounds.get(where.sequence) ?? new Map()
    round.set(review.lens, review)
    rounds.set(where.sequence, round)
  }
  const lensOrder = ['correctness', 'edge-cases']
  return [...rounds]
    .sort(([x], [y]) => x - y)
    .map(([sequence, byLens], i) => {
      const reviewed = candidates.filter((c) => c.sequence < sequence).at(-1)
      return {
        round: i + 1,
        sequence,
        candidate: reviewed
          ? {
              id: reviewed.id,
              branch: reviewed.branch,
              commit: reviewed.commit,
              changes: reviewed.changes ?? null,
            }
          : null,
        reviews: [...byLens.values()].sort(
          (x, y) => lensOrder.indexOf(x.lens) - lensOrder.indexOf(y.lens),
        ),
      }
    })
}

/**
 * The last sealed candidate. A run with an output carries it there; an open
 * one has only its completed `stage:<n>:code:candidate` steps.
 */
function lastCandidate(
  output: { candidate?: unknown } | null,
  candidates: ReportSealedCandidate[],
): ReportCandidate | null {
  if (output != null) return asReportCandidate(output.candidate)
  const last = candidates.at(-1)
  return last
    ? {
        id: last.id,
        branch: last.branch,
        commit: last.commit,
        changes: last.changes ?? null,
      }
    : null
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
  durably: ReportSource,
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
  const steps = await durably.storage.getSteps(runId)
  const candidates = sealedCandidates(steps)
  const candidate = lastCandidate(output, candidates)
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
    candidates,
    reviews: lastReviews(run.output, waits),
    reviewRounds: reviewRoundsOf(steps, candidates),
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
