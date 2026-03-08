/**
 * Base event interface
 */
export interface BaseEvent {
  type: string
  timestamp: string
  sequence: number
}

/**
 * Run trigger event (emitted when a job is triggered, before worker picks it up)
 */
export interface RunTriggerEvent extends BaseEvent {
  type: 'run:trigger'
  runId: string
  jobName: string
  input: unknown
  labels: Record<string, string>
}

/**
 * Run leased event
 */
export interface RunLeasedEvent extends BaseEvent {
  type: 'run:leased'
  runId: string
  jobName: string
  input: unknown
  leaseOwner: string
  leaseExpiresAt: string
  labels: Record<string, string>
}

export interface RunLeaseRenewedEvent extends BaseEvent {
  type: 'run:lease-renewed'
  runId: string
  jobName: string
  leaseOwner: string
  leaseExpiresAt: string
  labels: Record<string, string>
}

/**
 * Run complete event
 */
export interface RunCompleteEvent extends BaseEvent {
  type: 'run:complete'
  runId: string
  jobName: string
  output: unknown
  duration: number
  labels: Record<string, string>
}

/**
 * Run fail event
 */
export interface RunFailEvent extends BaseEvent {
  type: 'run:fail'
  runId: string
  jobName: string
  error: string
  failedStepName: string
  labels: Record<string, string>
}

/**
 * Run cancel event
 */
export interface RunCancelEvent extends BaseEvent {
  type: 'run:cancel'
  runId: string
  jobName: string
  labels: Record<string, string>
}

/**
 * Run delete event (emitted when a run is deleted)
 */
export interface RunDeleteEvent extends BaseEvent {
  type: 'run:delete'
  runId: string
  jobName: string
  labels: Record<string, string>
}

/**
 * Progress data reported by step.progress()
 */
export interface ProgressData {
  current: number
  total?: number
  message?: string
}

/**
 * Run progress event
 */
export interface RunProgressEvent extends BaseEvent {
  type: 'run:progress'
  runId: string
  jobName: string
  progress: ProgressData
  labels: Record<string, string>
}

/**
 * Step start event
 */
export interface StepStartEvent extends BaseEvent {
  type: 'step:start'
  runId: string
  jobName: string
  stepName: string
  stepIndex: number
  labels: Record<string, string>
}

/**
 * Step complete event
 */
export interface StepCompleteEvent extends BaseEvent {
  type: 'step:complete'
  runId: string
  jobName: string
  stepName: string
  stepIndex: number
  output: unknown
  duration: number
  labels: Record<string, string>
}

/**
 * Step fail event
 */
export interface StepFailEvent extends BaseEvent {
  type: 'step:fail'
  runId: string
  jobName: string
  stepName: string
  stepIndex: number
  error: string
  labels: Record<string, string>
}

export interface StepCancelEvent extends BaseEvent {
  type: 'step:cancel'
  runId: string
  jobName: string
  stepName: string
  stepIndex: number
  labels: Record<string, string>
}

/**
 * Log data reported by step.log
 */
export interface LogData {
  level: 'info' | 'warn' | 'error'
  message: string
  data?: unknown
  stepName?: string | null
}

/**
 * Log write event
 */
export interface LogWriteEvent extends BaseEvent, LogData {
  type: 'log:write'
  runId: string
  jobName: string
  labels: Record<string, string>
  stepName: string | null
  data: unknown
}

/**
 * Worker error event (internal errors like heartbeat failures)
 */
export interface WorkerErrorEvent extends BaseEvent {
  type: 'worker:error'
  error: string
  context: string
  runId?: string
}

/**
 * All event types as discriminated union
 */
export type DurablyEvent =
  | RunTriggerEvent
  | RunLeasedEvent
  | RunLeaseRenewedEvent
  | RunCompleteEvent
  | RunFailEvent
  | RunCancelEvent
  | RunDeleteEvent
  | RunProgressEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | StepCancelEvent
  | LogWriteEvent
  | WorkerErrorEvent

/**
 * Event types for type-safe event names
 */
export type EventType = DurablyEvent['type']

/**
 * Extract event by type
 */
export type EventByType<T extends EventType> = Extract<
  DurablyEvent,
  { type: T }
>

/**
 * Event input (without auto-generated fields)
 */
export type EventInput<T extends EventType> = Omit<
  EventByType<T>,
  'timestamp' | 'sequence'
>

/**
 * All possible event inputs as a union (properly distributed)
 */
export type AnyEventInput =
  | EventInput<'run:trigger'>
  | EventInput<'run:leased'>
  | EventInput<'run:lease-renewed'>
  | EventInput<'run:complete'>
  | EventInput<'run:fail'>
  | EventInput<'run:cancel'>
  | EventInput<'run:delete'>
  | EventInput<'run:progress'>
  | EventInput<'step:start'>
  | EventInput<'step:complete'>
  | EventInput<'step:fail'>
  | EventInput<'step:cancel'>
  | EventInput<'log:write'>
  | EventInput<'worker:error'>

/**
 * Event listener function
 */
export type EventListener<T extends EventType> = (event: EventByType<T>) => void

/**
 * Unsubscribe function returned by on()
 */
export type Unsubscribe = () => void

/**
 * Error handler function for listener exceptions
 */
export type ErrorHandler = (error: Error, event: DurablyEvent) => void

/**
 * Event emitter interface
 */
export interface EventEmitter {
  /**
   * Register an event listener
   * @returns Unsubscribe function
   */
  on<T extends EventType>(type: T, listener: EventListener<T>): Unsubscribe

  /**
   * Register an error handler for listener exceptions
   */
  onError(handler: ErrorHandler): void

  /**
   * Emit an event (auto-assigns timestamp and sequence)
   */
  emit(event: AnyEventInput): void
}

/**
 * Create an event emitter
 */
export function createEventEmitter(): EventEmitter {
  const listeners = new Map<EventType, Set<EventListener<EventType>>>()
  let sequence = 0
  let errorHandler: ErrorHandler | null = null

  return {
    on<T extends EventType>(type: T, listener: EventListener<T>): Unsubscribe {
      if (!listeners.has(type)) {
        listeners.set(type, new Set())
      }

      const typeListeners = listeners.get(type)
      typeListeners?.add(listener as unknown as EventListener<EventType>)

      return () => {
        typeListeners?.delete(listener as unknown as EventListener<EventType>)
      }
    },

    onError(handler: ErrorHandler): void {
      errorHandler = handler
    },

    emit(event: AnyEventInput): void {
      sequence++
      const fullEvent = {
        ...event,
        timestamp: new Date().toISOString(),
        sequence,
      } as DurablyEvent

      const typeListeners = listeners.get(event.type)
      if (!typeListeners) {
        return
      }

      for (const listener of typeListeners) {
        try {
          listener(fullEvent)
        } catch (error) {
          if (errorHandler) {
            errorHandler(
              error instanceof Error ? error : new Error(String(error)),
              fullEvent,
            )
          }
          // Continue to next listener regardless of error
        }
      }
    },
  }
}
