/**
 * Report regeneration from persisted Durably data (run + attempts + waits).
 *
 * - `realLlmCallCount` (a real CLI was invoked) and `fullLoopVerified`
 *   (real CLI + terminal success + approval) are reported separately — one
 *   usage row never implies a verified loop.
 * - Usage aggregates dedupe by invocation id; recovery attempts add no new
 *   consumption. Confirmed sums and missing legs are shown separately.
 * - Timings: per-stage elapsed, stage total, whole-run elapsed, and human
 *   `inputWaitMs` vs requeue `executionSlotWaitMs` per wait. Unknown end
 *   times render `unknown`, never a fabricated zero; stages with missing
 *   attempts render PARTIAL and poison the stage total to unknown.
 */
import type { StepAttempt } from '@coji/durably'

import { INTERRUPTED_CHECK } from './failure-details.js'
import { retryText, type FailureClassification } from './failure-reasons.js'
import { formatters } from './format.js'
import { PRICE_BASIS } from './pricing.js'
import {
  NOT_SENT,
  type AttemptMeasurement,
  type SessionHandling,
  type VerificationLog,
} from './providers/types.js'
import type { WorktreeState } from './status.js'
import { TERMINAL_STATUSES } from './terminal.js'
import type { CandidateChanges } from './types.js'
import { aggregateUsage } from './usage.js'

/** The Markdown is English; the web UI reads the same values in Japanese. */
const { formatCost, formatCount, formatDuration, formatTokens } =
  formatters('en')

export interface AttemptRow {
  stepName: string
  stepIndex: number
  attemptId: string
  leaseGeneration: number
  status: string
  startedAt: string
  completedAt: string | null
  interruptionReason: string | null
  measurement: AttemptMeasurement | null
}

export interface WaitRow {
  id: string
  name: string
  outcome: string | null
  createdAt: string
  suspendedAt: string | null
  resolvedAt: string | null
  /** Human/external input wait (suspend -> resolve). Null when unknown. */
  inputWaitMs: number | null
  /** Requeue wait (resolve -> first resumed lease). Null when unknown. */
  executionSlotWaitMs: number | null
}

export interface StageTiming {
  stage: string
  /** Sum of measured work in the stage. */
  elapsedMs: number | null
  /**
   * The union of the stage's own attempt intervals: parallel branches count
   * once, and time between two visits or two rounds of the stage, whether
   * spent in other stages or idle, is never counted here.
   */
  wallElapsedMs?: number | null
  /**
   * False when any attempt in the stage lacks elapsedMs: the sum covers only
   * known attempts and must not be presented as a complete stage total.
   */
  complete: boolean
}

/** Token and cost sums over a group of deduped LLM invocations. */
export interface UsageTotals {
  /** LLM invocations that completed (deduped). */
  invocations: number
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  /** Sum of stored per-invocation estimates; null when any is unpriced. */
  costUsd: number | null
  /** False when any usage-expecting invocation lacks usage or a priced leg. */
  complete: boolean
  /**
   * False when `costUsd` is not the whole cost: some invocation had no usage
   * or no price (an unpriced model). Token counts can be complete while this
   * is false.
   */
  costComplete: boolean
}

/** Token and cost consumption of one stage, counted once per invocation. */
export interface StageUsage extends UsageTotals {
  stage: string
}

/**
 * How many times a stage was entered. A second visit is rework: the stage
 * ran again because a later stage sent the candidate back (Mastra Factory's
 * `reworked` outcome, derived here from step names instead of a board).
 */
export interface StageVisits {
  stage: string
  visits: number
  reworked: number
}

/** A role's requested settings, as fixed when the run was triggered. */
export interface RoleProfileRow {
  role: string
  provider: string | null
  requestedModel: string | null
  requestedEffort: string | null
}

/**
 * Token and cost consumption of one role (code, correctness, edge-cases),
 * counted once per invocation. Unlike `StageUsage`, the two reviewers are
 * separate rows, because they may run on different providers or models.
 */
export interface RoleUsage extends RoleProfileRow, UsageTotals {}

/** An input file the run was given, with the SHA-256 of the stored content. */
export interface ReportInputFile {
  path: string
  sha256: string
}

export interface ReportInputs {
  task: ReportInputFile | null
  spec: ReportInputFile | null
  dispositions: ReportInputFile | null
  /** A repair run's outside findings; null on every other run. */
  findings: ReportInputFile | null
}

/**
 * Repair runs linked to this one: the run whose approved candidate it
 * repairs, and the repair runs started from its own candidate.
 */
export interface ReportLineage {
  /** Null unless this run repairs another run's candidate. */
  parent: { runId: string; candidateCommit: string } | null
  /** Repair runs started from this run, oldest first. */
  children: string[]
}

/** A repository candidate's size and where its diff and file list live. */
export type ReportCandidateChanges = CandidateChanges

/** The last sealed candidate: where a repository run left its work. */
export interface ReportCandidate {
  id: string
  branch: string | null
  commit: string | null
  /** Null for a candidate that records no size, such as the bundled sample's. */
  changes?: ReportCandidateChanges | null
}

/** One sealed candidate, in sealing order. */
export interface ReportSealedCandidate extends ReportCandidate {
  /** Which pass through code sealed it, from 1. */
  iteration: number
  /** The stage sequence of the code entry that sealed it. */
  sequence: number
}

/**
 * One reviewer's verdict. A finished run carries the last round in its
 * output; a run waiting for approval has it only in the approval wait.
 */
export interface ReportReview {
  lens: string
  decision: string
  notes: string
  /**
   * The findings a `findings-json` review kept in its step; null for a
   * verdict review and for a review recorded before findings were kept.
   */
  findings: ReportReviewFindings | null
  /**
   * A review run beside verification (ADR-0029): `cancelled` when the
   * check failed first and ended the call, with no verdict (`decision` is
   * empty); `discarded` when it answered and the check then failed, so its
   * verdict was not used. Absent: its verdict counted.
   */
  status?: ReviewStatus
  /** Why it was cancelled or discarded; absent when it counted. */
  reason?: string
}

/** How a review round, or one review in it, ended; see `ReportReview.status`. */
export type ReviewStatus = 'completed' | 'cancelled' | 'discarded'

/** One kept finding of a `findings-json` review. */
export interface ReportFinding {
  severity: 'blocker' | 'non-blocker'
  title: string
  body: string
  file?: string
  line?: number
}

/**
 * The first 20 findings of each severity, each text cut to a fixed length,
 * with each severity's total. A list shorter than its count left the rest
 * out.
 */
export interface ReportReviewFindings {
  blocker: ReportFinding[]
  nonBlocker: ReportFinding[]
  counts: { blocker: number; nonBlocker: number }
}

/**
 * Markdown lines for a review's findings: each severity's total and the
 * titles kept, never a body, file or line.
 */
/** Each review as its verdict line and its findings, at `indent`. */
function reviewLines(reviews: ReportReview[], indent: string): string[] {
  const aside = (r: ReportReview) =>
    r.status && r.status !== 'completed'
      ? ` — ${r.status}${r.reason ? ` (${r.reason})` : ''}`
      : ''
  return reviews.flatMap((review) => [
    review.status === 'cancelled'
      ? `${indent}- ${review.lens}: no verdict${aside(review)}`
      : `${indent}- ${review.lens}: ${review.decision} — ${review.notes}${aside(review)}`,
    ...findingLines(review.findings, `${indent}  `),
  ])
}

function findingLines(
  findings: ReportReviewFindings | null,
  indent: string,
): string[] {
  if (!findings) return []
  const severity = (
    label: string,
    kept: ReportFinding[],
    count: number,
  ): string[] => {
    const rest = count - kept.length
    return [
      `${indent}- ${label}: ${count}`,
      ...kept.map((f) => `${indent}  - ${f.title}`),
      ...(rest > 0 ? [`${indent}  - ${rest} more not kept`] : []),
    ]
  }
  return [
    ...severity('blockers', findings.blocker, findings.counts.blocker),
    ...severity(
      'non-blockers',
      findings.nonBlocker,
      findings.counts.nonBlocker,
    ),
  ]
}

/**
 * One finished review round, from the stored review step outputs. A round
 * the run stopped in part way lists only the verdicts that completed.
 */
export interface ReportReviewRound {
  /** From 1, in the order the rounds ran. */
  round: number
  /** The stage sequence of the review entry. */
  sequence: number
  /** The candidate the round reviewed; null when it is not stored. */
  candidate: ReportCandidate | null
  reviews: ReportReview[]
  /**
   * `completed` when its verdicts counted. A round run beside a check that
   * failed is `cancelled` when that ended a review still running, and
   * `discarded` when every review had answered; neither counts toward the
   * review rounds, the highlights or a repair. Absent on a spec round.
   */
  status?: ReviewStatus
  /** `superseded-by-verify` or `verify-failed`; null when it counted. */
  reason?: string | null
}

/**
 * The review rounds in short: the findings the rounds before the last one
 * raised as blockers; the non-blockers the last round left; and the blockers
 * the last round still raised, when it did not pass. The earlier blockers
 * read as fixed only when the last round passed. Findings are not tracked
 * across rounds, so a title is never matched with another. A verdict review
 * has no findings: its round, lens and decision stand in for them, and no
 * count includes it.
 */
export interface ReviewHighlights {
  /** Review rounds read; 0 before one has finished. */
  rounds: number
  /**
   * How the last round ended: `passed` when every configured reviewer gave
   * a verdict and every one passed; `blocked` when every one gave a verdict
   * and one did not pass; `incomplete` when a reviewer has no verdict,
   * while one still runs or after one failed; null before a round.
   */
  last: 'passed' | 'blocked' | 'incomplete' | null
  /**
   * The last round's verdict reviews that passed. They left nothing, so
   * they belong to no group.
   */
  lastPasses: HighlightVerdict[]
  /** The blockers of the rounds before the last. */
  earlier: HighlightGroup
  left: HighlightGroup
  /** The last round's blockers when it did not pass; empty when it did. */
  open: HighlightGroup
}

/** One side of `ReviewHighlights`: its findings and its verdict reviews. */
export interface HighlightGroup {
  /**
   * Findings in this group across its rounds, whether kept or not. Verdict
   * reviews are listed, not counted.
   */
  count: number
  /** The titles the report kept, in round and review order. */
  titles: string[]
  verdicts: HighlightVerdict[]
}

/** A verdict review's round, lens and decision. */
export interface HighlightVerdict {
  round: number
  lens: string
  decision: string
  /**
   * The first line of its notes. Only the Markdown report prints it; the
   * screen shows no note text and leaves the notes to the evidence.
   */
  line: string
}

function emptyHighlight(): HighlightGroup {
  return { count: 0, titles: [], verdicts: [] }
}

function firstLine(notes: string): string {
  return (
    notes
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  )
}

/**
 * `ReviewHighlights` from the stored rounds, `lenses` being the reviewers
 * every round runs. A run whose rounds were not stored has only its last
 * verdicts, read as its one round.
 */
export function reviewHighlights(
  rounds: ReportReviewRound[],
  last: ReportReview[],
  lenses: readonly string[],
): ReviewHighlights {
  const all: { round: number; reviews: ReportReview[] }[] =
    rounds.length > 0
      ? rounds
      : last.length > 0
        ? [{ round: 1, reviews: last }]
        : []
  const earlier = emptyHighlight()
  const left = emptyHighlight()
  const open = emptyHighlight()
  const lastPasses: HighlightVerdict[] = []
  const final = all.at(-1)
  const ending: ReviewHighlights['last'] = !final
    ? null
    : !lenses.every((lens) => final.reviews.some((r) => r.lens === lens))
      ? 'incomplete'
      : final.reviews.every((r) => r.decision === 'pass')
        ? 'passed'
        : 'blocked'
  const findings = (
    group: HighlightGroup,
    review: ReportReview,
    kind: 'blocker' | 'nonBlocker',
  ) => {
    if (!review.findings) return
    group.count += review.findings.counts[kind]
    group.titles.push(...review.findings[kind].map((f) => f.title))
  }
  const verdict = (to: HighlightVerdict[], round: number, r: ReportReview) =>
    to.push({
      round,
      lens: r.lens,
      decision: r.decision,
      line: firstLine(r.notes),
    })
  for (const round of all.slice(0, -1))
    for (const review of round.reviews) {
      if (review.findings) findings(earlier, review, 'blocker')
      else if (review.decision !== 'pass')
        verdict(earlier.verdicts, round.round, review)
    }
  for (const review of final?.reviews ?? []) {
    if (review.findings) {
      findings(left, review, 'nonBlocker')
      if (ending !== 'passed') findings(open, review, 'blocker')
    } else if (final)
      verdict(
        review.decision === 'pass' ? lastPasses : open.verdicts,
        final.round,
        review,
      )
  }
  return {
    rounds: all.length,
    last: ending,
    lastPasses,
    earlier,
    left,
    open,
  }
}

/** What the run delivered, as recorded in its output. */
export interface ReportDelivery {
  kind: string
  location: string
  summary: string
  branch: string | null
  commit: string | null
  /**
   * Branch with the candidate's tree as one commit on the base; null when
   * none was made, including every delivery recorded before it existed.
   */
  squashedBranch: string | null
  squashedCommit: string | null
}

/**
 * The shadow-triage judgment recorded for a run. `unknown` means triage ran
 * without a usable answer; a report with no triage at all carries null.
 */
export const TRIAGE_JUDGMENTS = ['routine', 'probe', 'unknown'] as const

export interface ReportTriage {
  judgment: (typeof TRIAGE_JUDGMENTS)[number]
  reason: string
  /**
   * What the triage record measured from the stored task and spec, to set
   * against the judgment. Absent on a record from before it was kept; every
   * reader treats that as all unknown.
   */
  calibration?: TriageCalibration
}

/**
 * Sizes of a run's stored task and spec, recorded with its triage judgment.
 * A value is null when it is unknown: the spec's three when there is no spec,
 * a count when the spec has no section for it. Never zero-filled.
 */
export interface TriageCalibration {
  /** Characters (Unicode code points) in the task as stored. */
  taskChars: number | null
  /** Characters (Unicode code points) in the spec as stored. */
  specChars: number | null
  /** Distinct items under the spec's acceptance-criteria headings. */
  acceptanceCriteria: number | null
  /** Distinct file paths under the spec's files-to-change headings. */
  plannedFiles: number | null
}

/** The calibration values, in the order every table shows them. */
export const CALIBRATION_KEYS = [
  'taskChars',
  'specChars',
  'acceptanceCriteria',
  'plannedFiles',
] as const satisfies readonly (keyof TriageCalibration)[]

/** Every calibration value unknown: a record that predates them. */
export const UNKNOWN_CALIBRATION: TriageCalibration = {
  taskChars: null,
  specChars: null,
  acceptanceCriteria: null,
  plannedFiles: null,
}

/** Headings whose section lists acceptance criteria, compared whole. */
const ACCEPTANCE_HEADINGS = [
  'acceptance criteria',
  'completion criteria',
  '受け入れ基準',
  '完了条件',
  '完了基準',
]

/** Headings whose section lists the files the change will touch. */
const PLANNED_FILE_HEADINGS = [
  'files to change',
  'files to modify',
  'changed files',
  '変更するファイル',
  '変更予定のファイル',
  '変更対象のファイル',
]

/**
 * The top-level list items under the spec's headings named in `titles`.
 *
 * The rule, one for both counts:
 * - A heading is an ATX heading (`#` to `######`). Its title is compared
 *   whole and case-insensitively, after trailing `#`s and a trailing colon
 *   are removed.
 * - Its section runs to the next heading of the same or a higher level, so
 *   its subheadings belong to it. Several matching headings are read
 *   together.
 * - An item is a list line (`-`, `*`, `+`, or `1.` / `1)`) that starts at
 *   the beginning of the line, with an optional `[ ]` / `[x]` checkbox.
 *   A checkbox with no text, and a thematic break such as `* * *`, is not
 *   an item. Indented lines, nested items among them, belong to the item above them
 *   and are not counted again.
 * - Fenced code blocks are skipped, headings inside them included.
 *
 * Null when no heading matches: the spec does not say, which is not zero.
 */
function sectionItems(spec: string, titles: string[]): string[] | null {
  let found = false
  let level: number | null = null
  let fence: string | null = null
  const items: string[] = []
  for (const line of spec.split(/\r?\n/)) {
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (
        fenceMark &&
        fenceMark[0] === fence[0] &&
        fenceMark.length >= fence.length
      )
        fence = null
      continue
    }
    if (fenceMark) {
      fence = fenceMark
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const depth = heading[1]?.length ?? 1
      if (level !== null && depth <= level) level = null
      const title = (heading[2] ?? '')
        .replace(/\s+#+\s*$/, '')
        .replace(/[:：]\s*$/, '')
        .trim()
        .toLowerCase()
      if (level === null && titles.includes(title)) {
        level = depth
        found = true
      }
      continue
    }
    if (level === null) continue
    // A thematic break (`---`, `* * *`) looks like a list line but is not.
    if (/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) continue
    const item = /^(?:[-*+]|\d+[.)])\s+(.*\S)/
      .exec(line)?.[1]
      ?.replace(/^\[[ xX]\](?:\s+|$)/, '')
    if (item) items.push(item)
  }
  return found ? items : null
}

/** A file item's path: its first code span, else its first word. */
function plannedPath(item: string): string {
  const code = /`([^`]+)`/.exec(item)?.[1]
  const word = item.split(/\s+/)[0] ?? item
  return (code ?? word).trim().replace(/[:：,、]+$/, '')
}

/**
 * The calibration of one run, from its task and spec as stored. See
 * `sectionItems` for how criteria and files are found and counted.
 */
export function triageCalibration(
  task: string,
  spec: string | null,
): TriageCalibration {
  const taskChars = [...task].length
  if (spec === null) return { ...UNKNOWN_CALIBRATION, taskChars }
  const criteria = sectionItems(spec, ACCEPTANCE_HEADINGS)
  const files = sectionItems(spec, PLANNED_FILE_HEADINGS)
  return {
    taskChars,
    specChars: [...spec].length,
    // Distinct, so the same criterion or file listed twice counts once.
    acceptanceCriteria: criteria
      ? new Set(
          criteria.map((c) => c.replace(/\s+/g, ' ').trim().toLowerCase()),
        ).size
      : null,
    plannedFiles: files ? new Set(files.map(plannedPath)).size : null,
  }
}

/**
 * The pinned check on the base commit, run before any agent call when the
 * repository run asked for it. `passed` is null while no attempt finished.
 */
export interface ReportBaseline {
  passed: boolean | null
  /** Null when the check was killed before it exited (a timeout). */
  exitCode: number | null
  /**
   * Full output of the attempt behind the verdict, or of the last attempt.
   * A reused result points at the run it came from; null when that run's
   * log is gone, with the reason in `logMissing`.
   */
  log: VerificationLog | null
  /**
   * The verdict was read back from its checkpoint on a resume; for a reused
   * result, as the run it came from recorded it.
   */
  recovered: boolean
  /**
   * Set when this run used another run's passing result instead of running
   * the check: that run and when its check completed. Null when the check
   * ran here, or on a record from before results could be reused.
   */
  reusedFrom: { runId: string; checkedAt: string } | null
  /** Why a reused result has no log; null otherwise. */
  logMissing: string | null
}

/** One distinct provider, model and effort, checked once for its roles. */
export interface ReportPreflightCheck {
  roles: string[]
  provider: string
  model: string | null
  effort: string | null
  cliPath: string | null
  cliVersion: string | null
  /** `unknown`: nothing decided it, such as a call left without an answer. */
  verdict: 'available' | 'unavailable' | 'unknown'
  /** The free check's name, or `minimal call` when a call decided it. */
  method: string
  detail: string
  /** A minimal call was made for this check. */
  called: boolean
}

export interface ReportPreflight {
  checks: ReportPreflightCheck[]
  /** Usage of the minimal calls, as the `preflight` stage; null when none. */
  usage: UsageTotals | null
}

/** One repair call: how it treated the session, and how much it read from cache. */
export interface ReportRepairCall {
  stepName: string
  iteration: number | null
  invocationId: string | null
  /** Null for a repair recorded before session handling was. */
  sessionHandling: SessionHandling | null
  /** Why; null for a repair recorded before the reason was. */
  sessionReason: string | null
  inputTokens: number | null
  cacheReadTokens: number | null
  /**
   * `cacheReadTokens / inputTokens` of this call alone; null when either is
   * missing or the input is 0.
   */
  cacheReadRatio: number | null
  recovered: boolean
}

/**
 * Whether a repair on its own profile continues the implementation session:
 * setup's answer from the settings and environment, and the decision
 * preflight confirmed, each with its reason.
 */
export interface ReportRepairSession {
  /** Null on a run set up before setup answered. */
  setup: { eligible: boolean; reason: string } | null
  confirmed: { continues: boolean; model: string | null; reason: string }
}

/** A call's cache-read share of its input; null when it cannot be computed. */
export function cacheReadRatio(
  inputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
): number | null {
  if (inputTokens == null || cacheReadTokens == null || inputTokens === 0)
    return null
  return cacheReadTokens / inputTokens
}

/** One row per run, the unit that cross-run comparisons operate on. */
export interface RunSummary {
  /** Terminal completed run whose candidate was approved. */
  success: boolean
  conclusion: string | null
  /** Trigger to terminal state; null while the run is still open. */
  leadTimeMs: number | null
  /** Sum of measured stage work; null when any stage is partial. */
  workMs: number | null
  /** Human/external input wait across all waits; null when unknown. */
  humanWaitMs: number | null
  /** humanWaitMs / leadTimeMs; null when either is unknown. */
  humanWaitRatio: number | null
  llmInvocations: number
  totalTokens: number | null
  costUsd: number | null
  /** costUsd when the run succeeded, else null: what one success cost. */
  costPerSuccessUsd: number | null
  /**
   * Times the code stage ran as a repair: after the first implementation,
   * or every time on a repair run, whose first code stage is a repair.
   */
  repairs: number
  reviewRounds: number
  /**
   * Review calls on candidates that failed verification, cancelled or
   * discarded (ADR-0029), and what they cost. The cost is part of
   * `costUsd`; null when any such call had no usage or price. Zero calls
   * and zero cost on a run that had none. Absent on a summary made before
   * it existed.
   */
  discardedReviewCalls?: number
  discardedReviewCostUsd?: number | null
}

/**
 * The spec the run went on with: the one its spec stages confirmed, and the
 * check `checkFromSpec` chose from it. Null on a run without either, or
 * before either is recorded.
 */
export interface ReportSpec {
  /**
   * The spec the run goes on with: the one the spec stages confirmed, or
   * the one given at trigger (`--spec-file`); null while the spec stages
   * have not confirmed one.
   */
  content: string | null
  sha256: string | null
  /** Where `content` came from: the spec stages, or the run's input. */
  source: 'stages' | 'input'
  /** The review round that confirmed it; null before. */
  round: number | null
  /** A person approved it through the spec-blocked wait. */
  blocked: boolean
  /** The advice handed to the implementer as untrusted data. */
  advice: ReportFinding[]
  /** The check `checkFromSpec` chose and its notes; null without one. */
  check: { command: string[]; notes: string | null } | null
}

export interface LoopReport {
  runId: string
  jobName: string
  status: string
  input: unknown
  output: unknown
  fake: boolean
  /** Shared by runs with identical provider/model/effort/context settings. */
  configVersion: string | null
  summary: RunSummary
  triage: ReportTriage | null
  /** Null when the run had no baseline check or has not reached it. */
  baseline: ReportBaseline | null
  /** Null for a run from before preflight, or one that has not reached it. */
  preflight: ReportPreflight | null
  stageUsage: StageUsage[]
  /**
   * Per-role requested settings and usage: code, repair, correctness,
   * edge-cases, and triage when the run has a triage profile.
   */
  roleUsage: RoleUsage[]
  /** SHA-256 of each input file's content, as stored in the run. */
  inputs: ReportInputs
  lineage: ReportLineage
  /** Last sealed candidate, whatever the conclusion; null before one exists. */
  candidate: ReportCandidate | null
  /** Every sealed candidate with its size, oldest first. */
  candidates: ReportSealedCandidate[]
  /**
   * Whether a repair on its own profile continues the implementation
   * session, and why; null when repair runs on `code` or the run has not
   * passed preflight.
   */
  repairSession: ReportRepairSession | null
  /** Every repair call, oldest first, one row per invocation. */
  repairCalls: ReportRepairCall[]
  /** Last review round; empty before a review round has finished. */
  reviews: ReportReview[]
  /** Every review round with both verdicts and notes, oldest first. */
  reviewRounds: ReportReviewRound[]
  /**
   * Usage of the review calls on candidates that failed verification: the
   * rounds `cancelled` or `discarded`. Null or absent when the run had none.
   */
  discardedReviews?: UsageTotals | null
  /** The review rounds in short, for the page's summary. */
  reviewHighlights: ReviewHighlights
  /**
   * Every spec review round, oldest first, one review per named reviewer
   * (`lens` is the reviewer's name); read from completed steps, so an open
   * run has them too. Empty on a run without spec stages.
   */
  specRounds: ReportReviewRound[]
  /** See `ReportSpec`. */
  spec: ReportSpec | null
  /** Branch, commit and location of the delivery; null when none was made. */
  delivery: ReportDelivery | null
  /**
   * A repository run's worktree as it is now: removed after an approved
   * delivery, an archive or `demo prune --apply`, and then not a place to
   * work. Null for any other run.
   */
  worktree: WorktreeState | null
  /** Why the run stopped and what to do next; null when it did not stop. */
  failure: FailureClassification | null
  stageVisits: StageVisits[]
  /** Real (non-fake) CLI invocations observed in attempts. */
  realLlmCallCount: number
  /**
   * True only when: non-fake run + terminal completed status + approved
   * conclusion with passing tests. A failed or incomplete run is never
   * presented as verified, no matter how many usage rows exist.
   */
  fullLoopVerified: boolean
  attempts: AttemptRow[]
  waits: WaitRow[]
  stageTimings: StageTiming[]
  stageTotalMs: number | null
  /**
   * Wall-clock time of the spec stages together (spec, spec-review and
   * spec-check), each span counted once where they overlap; see
   * `specWallMs`. Null on a run without spec stages or with an attempt in
   * them that lacks a start or an end.
   */
  specWallMs: number | null
  runElapsedMs: number | null
  versions: Record<string, string | null>
  priceBasis: typeof PRICE_BASIS
  notes: string[]
}

export function toAttemptRow(a: StepAttempt): AttemptRow {
  let measurement: AttemptMeasurement | null = null
  try {
    const m = a.metadata as unknown
    // Key on fields only a measurement has. Several steps put a `provider`
    // in their metadata for context — `setup` among them — and treating one
    // of those as a measurement renders a phantom row of `unknown`s beside
    // the real invocations.
    if (
      m &&
      typeof m === 'object' &&
      'invocationId' in (m as object) &&
      'usageScope' in (m as object)
    ) {
      measurement = m as AttemptMeasurement
    }
  } catch {
    measurement = null
  }
  return {
    stepName: a.stepName,
    stepIndex: a.stepIndex,
    attemptId: a.id,
    leaseGeneration: a.leaseGeneration,
    status: a.status,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    interruptionReason: a.interruptionReason,
    measurement,
  }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'unknown'
  if (typeof v === 'number') return String(v)
  return String(v)
}

function fmtChanges(c: ReportCandidateChanges | null | undefined): string {
  return c
    ? `${c.files} files, +${c.additions} / -${c.deletions} lines`
    : 'not recorded'
}

/** The spec stages as `stageOf` names them. */
export const SPEC_STAGES: readonly string[] = [
  'spec',
  'spec-review',
  'spec-check',
]

const STAGE_ORDER = [
  'setup',
  'baseline',
  'preflight',
  'spec',
  'spec-review',
  'spec-check',
  'triage',
  'policy',
  'code',
  'verify',
  'review',
  'approve',
  'finish',
  'stop',
]

export function stageOf(stepName: string): string {
  const parts = stepName.split(':')
  if (parts[0] === 'stage' && parts[2]) return parts[2]
  if (parts[0] === 'decision') return 'policy'
  const base = stepName.split(':')[0] ?? stepName
  return base
}

function sortStages<T extends { stage: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (x, y) => STAGE_ORDER.indexOf(x.stage) - STAGE_ORDER.indexOf(y.stage),
  )
}

/**
 * Keep one row per invocation, preferring the attempt that completed it.
 * Recovery attempts re-read the same invocation and must not add tokens.
 */
function dedupeByInvocation(attempts: AttemptRow[]): AttemptRow[] {
  const selected = new Map<string, AttemptRow>()
  // A call superseded before it was sent is no invocation (ADR-0029).
  attempts = attempts.filter((a) => a.measurement?.result !== NOT_SENT)
  const completed = (a: AttemptRow | undefined) =>
    a?.measurement?.result === 'checkpoint-recovered' ||
    (a?.measurement?.result?.endsWith('-done') ?? false)
  for (const attempt of attempts) {
    const key = attempt.measurement?.invocationId ?? attempt.attemptId
    const previous = selected.get(key)
    if (!previous || (completed(attempt) && !completed(previous)))
      selected.set(key, attempt)
  }
  return [...selected.values()]
}

/** Sum one group of already-deduped LLM invocations. */
function usageTotals(list: AttemptRow[]): UsageTotals {
  const agg = aggregateUsage(
    list.map((a) => ({
      attemptId: a.measurement?.invocationId ?? a.attemptId,
      usage: a.measurement?.usage ?? null,
      expectsUsage: true,
    })),
  )
  const costs = list.map((a) => a.measurement?.costUsdEstimate ?? null)
  const costUsd =
    agg.complete && costs.every((c) => c !== null)
      ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
      : null
  return {
    invocations: list.length,
    inputTokens: agg.inputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    outputTokens: agg.outputTokens,
    totalTokens: agg.totalTokens,
    costUsd,
    complete: agg.complete,
    costComplete: costUsd !== null,
  }
}

/**
 * Token and cost sums over any group of attempts, with the same dedupe and
 * scope rules as `stageUsage`; null when none of them invokes an LLM. The
 * web UI's trace rows use it, so a row never sums usage another way.
 */
export function usageOf(attempts: AttemptRow[]): UsageTotals | null {
  const list = dedupeByInvocation(attempts).filter((a) =>
    attemptExpectsUsage(a.stepName),
  )
  return list.length === 0 ? null : usageTotals(list)
}

/** Per-stage token and cost sums, one count per invocation. */
export function stageUsage(attempts: AttemptRow[]): StageUsage[] {
  const byStage = new Map<string, AttemptRow[]>()
  for (const a of dedupeByInvocation(attempts)) {
    if (!attemptExpectsUsage(a.stepName)) continue
    const stage = stageOf(a.stepName)
    byStage.set(stage, [...(byStage.get(stage) ?? []), a])
  }
  const rows: StageUsage[] = []
  for (const [stage, list] of byStage)
    rows.push({ stage, ...usageTotals(list) })
  return sortStages(rows)
}

/**
 * The usage role of one attempt: its step's role, except that a code step's
 * repair call is `repair`, so repair never counts toward `code`.
 */
function usageRoleOf(attempt: AttemptRow): string | null {
  const role = roleOf(attempt.stepName)
  return role === 'code' && attempt.measurement?.role === 'repair'
    ? 'repair'
    : role
}

/** The role an LLM step ran as, from its step name. */
function roleOf(stepName: string): string | null {
  if (stepName === 'triage') return 'triage'
  // The spec stages: `spec:author`, `spec:fix:<round>` and
  // `spec-review:<round>:<name>`, each reviewer a role of its own.
  if (stepName === 'spec:author') return 'spec-author'
  if (stepName.startsWith('spec:fix:')) return 'spec-fix'
  if (stepName.startsWith('spec-review:'))
    return `spec-review:${stepName.split(':').slice(2).join(':')}`
  // The free preflight check is not a call; each minimal call is.
  if (stepName.startsWith('preflight:call:')) return 'preflight'
  if (stepName.endsWith(':agent')) return 'code'
  if (stepName.endsWith(':correctness')) return 'correctness'
  if (stepName.endsWith(':edge-cases')) return 'edge-cases'
  return null
}

/**
 * Per-role token and cost sums, one count per invocation. Every profile gets
 * a row even when the role never ran, so a report always shows what each
 * role was configured to use.
 */
export function roleUsage(
  attempts: AttemptRow[],
  profiles: RoleProfileRow[],
): RoleUsage[] {
  const byRole = new Map<string, AttemptRow[]>()
  for (const a of dedupeByInvocation(attempts)) {
    const role = usageRoleOf(a)
    if (role === null) continue
    byRole.set(role, [...(byRole.get(role) ?? []), a])
  }
  return profiles.map((profile) => ({
    ...profile,
    ...usageTotals(byRole.get(profile.role) ?? []),
  }))
}

/**
 * Count distinct entries into each stage from `stage:<sequence>:<stage>`
 * step names. Setup and policy steps carry no sequence and are skipped.
 */
export function stageVisits(attempts: AttemptRow[]): StageVisits[] {
  const sequences = new Map<string, Set<string>>()
  for (const a of attempts) {
    const parts = a.stepName.split(':')
    if (parts[0] !== 'stage' || !parts[1] || !parts[2]) continue
    const set = sequences.get(parts[2]) ?? new Set<string>()
    set.add(parts[1])
    sequences.set(parts[2], set)
  }
  return sortStages(
    [...sequences].map(([stage, set]) => ({
      stage,
      visits: set.size,
      reworked: Math.max(0, set.size - 1),
    })),
  )
}

export interface SummaryInput {
  status: string
  output: unknown
  runElapsedMs: number | null
  stageTotalMs: number | null
  waits: WaitRow[]
  attempts: AttemptRow[]
  stageUsage: StageUsage[]
  stageVisits: StageVisits[]
  /** A repair run: its first code stage is a repair too. */
  repairRun?: boolean
  /** See `LoopReport.discardedReviews`. */
  discardedReviews?: UsageTotals | null
}

function repairsOf(visits: StageVisits[], repairRun: boolean): number {
  const code = visits.find((v) => v.stage === 'code')
  return (repairRun ? code?.visits : code?.reworked) ?? 0
}

/**
 * A terminal completed run whose candidate was approved: `summary.success`,
 * which `demo status` and the list read from the run's report.
 */
function isApprovedRun(status: string, output: unknown): boolean {
  const o = output as { approved?: boolean; conclusion?: string } | null
  return (
    status === 'completed' &&
    o?.approved === true &&
    o.conclusion === 'approved'
  )
}

/** Fold a run into the one-row summary used for cross-run comparison. */
export function summarizeRun(input: SummaryInput): RunSummary {
  const output = input.output as {
    conclusion?: string
    reviewRounds?: number
  } | null
  const success = isApprovedRun(input.status, input.output)
  const usageRows = input.stageUsage
  const allComplete = usageRows.every((r) => r.complete)
  const sumLeg = (pick: (r: StageUsage) => number | null): number | null => {
    const known = usageRows.map(pick).filter((v): v is number => v !== null)
    return known.length === usageRows.length && usageRows.length > 0
      ? known.reduce((s, v) => s + v, 0)
      : null
  }
  const costUsd = allComplete ? sumLeg((r) => r.costUsd) : null
  const humanWaits = input.waits.map((w) => w.inputWaitMs)
  const humanWaitMs =
    humanWaits.length > 0 && humanWaits.every((v) => v !== null)
      ? humanWaits.reduce<number>((s, v) => s + (v ?? 0), 0)
      : humanWaits.length === 0
        ? 0
        : null
  const leadTimeMs = input.runElapsedMs
  return {
    success,
    conclusion: output?.conclusion ?? null,
    leadTimeMs,
    workMs: input.stageTotalMs,
    humanWaitMs,
    humanWaitRatio:
      humanWaitMs !== null && leadTimeMs !== null && leadTimeMs > 0
        ? humanWaitMs / leadTimeMs
        : null,
    llmInvocations: usageRows.reduce((s, r) => s + r.invocations, 0),
    totalTokens: sumLeg((r) => r.totalTokens),
    costUsd,
    costPerSuccessUsd: success ? costUsd : null,
    repairs: repairsOf(input.stageVisits, input.repairRun ?? false),
    reviewRounds:
      typeof output?.reviewRounds === 'number'
        ? output.reviewRounds
        : (input.stageVisits.find((v) => v.stage === 'review')?.visits ?? 0),
    discardedReviewCalls: input.discardedReviews?.invocations ?? 0,
    discardedReviewCostUsd: input.discardedReviews
      ? input.discardedReviews.costUsd
      : 0,
  }
}

/** One attempt's stage, interval and measured work, once per invocation. */
interface TimedAttempt {
  stage: string
  start: number
  end: number
  ms: number | null
}

function timedAttempts(attempts: AttemptRow[]): TimedAttempt[] {
  const seen = new Set<string>()
  const out: TimedAttempt[] = []
  for (const a of dedupeByInvocation(attempts)) {
    if (seen.has(a.attemptId)) continue
    seen.add(a.attemptId)
    const stage = stageOf(a.measurement?.stage ?? a.stepName)
    const start = Date.parse(a.measurement?.invocationStartedAt ?? a.startedAt)
    const end = Date.parse(
      a.measurement?.invocationCompletedAt ?? a.completedAt ?? '',
    )
    const ms =
      a.measurement?.elapsedMs ??
      (Number.isFinite(start) && Number.isFinite(end)
        ? Math.max(0, end - start)
        : null)
    out.push({ stage, start, end, ms })
  }
  return out
}

/**
 * The length of the union of the intervals: overlapping ones count once and
 * a gap between two counts not at all.
 */
function unionMs(intervals: { start: number; end: number }[]): number {
  let total = 0
  let reached = -Infinity
  for (const t of [...intervals].sort((x, y) => x.start - y.start)) {
    if (t.end <= reached) continue
    total += t.end - Math.max(t.start, reached)
    reached = t.end
  }
  return total
}

/**
 * Sum once per invocation while retaining its original execution interval.
 * A stage's wall time is the union of its own attempts' intervals: parallel
 * branches count once, and neither the stages that ran between two visits
 * nor the gaps between two rounds count at all. An attempt without a start
 * or end is left out of the wall time; a stage with no complete interval
 * has none.
 */
export function stageTimings(attempts: AttemptRow[]): StageTiming[] {
  const timed = timedAttempts(attempts)
  const byStage = new Map<string, number>()
  const incomplete = new Set<string>()
  const intervals = new Map<string, TimedAttempt[]>()
  for (const t of timed) {
    if (t.ms === null) incomplete.add(t.stage)
    else byStage.set(t.stage, (byStage.get(t.stage) ?? 0) + t.ms)
    if (Number.isFinite(t.start) && Number.isFinite(t.end))
      intervals.set(t.stage, [...(intervals.get(t.stage) ?? []), t])
  }
  const stages = [...new Set([...byStage.keys(), ...incomplete])]
  return sortStages(
    stages.map((stage) => {
      const own = intervals.get(stage)
      return {
        stage,
        elapsedMs: byStage.get(stage) ?? null,
        wallElapsedMs: own ? unionMs(own) : null,
        complete: !incomplete.has(stage),
      }
    }),
  )
}

/**
 * The spec stages' wall-clock time together: the union of their attempts'
 * intervals, so parallel spec reviews count once and a gap between two
 * attempts, such as a person deciding on a blocked spec, counts not at all.
 * Null without a spec stage, or when an attempt in one lacks a start or end.
 */
export function specWallMs(attempts: AttemptRow[]): number | null {
  const timed = timedAttempts(attempts).filter((t) =>
    SPEC_STAGES.includes(t.stage),
  )
  if (timed.length === 0) return null
  if (timed.some((t) => !Number.isFinite(t.start) || !Number.isFinite(t.end)))
    return null
  return unionMs(timed)
}

/** Stage total across stages; unknown when any stage timing is partial. */
export function totalStageMs(timings: StageTiming[]): number | null {
  if (timings.some((t) => !t.complete)) return null
  return timings.reduce((sum, t) => sum + (t.elapsedMs ?? 0), 0)
}

/**
 * Provisional elapsed times of an open run, as of `now`. Never part of the
 * report: `runElapsedMs` and `stageTimings` stay the settled values, and
 * anything shown from here has to say it is still running.
 */
export interface LiveElapsed {
  /** From the first lease (or creation, before one) to `now`. */
  runMs: number
  /** Stage of the latest attempt not yet completed; null between steps. */
  stage: string | null
  stepName: string | null
  /** From that attempt's start to `now`. */
  stageMs: number | null
}

/**
 * Provisional elapsed times for an open run; null for a finished one. Only
 * attempts of the current lease generation count, so an attempt a lost
 * worker left open is not taken for the step running now.
 */
export function liveElapsed(
  run: {
    status: string
    createdAt: string
    startedAt: string | null
    leaseGeneration: number
  },
  attempts: Pick<
    AttemptRow,
    'stepName' | 'startedAt' | 'completedAt' | 'status' | 'leaseGeneration'
  >[],
  now: number,
): LiveElapsed | null {
  if (TERMINAL_STATUSES.includes(run.status)) return null
  const since = (iso: string) => Math.max(0, now - Date.parse(iso))
  const open = attempts
    .filter(
      (a) =>
        a.status === 'started' &&
        a.completedAt === null &&
        a.leaseGeneration === run.leaseGeneration,
    )
    .sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt))[0]
  return {
    runMs: since(run.startedAt ?? run.createdAt),
    stage: open ? stageOf(open.stepName) : null,
    stepName: open?.stepName ?? null,
    stageMs: open ? since(open.startedAt) : null,
  }
}

/**
 * Only triage, preflight calls and implement/review branches invoke an LLM:
 * every other step (local grading, prepare, policy, snapshots) is out of
 * usage scope, so its null usage never marks the aggregate incomplete.
 */
export function attemptExpectsUsage(stepName: string): boolean {
  return roleOf(stepName) !== null
}

/** Sum the already-priced invocations without applying one model to another. */
function aggregateInvocationCost(
  attempts: AttemptRow[],
  usageComplete: boolean,
): number | null {
  if (!usageComplete) return null
  // Same dedupe rule as `stageUsage`, so the aggregate line and the per-stage
  // costs can never be derived two different ways and disagree.
  const costs = dedupeByInvocation(
    attempts.filter((a) => attemptExpectsUsage(a.stepName)),
  ).map((a) => a.measurement?.costUsdEstimate ?? null)
  if (costs.some((cost) => cost === null)) return null
  return costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
}

function highlightLines(h: ReviewHighlights): string[] {
  if (h.rounds === 0) return ['- none (no review round has finished)']
  const verdict = (v: HighlightVerdict) =>
    `  - round ${v.round} ${v.lens}: ${v.decision} — ${v.line}`
  const group = (label: string, g: HighlightGroup): string[] => [
    `- ${label}: ${g.count} finding(s)`,
    ...g.titles.map((t) => `  - ${t}`),
    ...g.verdicts.map(verdict),
  ]
  const passed = h.last === 'passed'
  const last = passed
    ? 'passed'
    : h.last === 'blocked'
      ? 'did not pass'
      : 'is not complete: a reviewer has no verdict'
  return [
    `- rounds: ${h.rounds}; last round ${last}`,
    ...h.lastPasses.map(verdict),
    ...group(
      passed
        ? 'fixed (blockers of the rounds before the last)'
        : 'earlier (blockers of the rounds before the last)',
      h.earlier,
    ),
    ...group('left (non-blockers of the last round)', h.left),
    ...(passed ? [] : group('open (blockers of the last round)', h.open)),
  ]
}

export function reportToMarkdown(r: LoopReport): string {
  const lines: string[] = []
  lines.push(`# Agent loop report — ${r.runId}`)
  lines.push('')
  lines.push(`- status: ${r.status}`)
  lines.push(
    `- fake mode: ${r.fake ? 'YES (not real-LLM verification)' : 'no'}`,
  )
  lines.push(`- real LLM calls observed: ${r.realLlmCallCount}`)
  lines.push(
    `- full loop verified: ${r.fullLoopVerified ? 'yes (real CLI, terminal success, approved)' : 'no (see notes)'}`,
  )
  lines.push(`- output: ${JSON.stringify(r.output)}`)
  lines.push(`- config version: ${fmt(r.configVersion)}`)
  if (r.repairSession) {
    const { setup, confirmed } = r.repairSession
    lines.push(
      `- repair session: ${confirmed.continues ? `continues across effort on ${confirmed.model ?? 'unknown'}` : 'starts new'} (${confirmed.reason})`,
    )
    if (setup)
      lines.push(
        `- repair session at setup: ${setup.eligible ? 'eligible' : 'not eligible'} (${setup.reason})`,
      )
  }
  lines.push('')
  lines.push('## Triage (shadow mode: recorded, never used to route)')
  lines.push('')
  if (r.triage) {
    const c = r.triage.calibration ?? UNKNOWN_CALIBRATION
    lines.push(`- judgment: ${r.triage.judgment}`)
    lines.push(`- reason: ${r.triage.reason}`)
    lines.push(`- task characters: ${formatCount(c.taskChars)}`)
    lines.push(`- spec characters: ${formatCount(c.specChars)}`)
    lines.push(
      `- acceptance criteria in spec: ${formatCount(c.acceptanceCriteria)}`,
    )
    lines.push(`- planned files in spec: ${formatCount(c.plannedFiles)}`)
  } else if (r.lineage.parent) {
    lines.push('- none (a repair run never runs triage)')
  } else {
    lines.push('- none (no triage profile, or triage has not run yet)')
  }
  lines.push('')
  lines.push('## Baseline check (the pinned check on the base commit)')
  lines.push('')
  if (r.baseline) {
    const b = r.baseline
    lines.push(
      `- result: ${b.passed === null ? 'not finished' : b.passed ? 'pass' : 'fail'}${b.recovered ? ' (recovered from checkpoint)' : ''}`,
    )
    const timedOut = b.log?.timedOutAfterMs
    let exit = String(b.exitCode ?? 'unknown')
    if (b.exitCode === null && b.passed !== null)
      exit += ` (killed before it exited${timedOut === undefined ? '' : `, timed out after ${formatDuration(timedOut)}`})`
    lines.push(`- exit code: ${exit}`)
    if (b.log) {
      if (b.log.interrupted) lines.push(`- attempt: ${INTERRUPTED_CHECK}`)
      lines.push(`- stdout: ${b.log.stdoutPath}`)
      lines.push(`- stderr: ${b.log.stderrPath}`)
      if (b.log.writeError) lines.push(`- log write error: ${b.log.writeError}`)
    } else if (b.logMissing) {
      lines.push(`- log: none (${b.logMissing})`)
    }
    if (b.reusedFrom)
      lines.push(
        `- source: reused from run ${b.reusedFrom.runId}, checked at ${b.reusedFrom.checkedAt}; the check did not run in this run`,
      )
    else if (b.passed !== null) lines.push('- source: measured in this run')
  } else {
    lines.push('- none (baselineCheck is off, or the run has not reached it)')
  }
  lines.push('')
  lines.push('## Preflight (each distinct provider, model and effort)')
  lines.push('')
  if (r.preflight) {
    for (const c of r.preflight.checks) {
      lines.push(
        `- ${c.roles.join(', ')}: ${c.provider} ${fmt(c.model)} effort ${fmt(c.effort)} — ${c.verdict} by ${c.method}${c.called ? ' (paid minimal call)' : ' (free)'}: ${c.detail}`,
      )
      if (c.provider !== 'fake')
        lines.push(`  - cli: ${fmt(c.cliPath)} (${fmt(c.cliVersion)})`)
    }
    const u = r.preflight.usage
    lines.push(
      u
        ? `- minimal calls: ${u.invocations}, tokens ${formatTokens(u.totalTokens)}, cost ${formatCost(u.costUsd)}${u.complete ? '' : ' (PARTIAL)'}`
        : '- minimal calls: 0 (every setting was decided by a free check)',
    )
  } else {
    lines.push('- none (the run has not reached preflight)')
  }
  lines.push('')
  lines.push('## Inputs (SHA-256 of stored content)')
  lines.push('')
  for (const [name, file] of Object.entries(r.inputs)) {
    lines.push(
      `- ${name}: ${file ? `${file.sha256} (${file.path})` : 'not given'}`,
    )
  }
  lines.push('')
  lines.push('## Repair runs (from outside findings)')
  lines.push('')
  const parent = r.lineage.parent
  lines.push(
    parent
      ? `- parent: ${parent.runId} (candidate ${parent.candidateCommit})`
      : '- parent: none',
  )
  lines.push(
    `- children: ${r.lineage.children.length > 0 ? r.lineage.children.join(', ') : 'none'}`,
  )
  lines.push('')
  lines.push('## Candidate')
  lines.push('')
  if (r.candidate) {
    lines.push(`- id: ${r.candidate.id}`)
    lines.push(`- branch: ${fmt(r.candidate.branch)}`)
    lines.push(`- commit: ${fmt(r.candidate.commit)}`)
    lines.push(`- changes: ${fmtChanges(r.candidate.changes)}`)
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Candidates (every sealed candidate, oldest first)')
  lines.push('')
  if (r.candidates.length > 0) {
    for (const c of r.candidates) {
      lines.push(
        `- iteration ${c.iteration}: ${c.id} — ${fmtChanges(c.changes)}`,
      )
      if (c.changes) {
        lines.push(`  - diff: ${c.changes.diffPath}`)
        lines.push(`  - changed files: ${c.changes.changedFilesPath}`)
      }
    }
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Repair calls (session handling and cache read per call)')
  lines.push('')
  if (r.repairCalls.length > 0) {
    lines.push(
      '| step | iteration | invocation | session | in | cache-read | cache-read ratio |',
    )
    lines.push('|---|---|---|---|---|---|---|')
    for (const c of r.repairCalls)
      lines.push(
        `| ${c.stepName} | ${fmt(c.iteration)} | ${c.invocationId?.slice(0, 8) ?? 'n/a'} | ${c.sessionHandling ?? 'unknown'}${c.recovered ? ' (recovered)' : ''} | ${formatTokens(c.inputTokens)} | ${formatTokens(c.cacheReadTokens)} | ${c.cacheReadRatio === null ? 'null' : c.cacheReadRatio.toFixed(4)} |`,
      )
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Reviews')
  lines.push('')
  if (r.reviews.length > 0) {
    lines.push(...reviewLines(r.reviews, ''))
  } else {
    lines.push('- none (no review round has finished)')
  }
  lines.push('')
  lines.push('## Review rounds')
  lines.push('')
  if (r.reviewRounds.length > 0) {
    for (const round of r.reviewRounds) {
      const ended =
        round.status && round.status !== 'completed'
          ? ` — ${round.status}${round.reason ? ` (${round.reason})` : ''}, not counted`
          : ''
      lines.push(
        `- round ${round.round}: ${round.candidate?.id ?? 'candidate unknown'}${ended}`,
        ...reviewLines(round.reviews, '  '),
      )
    }
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Review highlights')
  lines.push('')
  lines.push(...highlightLines(r.reviewHighlights))
  lines.push('')
  lines.push('## Spec (the spec stages and checkFromSpec)')
  lines.push('')
  if (r.spec) {
    const sp = r.spec
    lines.push(
      sp.content === null
        ? '- confirmed: not yet'
        : sp.source === 'input'
          ? `- confirmed: from the run input (--spec-file), sha256 ${fmt(sp.sha256)}`
          : `- confirmed: round ${fmt(sp.round)}, sha256 ${fmt(sp.sha256)}${sp.blocked ? ' (approved by a person over remaining blockers or after a revise)' : ''}`,
    )
    for (const f of sp.advice)
      lines.push(
        `- advice: [${f.severity}] ${f.title} — ${f.body}${f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ''})` : ''}`,
      )
    if (sp.check) {
      lines.push(`- check from spec: ${sp.check.command.join(' ')}`)
      lines.push(`- check notes: ${sp.check.notes ?? 'none'}`)
    }
    if (sp.content !== null) {
      lines.push('')
      lines.push('```markdown')
      lines.push(sp.content.replace(/\n$/, ''))
      lines.push('```')
    }
  } else {
    lines.push('- none (no spec stages and no checkFromSpec, or not reached)')
  }
  lines.push('')
  lines.push('## Spec review rounds')
  lines.push('')
  if (r.specRounds.length > 0) {
    for (const round of r.specRounds) {
      lines.push(`- round ${round.round}`, ...reviewLines(round.reviews, '  '))
    }
  } else {
    lines.push('- none')
  }
  lines.push('')
  const graded = r.attempts.flatMap((a) =>
    a.measurement?.verificationLog
      ? [{ a, log: a.measurement.verificationLog }]
      : [],
  )
  lines.push('## Verification logs (full check output per attempt)')
  lines.push('')
  if (graded.length > 0) {
    for (const { a, log } of graded) {
      lines.push(
        `- ${a.stepName} (${a.attemptId.slice(0, 8)}): exit code ${log.exitCode ?? 'null'}${log.interrupted ? `, ${INTERRUPTED_CHECK}` : ''}${a.measurement?.result === 'checkpoint-recovered' ? ', recovered from checkpoint' : ''}`,
      )
      lines.push(`  - stdout: ${log.stdoutPath}`)
      lines.push(`  - stderr: ${log.stderrPath}`)
      if (log.writeError) lines.push(`  - log write error: ${log.writeError}`)
    }
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Delivery')
  lines.push('')
  if (r.delivery) {
    lines.push(`- kind: ${r.delivery.kind}`)
    lines.push(`- location: ${r.delivery.location}`)
    lines.push(`- branch: ${fmt(r.delivery.branch)}`)
    lines.push(`- commit: ${fmt(r.delivery.commit)}`)
    lines.push(`- squashed branch: ${r.delivery.squashedBranch ?? 'none'}`)
    lines.push(`- squashed commit: ${r.delivery.squashedCommit ?? 'none'}`)
    lines.push(`- summary: ${r.delivery.summary}`)
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Worktree')
  lines.push('')
  if (!r.worktree)
    lines.push('- none (not a repository run, or setup did not finish)')
  else if (!r.worktree.present)
    lines.push(
      '- removed; the spec, verification logs, checkpoints, candidate diffs, this report and the delivery record are kept',
    )
  else {
    lines.push(`- path: ${r.worktree.path}`)
    if (r.worktree.cleanupWarning)
      lines.push(
        `- warning: could not be removed after the delivery: ${r.worktree.cleanupWarning}`,
      )
  }
  lines.push('')
  lines.push('## Stop reason')
  lines.push('')
  if (r.failure) {
    lines.push(`- kind: ${r.failure.kind}`)
    lines.push(`- reason: ${r.failure.reason}`)
    lines.push(`- retry: ${retryText(r.failure.retryable)}`)
    lines.push(`- human check: ${r.failure.humanCheck}`)
    for (const d of r.failure.details) lines.push(`- ${d}`)
    for (const n of r.failure.next) lines.push(`- next: ${n}`)
  } else {
    lines.push('- none (the run did not stop on a failure)')
  }
  lines.push('')
  lines.push('## Summary (one row per run)')
  lines.push('')
  const s = r.summary
  lines.push(`- success: ${s.success ? 'yes' : 'no'} (${fmt(s.conclusion)})`)
  lines.push(
    `- lead time (trigger -> terminal): ${formatDuration(s.leadTimeMs)}`,
  )
  lines.push(`- work (stage total): ${formatDuration(s.workMs)}`)
  lines.push(
    `- human wait: ${formatDuration(s.humanWaitMs)}${s.humanWaitRatio !== null ? ` (${(s.humanWaitRatio * 100).toFixed(1)}% of lead time)` : ''}`,
  )
  lines.push(`- llm invocations: ${s.llmInvocations}`)
  lines.push(`- total tokens: ${formatTokens(s.totalTokens)}`)
  lines.push(`- cost (api-equiv): ${formatCost(s.costUsd)}`)
  lines.push(`- cost per success: ${formatCost(s.costPerSuccessUsd)}`)
  lines.push(`- repairs: ${s.repairs}, review rounds: ${s.reviewRounds}`)
  if (r.discardedReviews)
    lines.push(
      `- reviews of candidates that failed verification: ${r.discardedReviews.invocations} call(s), cost ${formatCost(r.discardedReviews.costUsd)} (part of the cost above)`,
    )
  lines.push('')
  lines.push('## Stage usage (deduped by invocation)')
  lines.push('')
  lines.push(
    '| stage | visits | reworked | invocations | in | cache-read | cache-write | out | total | cost (api-equiv) |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  const visits = new Map(r.stageVisits.map((v) => [v.stage, v]))
  for (const u of r.stageUsage) {
    const v = visits.get(u.stage)
    lines.push(
      `| ${u.stage} | ${v?.visits ?? 'n/a'} | ${v?.reworked ?? 'n/a'} | ${u.invocations} | ${formatTokens(u.inputTokens)} | ${formatTokens(u.cacheReadTokens)} | ${formatTokens(u.cacheWriteTokens)} | ${formatTokens(u.outputTokens)} | ${formatTokens(u.totalTokens)} | ${formatCost(u.costUsd)}${u.complete ? '' : ' (PARTIAL)'} |`,
    )
  }
  for (const v of r.stageVisits) {
    if (r.stageUsage.some((u) => u.stage === v.stage)) continue
    lines.push(
      `| ${v.stage} | ${v.visits} | ${v.reworked} | 0 | - | - | - | - | - | - |`,
    )
  }
  lines.push('')
  lines.push('## Role usage (deduped by invocation)')
  lines.push('')
  lines.push(
    '| role | provider | model(requested) | effort(requested) | invocations | in | cache-read | cache-write | out | total | cost (api-equiv) | usage | cost |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const u of r.roleUsage) {
    lines.push(
      `| ${u.role} | ${fmt(u.provider)} | ${u.requestedModel ?? '(default)'} | ${u.requestedEffort ?? '(default)'} | ${u.invocations} | ${formatTokens(u.inputTokens)} | ${formatTokens(u.cacheReadTokens)} | ${formatTokens(u.cacheWriteTokens)} | ${formatTokens(u.outputTokens)} | ${formatTokens(u.totalTokens)} | ${formatCost(u.costUsd)} | ${u.complete ? 'complete' : 'PARTIAL'} | ${u.costComplete ? 'complete' : 'PARTIAL'} |`,
    )
  }
  lines.push('')
  lines.push('## Timing')
  lines.push('')
  for (const t of r.stageTimings) {
    lines.push(
      `- ${t.stage}: work=${formatDuration(t.elapsedMs)}, wall=${formatDuration(t.wallElapsedMs)}${t.complete ? '' : ' (PARTIAL — some attempts missing elapsedMs)'}`,
    )
  }
  lines.push(`- stage total: ${formatDuration(r.stageTotalMs)}`)
  if (r.stageTimings.some((t) => SPEC_STAGES.includes(t.stage)))
    lines.push(
      `- spec stages wall (spec, spec-review, spec-check together): ${formatDuration(r.specWallMs)}`,
    )
  lines.push(`- run elapsed: ${formatDuration(r.runElapsedMs)}`)
  lines.push('')
  lines.push('## Attempts (from persisted step attempts)')
  lines.push('')
  lines.push(
    '| step | invocation | status | model(requested/effective/reported) | effort(requested/effective/reported) | elapsed | tokens(in/cache-read/cache-write/out/total) | cost (api-equiv) | result |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const a of r.attempts) {
    const m = a.measurement
    const tokens = m?.usage
      ? `${formatTokens(m.usage.inputTokens)}/${formatTokens(m.usage.cacheReadTokens)}/${formatTokens(m.usage.cacheWriteTokens)}/${formatTokens(m.usage.outputTokens)}/${formatTokens(m.usage.totalTokens)}`
      : Array(5).fill(formatTokens(null)).join('/')
    const model =
      m != null
        ? `${fmt(m.requestedModel)}/${fmt(m.effectiveModel)}/${fmt(m.reportedModel)}`
        : 'unknown/unknown/unknown'
    const effort =
      m != null
        ? `${fmt(m.requestedEffort)}/${fmt(m.effectiveEffort)}/${fmt(m.reportedEffort)}`
        : 'unknown/unknown/unknown'
    lines.push(
      `| ${a.stepName} | ${m?.invocationId?.slice(0, 8) ?? 'n/a'} | ${a.status}${a.interruptionReason ? ` (${a.interruptionReason})` : ''} | ${model} | ${effort} | ${formatDuration(m?.elapsedMs)} | ${tokens} | ${m?.costUsdEstimate != null ? `${formatCost(m.costUsdEstimate)} (${m.costBasis})` : formatCost(null)} | ${fmt(m?.result)} |`,
    )
  }
  const agg = aggregateUsage(
    r.attempts.map((a) => ({
      attemptId: a.measurement?.invocationId ?? a.attemptId,
      usage: a.measurement?.usage ?? null,
      expectsUsage: attemptExpectsUsage(a.stepName),
    })),
  )
  lines.push('')
  lines.push(
    `- aggregate usage (deduped by invocation): in=${formatTokens(agg.inputTokens)} cache-read=${formatTokens(agg.cacheReadTokens)} cache-write=${formatTokens(agg.cacheWriteTokens)} out=${formatTokens(agg.outputTokens)} total=${formatTokens(agg.totalTokens)}${agg.complete ? '' : ' (PARTIAL — some invocations missing usage)'}`,
  )
  lines.push(`- missing usage invocations: ${agg.missingAttempts.length}`)
  const aggCost = aggregateInvocationCost(r.attempts, agg.complete)
  lines.push(
    `- aggregate cost (stored per-invocation estimates): ${formatCost(aggCost)}`,
  )
  lines.push('')
  lines.push('## Waits')
  lines.push('')
  for (const w of r.waits) {
    lines.push(
      `- ${w.name} (${w.id}): outcome=${fmt(w.outcome)} created=${w.createdAt} suspended=${fmt(w.suspendedAt)} resolved=${fmt(w.resolvedAt)} inputWait=${formatDuration(w.inputWaitMs)} executionSlotWait=${formatDuration(w.executionSlotWaitMs)}`,
    )
  }
  const versions = Object.entries(r.versions)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
  if (versions.length > 0) {
    lines.push('')
    lines.push('## Versions')
    lines.push('')
    for (const v of versions) lines.push(`- ${v}`)
  }
  if (r.notes.length > 0) {
    lines.push('')
    lines.push('## Notes')
    lines.push('')
    for (const n of r.notes) lines.push(`- ${n}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function reportToJson(r: LoopReport): string {
  return JSON.stringify(r, null, 2)
}
