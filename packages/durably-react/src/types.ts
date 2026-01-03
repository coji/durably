// Shared type definitions for @coji/durably-react

import type { JobDefinition, Run } from '@coji/durably'

// Type inference utilities for extracting Input/Output types from JobDefinition
export type InferInput<T> =
  T extends JobDefinition<string, infer TInput, unknown>
    ? TInput extends Record<string, unknown>
      ? TInput
      : Record<string, unknown>
    : T extends { trigger: (input: infer TInput) => unknown }
      ? TInput extends Record<string, unknown>
        ? TInput
        : Record<string, unknown>
      : Record<string, unknown>

export type InferOutput<T> =
  T extends JobDefinition<string, unknown, infer TOutput>
    ? TOutput extends Record<string, unknown>
      ? TOutput
      : Record<string, unknown>
    : T extends {
          trigger: (input: unknown) => Promise<{ output?: infer TOutput }>
        }
      ? TOutput extends Record<string, unknown>
        ? TOutput
        : Record<string, unknown>
      : Record<string, unknown>

export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface Progress {
  current: number
  total?: number
  message?: string
}

export interface LogEntry {
  id: string
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
  timestamp: string
}

// Shared subscription state (used by both direct and SSE subscriptions)
export interface SubscriptionState<TOutput = unknown> {
  status: RunStatus | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
}

// SSE event types (sent from server)
export type DurablyEvent =
  | { type: 'run:start'; runId: string; jobName: string; payload: unknown }
  | {
      type: 'run:complete'
      runId: string
      jobName: string
      output: unknown
      duration: number
    }
  | { type: 'run:fail'; runId: string; jobName: string; error: string }
  | { type: 'run:cancel'; runId: string; jobName: string }
  | { type: 'run:retry'; runId: string; jobName: string }
  | {
      type: 'run:progress'
      runId: string
      jobName: string
      progress: Progress
    }
  | {
      type: 'step:start'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
    }
  | {
      type: 'step:complete'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
      output: unknown
    }
  | {
      type: 'log:write'
      runId: string
      jobName: string
      level: 'info' | 'warn' | 'error'
      message: string
      data: unknown
    }

// =============================================================================
// Typed Run types for useRuns hooks
// =============================================================================

/**
 * A typed version of Run with generic payload/output types.
 * Used by browser hooks (direct durably access).
 */
export type TypedRun<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined =
    | Record<string, unknown>
    | undefined,
> = Omit<Run, 'payload' | 'output'> & {
  payload: TInput
  output: TOutput | null
}

/**
 * Run type for client mode (matches server response).
 * Used by client hooks (HTTP/SSE connection).
 */
export interface ClientRun {
  id: string
  jobName: string
  status: RunStatus
  input: unknown
  output: unknown | null
  error: string | null
  currentStepIndex: number
  stepCount: number
  progress: Progress | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

/**
 * A typed version of ClientRun with generic input/output types.
 * Used by client hooks (HTTP/SSE connection).
 */
export type TypedClientRun<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined =
    | Record<string, unknown>
    | undefined,
> = Omit<ClientRun, 'input' | 'output'> & {
  input: TInput
  output: TOutput | null
}

/**
 * Type guard to check if an object is a JobDefinition.
 * Used to distinguish between JobDefinition and options objects in overloaded functions.
 */
export function isJobDefinition<
  TName extends string = string,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined = undefined,
>(obj: unknown): obj is JobDefinition<TName, TInput, TOutput> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'run' in obj &&
    typeof (obj as { run: unknown }).run === 'function'
  )
}
