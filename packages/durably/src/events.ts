/**
 * Base event interface
 */
export interface BaseEvent {
  type: string
  timestamp: string
  sequence: number
}

/**
 * Run start event
 */
export interface RunStartEvent extends BaseEvent {
  type: 'run:start'
  runId: string
  jobName: string
  payload: unknown
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
}

/**
 * Log write event
 */
export interface LogWriteEvent extends BaseEvent {
  type: 'log:write'
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
}

/**
 * All event types as discriminated union
 */
export type DurablyEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunFailEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | LogWriteEvent

/**
 * Event types for type-safe event names
 */
export type EventType = DurablyEvent['type']

/**
 * Extract event by type
 */
export type EventByType<T extends EventType> = Extract<DurablyEvent, { type: T }>

/**
 * Event input (without auto-generated fields)
 */
export type EventInput<T extends EventType> = Omit<EventByType<T>, 'timestamp' | 'sequence'>

/**
 * All possible event inputs as a union (properly distributed)
 */
export type AnyEventInput =
  | EventInput<'run:start'>
  | EventInput<'run:complete'>
  | EventInput<'run:fail'>
  | EventInput<'step:start'>
  | EventInput<'step:complete'>
  | EventInput<'step:fail'>
  | EventInput<'log:write'>

/**
 * Event listener function
 */
export type EventListener<T extends EventType> = (event: EventByType<T>) => void

/**
 * Unsubscribe function returned by on()
 */
export type Unsubscribe = () => void

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

  return {
    on<T extends EventType>(type: T, listener: EventListener<T>): Unsubscribe {
      if (!listeners.has(type)) {
        listeners.set(type, new Set())
      }

      const typeListeners = listeners.get(type)!
      typeListeners.add(listener as unknown as EventListener<EventType>)

      return () => {
        typeListeners.delete(listener as unknown as EventListener<EventType>)
      }
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
        } catch {
          // Ignore listener exceptions - they should not affect other listeners
        }
      }
    },
  }
}
