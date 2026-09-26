/** Assemble a LoopReport from persisted Durably data for one run. */
import { createHash } from 'node:crypto'

import type { AnyDurably } from '@coji/durably'

import { classifyRun, stageStep } from './failure-reasons.js'
import { PRICE_BASIS } from './pricing.js'
import type { VerificationLog } from './providers/types.js'
import {
  roleUsage,
  stageTimings,
  stageUsage,
  stageVisits,
  summarizeRun,
  totalStageMs,
  toAttemptRow,
  CALIBRATION_KEYS,
  TRIAGE_JUDGMENTS,
  UNKNOWN_CALIBRATION,
  usageOf,
  type AttemptRow,
  type LoopReport,
  type ReportBaseline,
  type ReportCandidate,
  type ReportCandidateChanges,
  type ReportDelivery,
  type ReportInputs,
  type ReportLineage,
  type ReportPreflight,
  type ReportPreflightCheck,
  type ReportReview,
  type ReportReviewRound,
  type ReportSealedCandidate,
  type ReportTriage,
  type RoleProfileRow,
  type TriageCalibration,
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
  repairOf?: {
    runId?: string
    candidateCommit?: string
    findings?: string
    findingsFile?: { path?: string }
  }
}

const ROLES = ['code', 'correctness', 'edge-cases'] as const

/** The reads a report makes; a caller may pass a per-request cache of them. */
export type ReportSource = Pick<
  AnyDurably,
  'getRun' | 'getStepAttempts' | 'getWaits' | 'getRuns'
> & {
  storage: Pick<AnyDurably['storage'], 'getCompletedStep' | 'getSteps'>
}

/**
 * Each role's requested settings, read from the run input. A run triggered
 * without per-role profiles used the single provider, model and effort for
 * every role.
 */
function profileRows(
  input: PersistedInput | null,
  repaired: boolean,
): RoleProfileRow[] {
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
  // Repair runs on code's settings unless it has its own. Its usage is its
  // own row after code's, never folded into it, once it has a profile or has run.
  const repairProfile = input?.profiles?.['repair']
  if (repairProfile) rows.splice(1, 0, row('repair', repairProfile))
  else if (repaired && rows[0])
    rows.splice(1, 0, { ...rows[0], role: 'repair' })
  // Triage has no fallback: without its own profile it never runs. A repair
  // run keeps its parent's triage profile but never runs it, so it has no row.
  const triage = input?.repairOf ? undefined : input?.profiles?.['triage']
  return triage ? [...rows, row('triage', triage)] : rows
}

/** A stored calibration; a value missing from an older record is unknown. */
function asCalibration(value: unknown): TriageCalibration {
  if (!value || typeof value !== 'object') return { ...UNKNOWN_CALIBRATION }
  const v = value as Record<string, unknown>
  return Object.fromEntries(
    CALIBRATION_KEYS.map((key) => {
      const n = v[key]
      return [
        key,
        typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null,
      ]
    }),
  ) as unknown as TriageCalibration
}

function asTriage(value: unknown): ReportTriage | null {
  const v = value as (Partial<ReportTriage> & { calibration?: unknown }) | null
  return v?.judgment &&
    TRIAGE_JUDGMENTS.includes(v.judgment) &&
    typeof v.reason === 'string'
    ? {
        judgment: v.judgment,
        reason: v.reason,
        calibration: asCalibration(v.calibration),
      }
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
        candidate: reviewed ? toReportCandidate(reviewed) : null,
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
  return last ? toReportCandidate(last) : null
}

function toReportCandidate({
  id,
  branch,
  commit,
  changes,
}: ReportSealedCandidate): ReportCandidate {
  return { id, branch, commit, changes }
}

/**
 * The base-commit check: the completed step's verdict and the log it cites,
 * or, while no attempt has finished, the last attempt's log without one.
 */
function baselineOf(
  steps: StoredStep[],
  rows: AttemptRow[],
): ReportBaseline | null {
  const attempts = rows.filter((r) => r.stepName === 'baseline')
  const done = steps.find((s) => s.name === 'baseline')
  const output = done?.status === 'completed' ? done.output : null
  const verdict = output as {
    passed?: unknown
    exitCode?: unknown
    log?: VerificationLog | null
  } | null
  if (verdict && typeof verdict.passed === 'boolean')
    return {
      passed: verdict.passed,
      exitCode: typeof verdict.exitCode === 'number' ? verdict.exitCode : null,
      log: verdict.log ?? null,
      recovered: attempts.some(
        (a) => a.measurement?.result === 'checkpoint-recovered',
      ),
    }
  if (attempts.length === 0) return null
  return {
    passed: null,
    exitCode: null,
    log: attempts.at(-1)?.measurement?.verificationLog ?? null,
    recovered: false,
  }
}

interface StoredPreflightCheck {
  roles?: string[]
  provider?: string
  model?: string | null
  effort?: string | null
  cliPath?: string | null
  cliVersion?: string | null
  free?: { verdict?: string; method?: string; detail?: string }
}

/**
 * Each preflight check with what decided it: the free check, or the minimal
 * call's stored answer. A call that was attempted and left no answer is
 * `unknown`; its usage is still in the stage's sums.
 */
function preflightOf(
  steps: StoredStep[],
  rows: AttemptRow[],
): ReportPreflight | null {
  const plan = steps.find((s) => s.name === 'preflight')
  const stored = (plan?.status === 'completed' ? plan.output : null) as {
    checks?: StoredPreflightCheck[]
  } | null
  if (!Array.isArray(stored?.checks)) return null
  const checks = stored.checks.map((c, index): ReportPreflightCheck => {
    const name = `preflight:call:${index}`
    const called = rows.some((r) => r.stepName === name)
    const answer = steps.find(
      (s) => s.name === name && s.status === 'completed',
    )?.output as { verdict?: string; detail?: string } | undefined
    const free = c.free ?? {}
    const verdict = (v: unknown) =>
      v === 'available' || v === 'unavailable' ? v : 'unknown'
    const base = {
      roles: c.roles ?? [],
      provider: c.provider ?? 'unknown',
      model: c.model ?? null,
      effort: c.effort ?? null,
      cliPath: c.cliPath ?? null,
      cliVersion: c.cliVersion ?? null,
      called,
    }
    if (answer || called)
      return {
        ...base,
        verdict: verdict(answer?.verdict),
        method: 'minimal call',
        detail: answer
          ? (answer.detail ?? '')
          : 'the minimal call has no completed answer',
      }
    return {
      ...base,
      verdict: verdict(free.verdict),
      method: free.method ?? 'unknown',
      detail:
        free.verdict === 'unknown'
          ? `${free.detail ?? ''}; not called, the run stopped first`
          : (free.detail ?? ''),
    }
  })
  return {
    checks,
    usage: usageOf(rows.filter((r) => r.stepName.startsWith('preflight:'))),
  }
}

/**
 * Each input file's path, with the SHA-256 of the content the run stored and
 * used. The hash is computed here, so it always describes that content.
 */
function inputHashes(input: PersistedInput | null): ReportInputs {
  const target = input?.target
  const hashed = (path: string | undefined, content: unknown) =>
    path && typeof content === 'string'
      ? { path, sha256: createHash('sha256').update(content).digest('hex') }
      : null
  const entry = (name: 'task' | 'spec' | 'dispositions') =>
    hashed(target?.inputFiles?.[name]?.path, target?.[name])
  return {
    task: entry('task'),
    spec: entry('spec'),
    dispositions: entry('dispositions'),
    findings: hashed(
      input?.repairOf?.findingsFile?.path,
      input?.repairOf?.findings,
    ),
  }
}

/** The run a repair run repairs, from its stored input. */
function repairParent(input: PersistedInput | null): ReportLineage['parent'] {
  const origin = input?.repairOf
  return origin?.runId && origin.candidateCommit
    ? { runId: origin.runId, candidateCommit: origin.candidateCommit }
    : null
}

/**
 * The repair runs started from a run, oldest first. Read from the other
 * runs' inputs every time, because a finished run gains children after it
 * finished.
 */
export async function repairChildren(
  durably: Pick<ReportSource, 'getRuns'>,
  run: { id: string; jobName: string },
): Promise<string[]> {
  const runs = await durably.getRuns({ jobName: run.jobName })
  return runs
    .filter(
      (r) => (r.input as PersistedInput | null)?.repairOf?.runId === run.id,
    )
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))
    .map((r) => r.id)
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
        squashedBranch: recorded.squashedBranch ?? null,
        squashedCommit: recorded.squashedCommit ?? null,
      }
    : null
  const steps = await durably.storage.getSteps(runId)
  const candidates = sealedCandidates(steps)
  const candidate = lastCandidate(output, candidates)
  const preflight = preflightOf(steps, rows)
  // Minimal preflight calls get a role row of their own, never folded into
  // the roles whose settings they checked.
  const preflightProviders = [
    ...new Set(
      (preflight?.checks ?? []).filter((c) => c.called).map((c) => c.provider),
    ),
  ]
  const profiles = profileRows(
    input,
    rows.some((r) => r.measurement?.role === 'repair'),
  )
  if (preflightProviders.length > 0)
    profiles.push({
      role: 'preflight',
      provider:
        preflightProviders.length === 1
          ? (preflightProviders[0] ?? null)
          : null,
      requestedModel: null,
      requestedEffort: null,
    })
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
      repairRun: repairParent(input) !== null,
    }),
    triage: await recordedTriage(durably, run),
    baseline: baselineOf(steps, rows),
    preflight,
    stageUsage: usage,
    roleUsage: roleUsage(rows, profiles),
    inputs: inputHashes(input),
    lineage: {
      parent: repairParent(input),
      children: await repairChildren(durably, run),
    },
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
