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
 * Base class for errors that map to specific HTTP status codes.
 * Used by the HTTP handler to return appropriate responses.
 */
export class DurablyError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'DurablyError'
    this.statusCode = statusCode
  }
}

/** 404 — Resource not found */
export class NotFoundError extends DurablyError {
  constructor(message: string) {
    super(message, 404)
    this.name = 'NotFoundError'
  }
}

/** 400 — Invalid input or request */
export class ValidationError extends DurablyError {
  constructor(message: string) {
    super(message, 400)
    this.name = 'ValidationError'
  }
}

/** 409 — Operation conflicts with current state */
export class ConflictError extends DurablyError {
  constructor(message: string) {
    super(message, 409)
    this.name = 'ConflictError'
  }
}

/**
 * Extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Coerce unknown value to Error
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
