/** Assemble a LoopReport from persisted Durably data for one run. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

import type { AnyDurably, Run } from '@coji/durably'

import { REPAIR_OF_LABEL, triageThatRuns } from '../factory/repair.js'
import {
  BASELINE_STEP,
  REPAIR_SESSION_STEP,
  REVIEW_CANCEL_REASON,
  REVIEW_DISCARD_REASON,
  REVIEW_PENDING_REASON,
  SPEC_CHECK_STEP,
  REVIEW_LENSES,
  SPEC_FINAL_STEP,
  type RepairSessionRecord,
  type ReviewLens,
} from '../factory/types.js'
import { classifyRun, stageStep } from './failure-reasons.js'
import { PRICE_BASIS } from './pricing.js'
import {
  boundedDenials,
  type PermissionDenials,
  type VerificationLog,
} from './providers/types.js'
import {
  cacheReadRatio,
  reviewHighlights,
  roleUsage,
  specWallMs,
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
  type ReportFinding,
  type ReportFindings,
  type ReportInputs,
  type ReportLineage,
  type ReportPreflight,
  type ReportPreflightCheck,
  type ReportRepairCall,
  type ReportRepairSession,
  type ReportReview,
  type ReportReviewFindings,
  type ReportReviewRound,
  type ReportSealedCandidate,
  type ReportSpec,
  type ReportTriage,
  type ReviewStatus,
  type RoleProfileRow,
  type TriageCalibration,
  type UsageTotals,
} from './report.js'
import {
  worktreeStateOf,
  type DiagnosisKind,
  type TaskRunInput,
} from './status.js'

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
    checkFromSpec?: string[] | null
    dispositions?: string | null
    inputFiles?: Record<string, { path?: string } | null>
  }
  repairOf?: {
    runId?: string
    candidateCommit?: string
    findings?: string
    findingsFile?: { path?: string; parentRun?: string }
  }
  spec?: {
    author?: PersistedProfile
    fix?: PersistedProfile | null
    reviewers?: { name?: string; profile?: PersistedProfile }[]
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
  // run never runs the triage profile it records, so it has no row.
  const triage = triageThatRuns(input, input?.profiles?.['triage'])
  // The spec roles, each a row of its own: the fix on the author's settings
  // unless it has its own, and every named reviewer.
  const spec = input?.spec
  const specRows = spec?.author
    ? [
        row('spec-author', spec.author),
        row('spec-fix', spec.fix ?? spec.author),
        ...(spec.reviewers ?? []).flatMap((r) =>
          r.name && r.profile ? [row(`spec-review:${r.name}`, r.profile)] : [],
        ),
      ]
    : []
  return [...rows, ...(triage ? [row('triage', triage)] : []), ...specRows]
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

function asFinding(value: unknown): ReportFinding | null {
  const f = value as Partial<ReportFinding> | null
  if (
    (f?.severity !== 'blocker' && f?.severity !== 'non-blocker') ||
    typeof f.title !== 'string' ||
    typeof f.body !== 'string'
  )
    return null
  return {
    severity: f.severity,
    title: f.title,
    body: f.body,
    ...(typeof f.file === 'string' ? { file: f.file } : {}),
    ...(typeof f.line === 'number' ? { line: f.line } : {}),
  }
}

/** Stored findings; null when none were kept or they are not readable. */
function asFindings(value: unknown): ReportReviewFindings | null {
  const v = value as {
    blocker?: unknown
    nonBlocker?: unknown
    counts?: { blocker?: unknown; nonBlocker?: unknown } | null
  } | null
  if (
    !Array.isArray(v?.blocker) ||
    !Array.isArray(v.nonBlocker) ||
    typeof v.counts?.blocker !== 'number' ||
    typeof v.counts.nonBlocker !== 'number'
  )
    return null
  const blocker = v.blocker.map(asFinding)
  const nonBlocker = v.nonBlocker.map(asFinding)
  if (blocker.includes(null) || nonBlocker.includes(null)) return null
  return {
    blocker: blocker as ReportFinding[],
    nonBlocker: nonBlocker as ReportFinding[],
    counts: { blocker: v.counts.blocker, nonBlocker: v.counts.nonBlocker },
  }
}

/**
 * A stored verdict, with the findings its review step kept; null when it is
 * not one. A verdict recorded before findings were kept has none.
 */
/** A spec review step's output as a review, its reviewer as the lens. */
export function asSpecReview(output: unknown): ReportReview | null {
  const o = output as { name?: unknown } | null
  return asReportReview(
    o && typeof o.name === 'string' ? { ...o, lens: o.name } : null,
  )
}

export function asReportReview(value: unknown): ReportReview | null {
  const r = value as (Partial<ReportReview> & { findings?: unknown }) | null
  // A review a failed check ended before its verdict (ADR-0029).
  if (typeof r?.lens === 'string' && r.status === 'cancelled')
    return {
      lens: r.lens,
      decision: '',
      notes: '',
      findings: null,
      status: 'cancelled',
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    }
  if (
    typeof r?.lens !== 'string' ||
    typeof r.decision !== 'string' ||
    typeof r.notes !== 'string'
  )
    return null
  const denials = asDenials(r.permissionDenials)
  return {
    lens: r.lens,
    decision: r.decision,
    notes: r.notes,
    findings: asFindings(r.findings),
    ...(denials ? { permissionDenials: denials } : {}),
  }
}

/**
 * A review step's refused tool calls, held to the stored bound; null when
 * none are stored.
 */
function asDenials(value: unknown): PermissionDenials | null {
  const v = value as { count?: unknown; entries?: unknown } | null | undefined
  if (typeof v?.count !== 'number' || !Array.isArray(v.entries)) return null
  const bounded = boundedDenials(
    v.entries.filter((e): e is string => typeof e === 'string'),
  )
  return bounded ? { count: v.count, entries: bounded.entries } : null
}

function asReviews(value: unknown): ReportReview[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((v) => {
    const review = asReportReview(v)
    return review ? [review] : []
  })
}

/**
 * The last review round. A run with an output carries it there; a run
 * waiting for approval has it only in the approval wait's metadata, so the
 * latest wait that recorded reviews is used.
 */
function recordedReviews(
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

/**
 * The last review round's verdicts. Neither place they are recorded keeps
 * the findings, so each verdict takes them from its review step: from the
 * latest round whose verdicts are these.
 */
function lastReviews(
  output: unknown,
  waits: { metadata: unknown }[],
  rounds: ReportReviewRound[],
): ReportReview[] {
  const reviews = recordedReviews(output, waits)
  const same = (x: ReportReview, y: ReportReview) =>
    x.lens === y.lens && x.decision === y.decision && x.notes === y.notes
  const round = [...rounds]
    .reverse()
    .find((r) =>
      reviews.every((review) => r.reviews.some((kept) => same(kept, review))),
    )
  return reviews.map((review) => {
    const kept = round?.reviews.find((k) => same(k, review))
    return {
      ...review,
      findings: kept?.findings ?? review.findings,
      ...(kept?.permissionDenials
        ? { permissionDenials: kept.permissionDenials }
        : {}),
    }
  })
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
 *
 * With `parallelReview` (ADR-0029), a round shares its sequence with the
 * check of the same candidate, and counts only once that check completed
 * and passed. A failed check makes it `cancelled` or `discarded`; with no
 * completed check yet, still running or ended by an error, it is
 * `pending`. A sequential round always follows a passed check.
 */
function reviewRoundsOf(
  steps: StoredStep[],
  candidates: ReportSealedCandidate[],
  parallelReview: boolean,
): ReportReviewRound[] {
  const rounds = new Map<number, Map<string, ReportReview>>()
  // The completed checks by sequence: whether each passed.
  const checks = new Map<number, boolean>()
  for (const s of steps) {
    const where = stageStep(s.name)
    if (s.status !== 'completed' || !where) continue
    if (where.stage === 'verify' && where.part === 'acceptance') {
      checks.set(
        where.sequence,
        (s.output as { passed?: unknown } | null)?.passed === true,
      )
      continue
    }
    if (where.stage !== 'review') continue
    const [review] = asReviews([s.output]) ?? []
    if (!review || review.lens !== where.part) continue
    const round = rounds.get(where.sequence) ?? new Map()
    round.set(review.lens, review)
    rounds.set(where.sequence, round)
  }
  return [...rounds]
    .sort(([x], [y]) => x - y)
    .map(([sequence, byLens], i) => {
      const reviewed = candidates.filter((c) => c.sequence < sequence).at(-1)
      const passed = parallelReview ? checks.get(sequence) : true
      const held: Exclude<ReviewStatus, 'completed' | 'cancelled'> | null =
        passed === true ? null : passed === false ? 'discarded' : 'pending'
      const heldReason =
        held === 'pending' ? REVIEW_PENDING_REASON : REVIEW_DISCARD_REASON
      const reviews = [...byLens.values()]
        .sort(
          (x, y) =>
            REVIEW_LENSES.indexOf(x.lens as ReviewLens) -
            REVIEW_LENSES.indexOf(y.lens as ReviewLens),
        )
        .map((r): ReportReview =>
          held && r.status !== 'cancelled'
            ? { ...r, status: held, reason: heldReason }
            : r,
        )
      const cancelled = reviews.some((r) => r.status === 'cancelled')
      const status: ReviewStatus =
        held === null
          ? 'completed'
          : held === 'discarded' && cancelled
            ? 'cancelled'
            : held
      return {
        round: i + 1,
        sequence,
        candidate: reviewed ? toReportCandidate(reviewed) : null,
        reviews,
        status,
        reason:
          status === 'completed'
            ? null
            : status === 'cancelled'
              ? REVIEW_CANCEL_REASON
              : heldReason,
      }
    })
}

/**
 * Usage of the review calls in rounds that did not count: those on a
 * candidate that failed verification. Null when there were none.
 */
function discardedReviewsOf(
  rows: AttemptRow[],
  rounds: ReportReviewRound[],
): UsageTotals | null {
  const sequences = new Set(
    rounds
      .filter((r) => r.status === 'cancelled' || r.status === 'discarded')
      .map((r) => r.sequence),
  )
  if (sequences.size === 0) return null
  return usageOf(
    rows.filter((a) => {
      const where = stageStep(a.stepName)
      return where?.stage === 'review' && sequences.has(where.sequence)
    }),
  )
}

/**
 * Every spec review round, from the completed `spec-review:<round>:<name>`
 * steps, one review per reviewer in name order; `lens` is the reviewer's
 * name. An open run's rounds are there as soon as their steps complete.
 */
function specRoundsOf(steps: StoredStep[]): ReportReviewRound[] {
  const rounds = new Map<number, ReportReview[]>()
  for (const s of steps) {
    const [kind, at, name] = s.name.split(':')
    const round = Number(at)
    if (
      kind !== 'spec-review' ||
      !name ||
      !Number.isInteger(round) ||
      s.status !== 'completed'
    )
      continue
    const review = asSpecReview(s.output)
    if (!review) continue
    rounds.set(round, [...(rounds.get(round) ?? []), review])
  }
  return [...rounds]
    .sort(([x], [y]) => x - y)
    .map(([round, reviews]) => ({
      round,
      sequence: round,
      candidate: null,
      reviews: reviews.sort((x, y) => x.lens.localeCompare(y.lens)),
    }))
}

/**
 * The confirmed spec and the check chosen from it; see `ReportSpec`. A run
 * given its spec at trigger (`--spec-file`) has no `spec:final` step, so
 * the spec it went on with is the one in its input. A `--spec-file` run
 * without spec stages and without `checkFromSpec` has no spec section at
 * all: its input spec is a check baseline detail, not a spec this run
 * reasoned about, so it reports `null` as a legacy run would.
 */
function specOf(
  steps: StoredStep[],
  inputSpec: string | null | undefined,
  hasCheckFromSpec: boolean,
): ReportSpec | null {
  const done = (name: string) =>
    steps.find((s) => s.name === name && s.status === 'completed')?.output
  const final = done(SPEC_FINAL_STEP) as {
    content?: unknown
    sha256?: unknown
    round?: unknown
    blocked?: unknown
    advice?: unknown
  } | null
  const check = done(SPEC_CHECK_STEP) as {
    check?: unknown
    notes?: unknown
  } | null
  const started = steps.some(
    (s) => s.name.startsWith('spec:') || s.name.startsWith('spec-review:'),
  )
  const suppliedSpec =
    typeof inputSpec === 'string' && inputSpec.length > 0 ? inputSpec : null
  // A `--spec-file` run reports its input spec whatever state spec-check is
  // in, including when it has not completed (or failed) yet, but only when
  // `checkFromSpec` is configured; otherwise the input spec is not one this
  // run reasoned about, so it reports null like a legacy run.
  if (
    !final &&
    !check &&
    !started &&
    (suppliedSpec === null || !hasCheckFromSpec)
  )
    return null
  const advice = Array.isArray(final?.advice)
    ? final.advice.flatMap((f) => {
        const finding = asFinding(f)
        return finding ? [finding] : []
      })
    : []
  const supplied = !final ? suppliedSpec : null
  return {
    content: typeof final?.content === 'string' ? final.content : supplied,
    sha256:
      typeof final?.sha256 === 'string'
        ? final.sha256
        : supplied !== null
          ? createHash('sha256').update(supplied).digest('hex')
          : null,
    source: supplied !== null ? 'input' : 'stages',
    round: typeof final?.round === 'number' ? final.round : null,
    blocked: final?.blocked === true,
    advice,
    check:
      check && Array.isArray(check.check)
        ? {
            command: check.check.map(String),
            notes: typeof check.notes === 'string' ? check.notes : null,
          }
        : null,
  }
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

/** A reused result's source, when the stored record names one. */
function reusedSource(
  value: unknown,
): { runId: string; checkedAt: string; recovered: boolean } | null {
  const v = value as {
    runId?: unknown
    checkedAt?: unknown
    recovered?: unknown
  } | null
  return v && typeof v.runId === 'string' && typeof v.checkedAt === 'string'
    ? {
        runId: v.runId,
        checkedAt: v.checkedAt,
        recovered: v.recovered === true,
      }
    : null
}

/**
 * Whether a run read its baseline verdict back from its checkpoint: any
 * baseline attempt recovered it. A reused result copies its source's.
 */
export function baselineRecoveredOf(rows: AttemptRow[]): boolean {
  return rows.some(
    (r) =>
      r.stepName === BASELINE_STEP &&
      r.measurement?.result === 'checkpoint-recovered',
  )
}

/**
 * A completed baseline step's output as the report shows it when the result
 * was reused, or null for any other output. It cites the source run's log
 * only while both files are on disk, so it is worked out on every read.
 */
export function reusedBaselineOf(output: unknown): ReportBaseline | null {
  const verdict = output as {
    passed?: unknown
    exitCode?: unknown
    log?: VerificationLog | null
    source?: unknown
    reusedFrom?: unknown
  } | null
  if (!verdict || typeof verdict.passed !== 'boolean') return null
  const from =
    verdict.source === 'reused' ? reusedSource(verdict.reusedFrom) : null
  if (!from) return null
  const log = verdict.log ?? null
  const gone = log
    ? [log.stdoutPath, log.stderrPath].find((path) => !existsSync(path))
    : undefined
  return {
    passed: verdict.passed,
    exitCode: typeof verdict.exitCode === 'number' ? verdict.exitCode : null,
    log: log && !gone ? log : null,
    recovered: from.recovered,
    reusedFrom: { runId: from.runId, checkedAt: from.checkedAt },
    logMissing: !log
      ? `run ${from.runId} recorded no log`
      : gone
        ? `the log of run ${from.runId} is no longer at ${gone}`
        : null,
  }
}

/**
 * The base-commit check: the completed step's verdict and the log it cites,
 * or, while no attempt has finished, the last attempt's log without one. A
 * reused result names the run it came from and cites that run's log while
 * the log is still on disk.
 */
function baselineOf(
  steps: StoredStep[],
  rows: AttemptRow[],
): ReportBaseline | null {
  const attempts = rows.filter((r) => r.stepName === BASELINE_STEP)
  const done = steps.find((s) => s.name === BASELINE_STEP)
  const output = done?.status === 'completed' ? done.output : null
  const reused = reusedBaselineOf(output)
  if (reused) return reused
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
      recovered: baselineRecoveredOf(attempts),
      reusedFrom: null,
      logMissing: null,
    }
  if (attempts.length === 0) return null
  return {
    passed: null,
    exitCode: null,
    log: attempts.at(-1)?.measurement?.verificationLog ?? null,
    recovered: false,
    reusedFrom: null,
    logMissing: null,
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
 * The repair session decision the run recorded after preflight, with the
 * config version it gave the run; null when none was recorded.
 */
function repairSessionOf(
  steps: StoredStep[],
): { report: ReportRepairSession; configVersion: string | null } | null {
  const done = steps.find(
    (s) => s.name === REPAIR_SESSION_STEP && s.status === 'completed',
  )
  const record = (done?.output ?? null) as Partial<RepairSessionRecord> | null
  const confirmed = record?.confirmed
  if (!confirmed) return null
  return {
    report: {
      setup: record.setup
        ? { eligible: record.setup.eligible, reason: record.setup.reason }
        : null,
      confirmed: {
        continues: confirmed.continues,
        model: confirmed.continues ? confirmed.model : null,
        reason: confirmed.reason,
      },
    },
    configVersion: record.configVersion ?? null,
  }
}

/**
 * Every repair call, one row per invocation in the order they were made. A
 * recovery attempt reads the same invocation back, so the last attempt of
 * each is the one shown; its numbers are the call's own, never a sum.
 */
export function repairCallsOf(rows: AttemptRow[]): ReportRepairCall[] {
  const calls = new Map<string, ReportRepairCall>()
  for (const r of rows) {
    const m = r.measurement
    if (m?.role !== 'repair') continue
    const input = m.usage?.inputTokens ?? null
    const cacheRead = m.usage?.cacheReadTokens ?? null
    calls.set(m.invocationId ?? r.attemptId, {
      stepName: r.stepName,
      iteration: m.iteration,
      invocationId: m.invocationId ?? null,
      sessionHandling: m.sessionHandling ?? null,
      sessionReason: m.sessionReason ?? null,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheReadRatio: cacheReadRatio(input, cacheRead),
      recovered: m.recovered === true,
    })
  }
  return [...calls.values()]
}

/** A reference with the SHA-256 of the content, or null without either. */
function hashed<R extends object>(ref: R | null | undefined, content: unknown) {
  return ref && typeof content === 'string'
    ? { ...ref, sha256: createHash('sha256').update(content).digest('hex') }
    : null
}

/**
 * Each input file's path, with the SHA-256 of the content the run stored and
 * used. The hash is computed here, so it always describes that content.
 */
function inputHashes(input: PersistedInput | null): ReportInputs {
  const target = input?.target
  const entry = (name: 'task' | 'spec' | 'dispositions') => {
    const path = target?.inputFiles?.[name]?.path
    return hashed(path ? { path } : null, target?.[name])
  }
  return {
    task: entry('task'),
    spec: entry('spec'),
    dispositions: entry('dispositions'),
    findings: findingsHash(input),
  }
}

/**
 * A repair run's findings: the file they were read from, or the parent run
 * whose stored check failure they were built from (ADR-0030), with the
 * SHA-256 of the content the run stored.
 */
function findingsHash(input: PersistedInput | null): ReportFindings | null {
  const origin = input?.repairOf
  const ref = origin?.findingsFile
  return hashed(
    ref?.path
      ? { path: ref.path }
      : ref?.parentRun
        ? { parentRun: ref.parentRun }
        : null,
    origin?.findings,
  )
}

/** The run a repair run repairs, from its stored input. */
function repairParent(input: PersistedInput | null): ReportLineage['parent'] {
  const origin = input?.repairOf
  return origin?.runId && origin.candidateCommit
    ? { runId: origin.runId, candidateCommit: origin.candidateCommit }
    : null
}

/** Run ids oldest first, the order a report lists children in. */
function oldestFirst(runs: { id: string; createdAt: string }[]): string[] {
  return [...runs]
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))
    .map((r) => r.id)
}

/**
 * The repair runs started from a run, oldest first. Read every time, because
 * a finished run gains children after it finished. This is one label query,
 * but SQLite answers it by walking the job's runs and probing each one's
 * labels, so it grows with the history: use it for a single report. A view
 * that builds a report per run groups the runs it has already read with
 * `repairChildrenByParent` instead.
 */
export async function repairChildren(
  durably: Pick<ReportSource, 'getRuns'>,
  run: { id: string; jobName: string },
): Promise<string[]> {
  // The job name narrows the walk to the job's runs; without it SQLite walks
  // every run in the database.
  return oldestFirst(
    await durably.getRuns({
      jobName: run.jobName,
      labels: { [REPAIR_OF_LABEL]: run.id },
    }),
  )
}

/**
 * The run a repair run repairs: its label, or its stored input when it has
 * none; null for a run that repairs nothing. The task list and `demo status`
 * both group runs by it.
 */
export function repairParentId(run: {
  labels?: Record<string, string> | undefined
  input: unknown
}): string | null {
  return (
    run.labels?.[REPAIR_OF_LABEL] ??
    (run.input as PersistedInput | null)?.repairOf?.runId ??
    null
  )
}

/**
 * A run as `groupTasks` reads it, from its report and its diagnosis: the one
 * mapping `demo status` and the web UI share.
 */
export function taskRunInput(
  run: Pick<Run, 'id' | 'createdAt' | 'labels' | 'input'>,
  kind: DiagnosisKind,
  report: Pick<LoopReport, 'summary' | 'fake'>,
): TaskRunInput {
  return {
    id: run.id,
    createdAt: run.createdAt,
    parentId: repairParentId(run),
    kind,
    approved: report.summary.success,
    leadTimeMs: report.summary.leadTimeMs,
    costUsd: report.summary.costUsd,
    fake: report.fake,
  }
}

/**
 * Every run's repair children, oldest first, from runs already read. A run
 * names its parent by its label, or by its stored input when it has none.
 */
export function repairChildrenByParent(
  runs: {
    id: string
    createdAt: string
    labels?: Record<string, string> | undefined
    input: unknown
  }[],
): Map<string, string[]> {
  const byParent = new Map<string, { id: string; createdAt: string }[]>()
  for (const run of runs) {
    const parent = repairParentId(run)
    if (!parent) continue
    const children = byParent.get(parent) ?? []
    children.push(run)
    byParent.set(parent, children)
  }
  return new Map(
    [...byParent].map(([parent, children]) => [parent, oldestFirst(children)]),
  )
}

/**
 * `children` are the run's repair children when the caller has already
 * worked them out; otherwise they are read with one label query.
 */
export async function buildReport(
  durably: ReportSource,
  runId: string,
  known: { children?: string[] } = {},
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
  const steps = await durably.storage.getSteps(runId)
  const repairSession = repairSessionOf(steps)
  // The version the run took after preflight when it recorded one: its
  // preflight calls carry the version from before the repair session was
  // confirmed.
  const configVersion =
    repairSession?.configVersion ??
    rows
      .map((r) => r.measurement?.configVersion ?? null)
      .find((v): v is string => typeof v === 'string') ??
    null
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
  const setupOutput = steps.find(
    (s) => s.name === 'setup' && s.status === 'completed',
  )?.output as {
    target?: { kind?: string; workdir?: string }
    parallelReview?: unknown
  } | null
  const setupTarget = setupOutput?.target
  const candidates = sealedCandidates(steps)
  const candidate = lastCandidate(output, candidates)
  const reviewRounds = reviewRoundsOf(
    steps,
    candidates,
    setupOutput?.parallelReview === true,
  )
  // The rounds whose verdicts counted; a candidate that failed its check
  // left none of its reviews to the run (ADR-0029).
  const countedRounds = reviewRounds.filter((r) => r.status === 'completed')
  const discardedReviews = discardedReviewsOf(rows, reviewRounds)
  const reviews = lastReviews(run.output, waits, countedRounds)
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
      discardedReviews,
      countedReviewRounds: countedRounds.length,
    }),
    triage: await recordedTriage(durably, run),
    baseline: baselineOf(steps, rows),
    preflight,
    stageUsage: usage,
    roleUsage: roleUsage(rows, profiles),
    inputs: inputHashes(input),
    lineage: {
      parent: repairParent(input),
      children: known.children ?? (await repairChildren(durably, run)),
    },
    candidate,
    candidates,
    repairSession: repairSession?.report ?? null,
    repairCalls: repairCallsOf(rows),
    reviews,
    reviewRounds,
    discardedReviews,
    reviewHighlights: reviewHighlights(countedRounds, reviews, REVIEW_LENSES),
    specRounds: specRoundsOf(steps),
    spec: specOf(
      steps,
      input?.target?.spec,
      Boolean(input?.target?.checkFromSpec),
    ),
    delivery,
    worktree: worktreeStateOf(setupTarget, run.output),
    failure,
    stageVisits: visits,
    realLlmCallCount,
    fullLoopVerified,
    attempts: rows,
    waits: waitRows,
    stageTimings: timings,
    stageTotalMs,
    specWallMs: specWallMs(rows),
    runElapsedMs,
    versions,
    priceBasis: PRICE_BASIS,
    notes,
  }
}
