// Shared type definitions for @coji/durably-react

import type { ClientRun, JobDefinition, Run } from '@coji/durably'

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

// SSE event types (sent from server).
// Note: Unlike core DurablyEvent, these omit timestamp/sequence because
// the SSE handler in server.ts sends only the fields needed by the UI.
export type DurablyEvent =
  | { type: 'run:start'; runId: string; jobName: string; input: unknown }
  | {
      type: 'run:complete'
      runId: string
      jobName: string
      output: unknown
      duration: number
    }
  | { type: 'run:fail'; runId: string; jobName: string; error: string }
  | { type: 'run:cancel'; runId: string; jobName: string }
  | { type: 'run:delete'; runId: string; jobName: string }
  | { type: 'run:trigger'; runId: string; jobName: string; input: unknown }
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
      type: 'step:cancel'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
      labels: Record<string, string>
    }
  | {
      type: 'log:write'
      runId: string
      jobName: string
      stepName: string | null
      labels: Record<string, string>
      level: 'info' | 'warn' | 'error'
      message: string
      data: unknown
    }

// =============================================================================
// Typed Run types for useRuns hooks
// =============================================================================

/**
 * A typed version of Run with generic input/output types.
 * Used by browser hooks (direct durably access).
 */
export type TypedRun<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined =
    | Record<string, unknown>
    | undefined,
> = Omit<Run, 'input' | 'output'> & {
  input: TInput
  output: TOutput | null
}

// ClientRun is imported from '@coji/durably' and re-exported for consumers.
export type { ClientRun } from '@coji/durably'

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
