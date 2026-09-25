/**
 * How each line of a failure's `details` starts. The web UI splits a line at
 * its prefix to show the value as data under its own label. No imports, so
 * the page can use it.
 */
export const DETAIL_PREFIX = {
  checkpoint: 'start checkpoint without completion: ',
  error: 'error: ',
  refusal: 'refusal: ',
  checkAttempt: 'check attempt: ',
  checkExitCode: 'check exit code: ',
  checkStdout: 'check stdout log: ',
  checkStderr: 'check stderr log: ',
  checkTimeout: 'check timed out after: ',
  checkLogWriteError: 'check log write error: ',
  setupUntracked: 'untracked setup output: ',
} as const

/** The `checkAttempt` value of a cancelled or lease-lost grading attempt. */
export const INTERRUPTED_CHECK = 'interrupted, not part of the verdict'

/** Detail kinds whose value is a file path a person may want to copy. */
export const PATH_DETAILS = ['checkStdout', 'checkStderr'] as const
