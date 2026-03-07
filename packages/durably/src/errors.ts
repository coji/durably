/**
 * Error thrown when a run is cancelled during execution.
 * The worker catches this error and treats it specially - it does not
 * mark the run as failed, as the run status is already 'cancelled'.
 */
export class CancelledError extends Error {
  constructor(runId: string) {
    super(`Run was cancelled: ${runId}`)
    this.name = 'CancelledError'
  }
}

/**
 * Error thrown when a worker loses lease ownership during execution.
 */
export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Lease ownership was lost: ${runId}`)
    this.name = 'LeaseLostError'
  }
}

/**
 * Extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
