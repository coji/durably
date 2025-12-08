/**
 * durably - Step-oriented resumable batch execution for Node.js and browsers
 *
 * This package is under development. See https://github.com/coji/durably for updates.
 */

export interface ClientOptions {
  dialect: unknown
  pollingInterval?: number
  heartbeatInterval?: number
  staleThreshold?: number
}

export interface JobContext<TPayload> {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>
  log: {
    info(message: string, data?: Record<string, unknown>): void
    warn(message: string, data?: Record<string, unknown>): void
    error(message: string, data?: Record<string, unknown>): void
  }
}

export interface Job<TPayload> {
  name: string
  trigger(
    payload: TPayload,
    options?: { idempotencyKey?: string; concurrencyKey?: string }
  ): Promise<{ runId: string }>
  batchTrigger(
    items: Array<{
      payload: TPayload
      options?: { idempotencyKey?: string; concurrencyKey?: string }
    }>
  ): Promise<Array<{ runId: string }>>
}

export interface Client {
  register<TPayload>(job: Job<TPayload>): void
  migrate(): Promise<void>
  start(): void
  stop(): Promise<void>
  retry(runId: string): Promise<void>
  getRuns(filter?: { status?: string }): Promise<Array<{ id: string }>>
  on(event: string, handler: (event: unknown) => void): void
  use(plugin: unknown): void
}

export function createClient(_options: ClientOptions): Client {
  throw new Error(
    'durably is not yet implemented. This is a placeholder package. See https://github.com/coji/durably for updates.'
  )
}

export function defineJob<TPayload>(
  _name: string,
  _handler: (ctx: JobContext<TPayload>, payload: TPayload) => Promise<void>
): Job<TPayload> {
  throw new Error(
    'durably is not yet implemented. This is a placeholder package. See https://github.com/coji/durably for updates.'
  )
}
