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

import { checkpointPaths, UNCERTAIN_INVOCATION_MESSAGE } from './runner.js'

export type FailureKind =
  | 'verification-failed'
  | 'review-cap-reached'
  | 'uncertain-invocation'
  | 'cancelled'
  | 'cancelled-publish'
  | 'unclassified'

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

interface FailureEntry {
  reason: string
  retryable: boolean
  /** What a person has to look at before doing anything else. */
  humanCheck: string
  next: (runId: string) => string[]
}

const FAILURE_REASONS: Record<FailureKind, FailureEntry> = {
  'verification-failed': {
    reason:
      'the pinned check still failed after the last repair; the repair budget is used up',
    retryable: true,
    humanCheck:
      'read the check output in the report and decide whether the task, the check or --max-iterations has to change',
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
}

/**
 * Agent calls with a start checkpoint and no completed one. Only LLM calls
 * count: a verification start-only checkpoint is re-graded on resume, not
 * refused. The run's own attempts name the operation keys, so no directory
 * is listed.
 */
export function uncertainCheckpoints(
  checkpointsDir: string | null,
  attempts: Pick<StepAttempt, 'metadata'>[],
): string[] {
  if (!checkpointsDir) return []
  const found = new Set<string>()
  for (const attempt of attempts) {
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

export interface ClassifyInput {
  runId: string
  status: string
  output: unknown
  error: string | null
  /** From `uncertainCheckpoints`: start checkpoints with no completion. */
  uncertain: string[]
  /** A repo run that pushes and opens a pull request once approved. */
  publish?: boolean
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
  if (input.status === 'completed') {
    if (conclusion === 'verification-failed') kind = 'verification-failed'
    else if (conclusion === 'review-cap-reached') kind = 'review-cap-reached'
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
        details.push(`start checkpoint without completion: ${path}`)
    } else if (input.status === 'cancelled') {
      // A cancel can land after the push or pull request but before the
      // delivery is recorded; a new run could publish a second time.
      kind = input.publish ? 'cancelled-publish' : 'cancelled'
    } else {
      kind = 'unclassified'
    }
    if (input.error)
      details.push(
        `error: ${input.error
          .slice(0, 500)
          .trim()
          .replace(/\s*\n\s*/g, ' | ')}`,
      )
  } else {
    return null
  }
  const entry = FAILURE_REASONS[kind]
  return { kind, ...entry, next: entry.next(input.runId), details }
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
  durably: Pick<AnyDurably, 'storage' | 'getStepAttempts'>,
  run: Pick<Run, 'id' | 'status' | 'input' | 'output' | 'error'>,
): Promise<FailureClassification | null> {
  let uncertain: string[] = []
  if (run.status === 'failed' || run.status === 'cancelled') {
    const setup = (await durably.storage.getCompletedStep(run.id, 'setup'))
      ?.output as { checkpointsDir?: string } | null | undefined
    uncertain = uncertainCheckpoints(
      setup?.checkpointsDir ?? null,
      await durably.getStepAttempts(run.id),
    )
  }
  return classifyFailure({
    runId: run.id,
    status: run.status,
    output: run.output,
    error: run.error,
    uncertain,
    publish:
      (run.input as { target?: { publish?: unknown } } | null)?.target
        ?.publish === true,
  })
}
