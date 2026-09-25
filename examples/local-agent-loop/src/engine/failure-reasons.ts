/**
 * Why a run stopped, and what a human does next. `status` and `report` both
 * read this one table, so the two never describe the same run differently.
 *
 * `retryable` answers one question only: can a new run start without possibly
 * repeating an agent call whose outcome is unknown? It says nothing about
 * whether the same input will succeed the next time. A failure this table
 * does not recognise is never called retryable.
 */
import { existsSync } from 'node:fs'

import type { AnyDurably, Run, StepAttempt } from '@coji/durably'

import { DETAIL_PREFIX, INTERRUPTED_CHECK } from './failure-details.js'
import type { AttemptMeasurement, VerificationLog } from './providers/types.js'
import {
  checkpointPaths,
  REFUSAL_MARKER,
  REJECTED_INVOCATION_MESSAGE,
  UNCERTAIN_INVOCATION_MESSAGE,
} from './runner.js'

export type FailureKind =
  | 'baseline-check-failed'
  | 'preflight-failed'
  | 'rejected-invocation'
  | 'verification-failed'
  | 'review-cap-reached'
  | 'uncertain-invocation'
  | 'cancelled'
  | 'cancelled-publish'
  | 'unclassified'

/**
 * How the job's own stops begin their error, so the table can tell them from
 * an unrecognised failure.
 */
export const BASELINE_FAILED_MESSAGE = 'baseline-check-failed'
export const PREFLIGHT_FAILED_MESSAGE = 'preflight-failed'

/** A baseline stop because setup left files `.gitignore` does not cover. */
const SETUP_UNTRACKED = `${BASELINE_FAILED_MESSAGE}: setup-untracked: `

/** The error for that stop; the paths are kept as JSON to read back. */
export function setupUntrackedError(workdir: string, paths: string[]): string {
  return `${SETUP_UNTRACKED}setup left untracked files that .gitignore does not cover in ${workdir}, first ${JSON.stringify(paths)}; stopped before the baseline check and any agent call`
}

/** The paths named by a `setupUntrackedError`, or null for any other error. */
function setupUntrackedPaths(error: string | null): string[] | null {
  if (!error?.startsWith(SETUP_UNTRACKED)) return null
  const listed = / first (\[.*\]); stopped before /.exec(error)?.[1]
  try {
    const paths: unknown = listed ? JSON.parse(listed) : []
    return Array.isArray(paths) ? paths.map(String) : []
  } catch {
    return []
  }
}

/**
 * The demo CLI as it runs from anywhere in this repository. Every printed
 * command starts with it, so it pastes and runs as is.
 */
export const DEMO = 'pnpm --filter example-local-agent-loop demo'

/**
 * Starts a new run with this run's stored input. A bare `demo trigger` would
 * run the bundled sample instead, so a retry always goes through here.
 */
const retrigger = (runId: string) =>
  `${DEMO} retrigger --run ${runId}  # once, with the same stored input; to change the task or --max-iterations, trigger anew`

/**
 * The same, with the settings read again from the run's factory.json: for a
 * stop that editing the config fixes. The plain retry keeps the stored
 * settings and suits a fix to the environment only.
 */
const retriggerReloaded = (runId: string, reload: ReloadAdvice): string[] =>
  reload === 'none'
    ? []
    : reload === 'config'
      ? [
          `${DEMO} retrigger --run ${runId} --reload-config  # after fixing factory.json; the stored task with the settings read again, once per version of the file`,
        ]
      : [
          `${DEMO} retrigger --run ${runId} --reload-config  # after fixing factory.json; the --check, --setup or --base given at trigger still wins over it, so to change those, trigger anew`,
        ]

/**
 * Whether a config-fix retry applies to a run: `config` for a repository
 * run, `flags-win` when its check, setup or base came from a trigger flag
 * that a reload keeps, and `none` for the bundled sample, which reads no
 * factory.json.
 */
export type ReloadAdvice = 'config' | 'flags-win' | 'none'

/** The flags a reload keeps over the settings factory.json gives. */
const PINNING_FLAGS = ['check', 'setup', 'base'] as const

/** The `ReloadAdvice` for a stored run input. */
export function reloadAdvice(input: unknown): ReloadAdvice {
  const stored = input as {
    target?: { kind?: unknown }
    configSource?: { flags?: Record<string, unknown> }
  } | null
  if (stored?.target?.kind !== 'repo') return 'none'
  const flags = stored.configSource?.flags ?? {}
  return PINNING_FLAGS.some((flag) => typeof flags[flag] === 'string')
    ? 'flags-win'
    : 'config'
}

/** The baseline check when setup left files `.gitignore` does not cover. */
const SETUP_UNTRACKED_CHECK =
  'setup creates files that .gitignore does not cover (listed below); add them to .gitignore on the base, or turn baselineCheck off in factory.json and retry with --reload-config. A passing baseline would delete them, so the run does not start with them'

/** The refusal a `RejectedInvocationError` message names; null for others. */
function refusalOf(error: string | null): string | null {
  if (!error?.startsWith(REJECTED_INVOCATION_MESSAGE)) return null
  const at = error.indexOf(REFUSAL_MARKER)
  return at < 0 ? null : error.slice(at + REFUSAL_MARKER.length)
}

/** The rejected-call check for a run with no factory.json to fix. */
const REJECTED_WITHOUT_CONFIG =
  'read the refusal below; fix the provider, model or effort of that role and trigger anew, or fix a login or quota problem in the provider CLI and retry with retrigger'

/** The preflight check for a run with no factory.json to fix. */
const PREFLIGHT_WITHOUT_CONFIG =
  'fix the provider, model or effort of the role named in the error below and trigger anew; a login problem is fixed in the provider CLI and retried with retrigger'

interface FailureEntry {
  reason: string
  retryable: boolean
  /** What a person has to look at before doing anything else. */
  humanCheck: string
  next: (runId: string, reload: ReloadAdvice) => string[]
}

const FAILURE_REASONS: Record<FailureKind, FailureEntry> = {
  'baseline-check-failed': {
    reason:
      'the pinned check already fails on the base commit, before any agent call; a candidate could not be graded',
    retryable: true,
    humanCheck:
      'read the full check output in the log files named below, then fix the check command or the environment (setup, dependencies, base); retry with --reload-config after editing factory.json, without it after fixing only the environment',
    next: (runId, reload) => [
      `${DEMO} report --run ${runId}  # the baseline check output`,
      ...retriggerReloaded(runId, reload),
      retrigger(runId),
    ],
  },
  'preflight-failed': {
    reason:
      "a role's provider, model or effort is not usable; the run stopped before any implementation call",
    retryable: true,
    humanCheck:
      'fix the profile of the role named in the error below, or codexPath, in factory.json and retry with --reload-config; a login problem is fixed in the provider CLI and retried without it',
    next: (runId, reload) => [
      `${DEMO} report --run ${runId}  # the preflight result for each role`,
      ...retriggerReloaded(runId, reload),
      retrigger(runId),
    ],
  },
  'rejected-invocation': {
    reason:
      "the provider explicitly refused an agent call after preflight; the refusal is recorded as that call's answer, so no call was left with an unknown outcome",
    retryable: true,
    humanCheck:
      'read the refusal below; fix the profile of that role, or codexPath, in factory.json and retry with --reload-config, or fix a login or quota problem in the provider CLI and retry without it',
    next: (runId, reload) => [
      `${DEMO} report --run ${runId}  # the refused call and its reason`,
      ...retriggerReloaded(runId, reload),
      retrigger(runId),
    ],
  },
  'verification-failed': {
    reason:
      'the pinned check still failed after the last repair; the repair budget is used up',
    retryable: true,
    humanCheck:
      'read the full check output in the log files named below and decide whether the task, the check or --max-iterations has to change',
    next: (runId) => [
      `${DEMO} report --run ${runId} --format json  # the check output is in the verification attempt`,
      retrigger(runId),
    ],
  },
  'review-cap-reached': {
    reason:
      'the check passed but a reviewer still asked for changes after the last repair',
    retryable: true,
    humanCheck:
      'read the reviewer notes in the report; finish the candidate by hand or restate the task',
    next: (runId) => [
      `${DEMO} report --run ${runId}  # the reviewer notes`,
      retrigger(runId),
    ],
  },
  'uncertain-invocation': {
    reason:
      'an agent call started but has no completed checkpoint; whether the provider received and acted on it is unknown',
    retryable: false,
    humanCheck:
      "check the provider's own session history and usage for that call, the worktree, and the start checkpoint named below before sending anything again",
    next: (runId) => [
      `${DEMO} report --run ${runId}`,
      `${DEMO} status --run ${runId}`,
    ],
  },
  cancelled: {
    reason:
      'the run was cancelled; no agent call was left without a completed checkpoint',
    retryable: true,
    humanCheck: 'confirm the cancel was intended',
    next: (runId) => [`${DEMO} report --run ${runId}`, retrigger(runId)],
  },
  'cancelled-publish': {
    reason:
      'the run was cancelled with --publish; the branch may already be pushed and a pull request opened',
    retryable: false,
    humanCheck:
      'check the remote for the run branch and a draft pull request before starting another run',
    next: (runId) => [
      `${DEMO} report --run ${runId}  # delivery shows what was recorded`,
    ],
  },
  unclassified: {
    reason: 'the run failed for a reason this table does not recognise',
    retryable: false,
    humanCheck:
      'read the run error and the attempts before starting another run',
    next: (runId) => [`${DEMO} status --run ${runId}`],
  },
}

/** A classified stop, ready to print or to put in a report. */
export interface FailureClassification {
  kind: FailureKind
  reason: string
  retryable: boolean
  humanCheck: string
  next: string[]
  /** Run-specific facts behind the classification: an error, a checkpoint. */
  details: string[]
  /** Whether `next` offers the config-reload retry, and why not. */
  reload: ReloadAdvice
  /** A baseline stop because setup left files `.gitignore` does not cover. */
  setupUntracked: boolean
}

/**
 * Agent calls with a start checkpoint and no completed one. Only LLM calls
 * count: a verification start-only checkpoint is re-graded on resume, not
 * refused. The run's own attempts name the operation keys, so no directory
 * is listed.
 */
export function uncertainCheckpoints(
  checkpointsDir: string | null,
  attempts: Pick<StepAttempt, 'metadata' | 'status'>[],
): string[] {
  if (!checkpointsDir) return []
  const found = new Set<string>()
  for (const attempt of attempts) {
    // A completed step never replays its call, so a start it left behind is
    // not a doubt.
    if (attempt.status === 'completed') continue
    const m = attempt.metadata as {
      usageScope?: unknown
      operationKey?: unknown
    } | null
    if (m?.usageScope !== 'invocation' || typeof m.operationKey !== 'string')
      continue
    const paths = checkpointPaths(checkpointsDir, m.operationKey)
    if (existsSync(paths.started) && !existsSync(paths.completed))
      found.add(paths.started)
  }
  return [...found]
}

/** `stage:<sequence>:<stage>:<part>` split up; null for other step names. */
export function stageStep(
  name: string,
): { sequence: number; stage: string; part: string } | null {
  const [kind, seq, stage, part] = name.split(':')
  const sequence = Number(seq)
  return kind === 'stage' && Number.isInteger(sequence) && stage && part
    ? { sequence, stage, part }
    : null
}

/**
 * The full-output logs of the baseline check, every physical attempt, oldest
 * first. A replay that read the completed checkpoint adds nothing.
 */
export function baselineLogs(
  attempts: Pick<StepAttempt, 'stepName' | 'startedAt' | 'metadata'>[],
): VerificationLog[] {
  return distinctLogs(
    attempts
      .filter((a) => a.stepName === 'baseline')
      .map((a) => ({
        startedAt: a.startedAt,
        log: (a.metadata as AttemptMeasurement | null)?.verificationLog,
      })),
  )
}

/** One grading attempt's log as detail lines, the same for every check. */
function logDetails(log: VerificationLog): string[] {
  return [
    ...(log.interrupted
      ? [`${DETAIL_PREFIX.checkAttempt}${INTERRUPTED_CHECK}`]
      : []),
    `${DETAIL_PREFIX.checkExitCode}${log.exitCode ?? 'null'}`,
    ...(log.timedOutAfterMs !== undefined
      ? [`${DETAIL_PREFIX.checkTimeout}${log.timedOutAfterMs}ms`]
      : []),
    `${DETAIL_PREFIX.checkStdout}${log.stdoutPath}`,
    `${DETAIL_PREFIX.checkStderr}${log.stderrPath}`,
    ...(log.writeError
      ? [`${DETAIL_PREFIX.checkLogWriteError}${log.writeError}`]
      : []),
  ]
}

/**
 * The full-output logs of the verification that stopped the run: every
 * physical attempt of the last verify step, oldest first. A replay that read
 * the completed checkpoint points at the same files and adds nothing.
 */
export function lastVerificationLogs(
  attempts: Pick<StepAttempt, 'stepName' | 'startedAt' | 'metadata'>[],
): VerificationLog[] {
  const verify = attempts.flatMap((a) => {
    const step = stageStep(a.stepName)
    return step?.stage === 'verify'
      ? [
          {
            sequence: step.sequence,
            startedAt: a.startedAt,
            log:
              (a.metadata as AttemptMeasurement | null)?.verificationLog ??
              null,
          },
        ]
      : []
  })
  // The last verify step is chosen before looking for logs: when it has none
  // (a checkpoint written before logs existed), an earlier step's logs would
  // name output that did not stop the run.
  const last = Math.max(-1, ...verify.map((a) => a.sequence))
  return distinctLogs(verify.filter((a) => a.sequence === last))
}

/**
 * Logs oldest first. A replay that read the completed checkpoint points at
 * the same files as the attempt that wrote it, so it adds nothing.
 */
function distinctLogs(
  attempts: { startedAt: string; log: VerificationLog | null | undefined }[],
): VerificationLog[] {
  const seen = new Set<string>()
  return [...attempts]
    .sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt))
    .flatMap(({ log }) => {
      if (!log || seen.has(log.stdoutPath)) return []
      seen.add(log.stdoutPath)
      return [log]
    })
}

export interface ClassifyInput {
  runId: string
  status: string
  output: unknown
  error: string | null
  /** From `uncertainCheckpoints`: start checkpoints with no completion. */
  uncertain: string[]
  /** From `lastVerificationLogs`: the stopping verification's logs. */
  verificationLogs?: VerificationLog[]
  /** From `baselineLogs`: the base-commit check's logs. */
  baselineLogs?: VerificationLog[]
  /** A repo run that pushes and opens a pull request once approved. */
  publish?: boolean
  /** From `reloadAdvice`; a repository run with no flags when omitted. */
  reload?: ReloadAdvice
}

/**
 * Classify a stopped run. Null for runs that are still open and for runs a
 * human already decided (approved or rejected).
 */
export function classifyFailure(
  input: ClassifyInput,
): FailureClassification | null {
  const conclusion = (input.output as { conclusion?: unknown } | null)
    ?.conclusion
  let kind: FailureKind
  const details: string[] = []
  let setupPaths: string[] | null = null
  if (input.status === 'completed') {
    if (conclusion === 'verification-failed') {
      kind = 'verification-failed'
      for (const log of input.verificationLogs ?? [])
        details.push(...logDetails(log))
    } else if (conclusion === 'review-cap-reached') kind = 'review-cap-reached'
    else return null
  } else if (input.status === 'failed' || input.status === 'cancelled') {
    // An unresolved call outranks everything else: whatever else went wrong,
    // starting over could send that prompt a second time.
    if (
      input.uncertain.length > 0 ||
      input.error?.includes(UNCERTAIN_INVOCATION_MESSAGE)
    ) {
      kind = 'uncertain-invocation'
      for (const path of input.uncertain)
        details.push(`${DETAIL_PREFIX.checkpoint}${path}`)
    } else if (input.status === 'cancelled') {
      // A cancel can land after the push or pull request but before the
      // delivery is recorded; a new run could publish a second time.
      kind = input.publish ? 'cancelled-publish' : 'cancelled'
    } else if (input.error?.startsWith(BASELINE_FAILED_MESSAGE)) {
      kind = 'baseline-check-failed'
      setupPaths = setupUntrackedPaths(input.error)
      for (const path of setupPaths ?? [])
        details.push(`${DETAIL_PREFIX.setupUntracked}${path}`)
      for (const log of input.baselineLogs ?? [])
        details.push(...logDetails(log))
    } else if (input.error?.startsWith(PREFLIGHT_FAILED_MESSAGE)) {
      kind = 'preflight-failed'
    } else if (input.error?.startsWith(REJECTED_INVOCATION_MESSAGE)) {
      kind = 'rejected-invocation'
      const refusal = refusalOf(input.error)
      if (refusal) details.push(`${DETAIL_PREFIX.refusal}${refusal}`)
    } else {
      kind = 'unclassified'
    }
    if (input.error)
      details.push(
        `${DETAIL_PREFIX.error}${input.error
          .slice(0, 500)
          .trim()
          .replace(/\s*\n\s*/g, ' | ')}`,
      )
  } else {
    return null
  }
  const entry = FAILURE_REASONS[kind]
  const reload = input.reload ?? 'config'
  return {
    kind,
    ...entry,
    ...(kind === 'preflight-failed' && reload === 'none'
      ? { humanCheck: PREFLIGHT_WITHOUT_CONFIG }
      : {}),
    ...(kind === 'rejected-invocation' && reload === 'none'
      ? { humanCheck: REJECTED_WITHOUT_CONFIG }
      : {}),
    ...(setupPaths ? { humanCheck: SETUP_UNTRACKED_CHECK } : {}),
    next: entry.next(input.runId, reload),
    details,
    reload,
    setupUntracked: setupPaths !== null,
  }
}

/** One wording for the retry verdict, shared by `status` and `report`. */
export function retryText(retryable: boolean): string {
  return retryable
    ? 'yes: safe to start a new run (no unresolved agent call); it may still fail the same way'
    : 'NO — do not start a new run until a human has checked'
}

/**
 * Classify a stored run. Reads the setup step for the checkpoints directory
 * (a run that failed before setup finished has none) and only looks for
 * unresolved calls when the run actually failed or was cancelled.
 */
export async function classifyRun(
  durably: Pick<AnyDurably, 'getStepAttempts'> & {
    storage: Pick<AnyDurably['storage'], 'getCompletedStep'>
  },
  run: Pick<Run, 'id' | 'status' | 'input' | 'output' | 'error'>,
): Promise<FailureClassification | null> {
  let uncertain: string[] = []
  let verificationLogs: VerificationLog[] = []
  let baseline: VerificationLog[] = []
  if (run.status === 'failed' || run.status === 'cancelled') {
    const setup = (await durably.storage.getCompletedStep(run.id, 'setup'))
      ?.output as { checkpointsDir?: string } | null | undefined
    const attempts = await durably.getStepAttempts(run.id)
    uncertain = uncertainCheckpoints(setup?.checkpointsDir ?? null, attempts)
    baseline = baselineLogs(attempts)
  } else if (
    run.status === 'completed' &&
    (run.output as { conclusion?: unknown } | null)?.conclusion ===
      'verification-failed'
  ) {
    verificationLogs = lastVerificationLogs(
      await durably.getStepAttempts(run.id),
    )
  }
  return classifyFailure({
    runId: run.id,
    status: run.status,
    output: run.output,
    error: run.error,
    uncertain,
    verificationLogs,
    baselineLogs: baseline,
    publish:
      (run.input as { target?: { publish?: unknown } } | null)?.target
        ?.publish === true,
    reload: reloadAdvice(run.input),
  })
}
