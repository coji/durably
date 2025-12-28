// Shared type definitions for @coji/durably-react

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed'

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
