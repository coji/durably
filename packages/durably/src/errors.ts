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
