/**
 * The four state tones and which one each stored state takes. Color is for
 * the three that ask for attention: waiting on a person, failed, running.
 * Everything else, a finished run included, is the neutral `done`.
 */
import type { DiagnosisKind } from '../../engine/status'
import { CONCLUSION_NAME, KIND_NAME, TRACE_STATE_NAME } from '../glossary'
import type { TraceState } from '../server'

export type Tone = 'waiting' | 'failed' | 'running' | 'done'

export interface Status {
  label: string
  tone: Tone
}

export const TONES: readonly Tone[] = ['waiting', 'failed', 'running', 'done']

/** A badge's fill and text. */
export const TONE_FILL: Record<Tone, string> = {
  waiting: 'bg-waiting-bg text-waiting',
  failed: 'bg-failed-bg text-failed',
  running: 'bg-running-bg text-running',
  done: 'bg-done-bg text-done',
}

/** A state word set in running text. */
export const TONE_TEXT: Record<Tone, string> = {
  waiting: 'text-waiting',
  failed: 'text-failed',
  running: 'text-running',
  done: 'text-fg-3',
}

const KIND_TONE: Record<DiagnosisKind, Tone> = {
  approval: 'waiting',
  'spec-approval': 'waiting',
  'other-wait': 'waiting',
  stopped: 'failed',
  running: 'running',
  pending: 'done',
  'lease-expired': 'done',
  decided: 'done',
  finished: 'done',
}

export function kindStatus(kind: DiagnosisKind): Status {
  return { label: KIND_NAME[kind], tone: KIND_TONE[kind] }
}

const FAILED_CONCLUSIONS = new Set([
  'verification-failed',
  'review-cap-reached',
  'failed',
])

/** A finished run's conclusion; an unknown one is shown as stored. */
export function conclusionStatus(key: string): Status {
  return {
    label: CONCLUSION_NAME[key] ?? key,
    tone: FAILED_CONCLUSIONS.has(key) ? 'failed' : 'done',
  }
}

const TRACE_TONE: Record<TraceState, Tone> = {
  done: 'done',
  running: 'running',
  waiting: 'waiting',
  failed: 'failed',
  interrupted: 'done',
  lost: 'done',
  idle: 'done',
}

export function traceStatus(state: TraceState): Status {
  return { label: TRACE_STATE_NAME[state], tone: TRACE_TONE[state] }
}
