/**
 * Helpers that turn stored stage, role, lens, triage and failure
 * identifiers into the page's words, shared by the server's screen-reader
 * sentences and the page. The words themselves live in the glossary;
 * unknown identifiers pass through unchanged.
 */
import {
  DETAIL_PREFIX,
  INTERRUPTED_CHECK,
  PATH_DETAILS,
} from '../engine/failure-details.js'
import type { FailureKind, ReloadAdvice } from '../engine/failure-reasons.js'
import type { Diagnosis } from '../engine/status.js'
import {
  CHECK_TEXT,
  COMMAND_NOTES,
  COPY,
  DECIDED_TEXT,
  DETAIL_LABEL,
  DETAIL_TEXT,
  DIAGNOSIS_TEXT,
  FAILURE_TEXT,
  LEASE_EXPIRED_UNCERTAIN_TEXT,
  LENS_NAME,
  RECORD,
  RETRY_TEXT,
  REVIEW_DECISION,
  REVIEW_STATUS,
  ROLE_NAME,
  RUN_KIND_NAME,
  SPEC_REVIEWER,
  STAGE_NAME,
  STEP_PART_NAME,
  STOP_NAME,
  TRIAGE_NAME,
} from './glossary.js'

export function stageName(stage: string): string {
  return STAGE_NAME[stage] ?? stage
}

/** A review lens, such as `correctness`, as a review's name. */
export function lensName(lens: string): string {
  return LENS_NAME[lens] ?? lens
}

/** The prefix of a spec reviewer's role, `spec-review:<name>`. */
const SPEC_REVIEW_ROLE = 'spec-review:'

/**
 * A usage role: `code`, `repair`, `triage`, a review lens, a spec role, or
 * a named spec reviewer, whose name is kept as it is written.
 */
export function roleName(role: string): string {
  if (role.startsWith(SPEC_REVIEW_ROLE))
    return SPEC_REVIEWER(role.slice(SPEC_REVIEW_ROLE.length))
  return ROLE_NAME[role] ?? LENS_NAME[role] ?? STAGE_NAME[role] ?? role
}

export function runKindName(kind: string): string {
  return RUN_KIND_NAME[kind] ?? kind
}

export function triageName(judgment: string): string {
  return TRIAGE_NAME[judgment] ?? judgment
}

/** The last part of a step name inside a stage, such as `agent`. */
export function stepPartName(part: string): string {
  return STEP_PART_NAME[part] ?? part
}

export function stopName(kind: string): string {
  return STOP_NAME[kind as FailureKind] ?? kind
}

export function diagnosisText(
  d: Pick<Diagnosis, 'kind' | 'failure' | 'decision'>,
  /** A lease-expired run left an agent call without a completion. */
  uncertainCall = false,
): string {
  if (d.kind === 'stopped')
    return d.failure
      ? FAILURE_TEXT[d.failure.kind].reason
      : FAILURE_TEXT.unclassified.reason
  if (d.kind === 'lease-expired' && uncertainCall)
    return LEASE_EXPIRED_UNCERTAIN_TEXT
  if (d.kind === 'decided' && d.decision && DECIDED_TEXT[d.decision])
    return DECIDED_TEXT[d.decision]
  return DIAGNOSIS_TEXT[d.kind]
}

/** Whether the run can simply be started again, in words. */
export function retryLabel(retryable: boolean): string {
  return retryable ? RETRY_TEXT.retryable : RETRY_TEXT.notRetryable
}

/**
 * How a review, or a round, run beside a check the candidate failed ended:
 * its label and reason; null for one that counted (ADR-0029).
 */
export function reviewStatus(
  status: string | null | undefined,
): { label: string; reason: string } | null {
  return status ? (REVIEW_STATUS[status] ?? null) : null
}

/**
 * A review verdict's word and hover text. An unknown verdict is data, shown
 * as stored.
 */
export function reviewDecision(decision: string): {
  label: string
  title: string
} {
  return REVIEW_DECISION[decision] ?? { label: decision, title: decision }
}

/**
 * The command itself, without the CLI's English `  # …` comment. The page
 * explains each command in Japanese on its button, in the button's tooltip,
 * and in the reason text.
 */
export function commandText(line: string): string {
  return splitCommand(line).command
}

/** A CLI next-command line split into the command and its English note. */
function splitCommand(line: string): { command: string; note: string | null } {
  const at = line.indexOf('  # ')
  return at < 0
    ? { command: line, note: null }
    : { command: line.slice(0, at), note: line.slice(at + 4) }
}

/**
 * Notes the page does not repeat on the buttons, because the reason text
 * above them already says the same thing: the lease-expired run's notes.
 */
const SAID_BY_REASON = [
  'the reclaimed run stops at that call',
  'a worker reclaims the run',
]

export function commandNote(line: string): string | null {
  const { note } = splitCommand(line)
  if (note === null || noteSaidByReason(note)) return null
  // Whole-note match: a note that gains a clause must get its own translation.
  return COMMAND_NOTES.find(([en]) => note === en)?.[1] ?? null
}

/** Is this CLI note one the page deliberately leaves to the reason text? */
export function noteSaidByReason(note: string): boolean {
  return SAID_BY_REASON.some((en) => note.startsWith(en))
}

/**
 * What a person checks first. `failure` carries the server's own verdicts:
 * whether the config-reload retry applies, and whether setup left files.
 */
export function humanCheckText(
  kind: FailureKind,
  failure?: { reload?: ReloadAdvice; setupUntracked?: boolean },
): string {
  const noConfig = failure?.reload === 'none'
  if (kind === 'baseline-check-failed' && failure?.setupUntracked)
    return noConfig
      ? CHECK_TEXT.setupUntrackedWithoutConfig
      : CHECK_TEXT.setupUntracked
  if (kind === 'baseline-check-failed' && noConfig)
    return CHECK_TEXT.baselineWithoutConfig
  if (kind === 'preflight-failed' && failure?.reload === 'none')
    return CHECK_TEXT.preflightWithoutConfig
  if (kind === 'rejected-invocation' && failure?.reload === 'none')
    return CHECK_TEXT.rejectedWithoutConfig
  return FAILURE_TEXT[kind].check
}

/**
 * Whether the check text for this stop points at the check's log files
 * below it, so the page shows them right there.
 */
export function checkNamesLogs(
  kind: FailureKind,
  failure?: { setupUntracked?: boolean },
): boolean {
  if (kind === 'verification-failed') return true
  return kind === 'baseline-check-failed' && !failure?.setupUntracked
}

/** Shown for an exit code the check never returned. */
export const NO_EXIT_CODE = DETAIL_TEXT.noExitCode

/** Shown for a cancelled or lease-lost grading attempt. */
export const INTERRUPTED_CHECK_TEXT = DETAIL_TEXT.interruptedCheck

/** Shown beside a log write error, which is kept as data. */
export const LOG_WRITE_ERROR_NOTE = DETAIL_TEXT.logWriteErrorNote

/**
 * A failure detail line as a label and its value, to show as data. `title`
 * explains a value that needs it on hover; `note` is a sentence to show
 * above the value.
 */
export function detailField(line: string): {
  label: string
  value: string
  title?: string
  note?: string
} {
  for (const [key, prefix] of Object.entries(DETAIL_PREFIX)) {
    if (!line.startsWith(prefix)) continue
    const label = DETAIL_LABEL[key as keyof typeof DETAIL_PREFIX]
    const value = line.slice(prefix.length)
    if (key === 'checkAttempt' && value === INTERRUPTED_CHECK)
      return { label, value: INTERRUPTED_CHECK_TEXT }
    if (key === 'checkExitCode' && value === 'null')
      return { label, value, title: NO_EXIT_CODE }
    if (key === 'checkLogWriteError')
      return { label, value, note: LOG_WRITE_ERROR_NOTE }
    return { label, value }
  }
  return { label: DETAIL_TEXT.record, value: line }
}

/** A detail line whose value is a file path to copy, such as a check log. */
export function isPathDetail(line: string): boolean {
  return PATH_DETAILS.some((key) => line.startsWith(DETAIL_PREFIX[key]))
}

/**
 * The delivery's squashed branch as the page shows it: its label, the name
 * the report recorded, and what its copy button says. A delivery recorded
 * before the branch existed has no name, and the page says so.
 */
export function squashedBranchField(delivery: {
  squashedBranch?: string | null
}): { label: string; value: string | null; copyLabel: string } {
  return {
    label: RECORD.squashedBranch,
    value: delivery.squashedBranch ?? null,
    copyLabel: COPY.squashedBranch,
  }
}
