/**
 * Provider contract + attempt measurement stored in Durably metadata.
 *
 * Requested input, effective resolved settings, and provider-reported
 * model/effort are stored separately. A value the provider never reported
 * must never be presented as reported. Incremental usage snapshots merge via `mergeUsage`
 * (see usage.ts) so a failure preserves already-reported partial numbers.
 */
import type { TokenUsage } from '../usage.js'

export type ProviderName = 'codex' | 'claude' | 'fake'

/** `triage` is a read-only, one-shot judgment made before any code is written. */
export type AgentRole =
  | 'implement'
  | 'repair'
  | 'review-a'
  | 'review-b'
  | 'triage'

/** Roles every real provider runs without write access. */
export const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set([
  'review-a',
  'review-b',
  'triage',
])

export interface NativeSession {
  id: string
}

export interface AgentResult {
  text: string
  /** Provider-native conversation/thread created or resumed by this call. */
  session?: NativeSession | null
  /**
   * Execution settings actually applied to this call (explicit > env >
   * preset > provider default). Saved to the attempt BEFORE launch as the
   * effective model/effort — never presented as provider-reported.
   */
  resolvedModel: string | null
  resolvedEffort: string | null
  /**
   * Model the provider natively confirms for this call (read from the
   * response object, never assigned from config). Null when the response
   * confirms nothing.
   */
  reportedModel: string | null
  /**
   * Effort the provider natively confirms. CLI providers do not report this
   * back, so real providers leave it null — never back-filled from config.
   */
  reportedEffort: string | null
  usage: TokenUsage | null
  elapsedMs: number | null
}

export interface AgentCallOptions {
  prompt: string
  workdir: string
  /** Upper bound per call (ms). */
  timeoutMs: number
  requestedModel: string | null
  requestedEffort: string | null
  role: AgentRole
  /**
   * A review call's round, from 1. Only the fake provider reads it, to pick
   * a scripted verdict that does not depend on call order.
   */
  reviewRound?: number
  /**
   * Files outside `workdir` a read-only role may read: the candidate's diff
   * and changed-file list, written by the factory. Never writable.
   */
  readableFiles?: string[]
  /** Explicit native session to resume. Null always creates a new conversation. */
  sessionId?: string | null
  /** Durably step signal: cancel / lease-loss aborts the call. */
  signal?: AbortSignal
  /**
   * Called (in order) with incremental usage snapshots when the provider
   * offers them. Providers without partial usage document that constraint
   * instead of fabricating numbers.
   */
  onPartialUsage?: (usage: TokenUsage) => void
}

export interface ResolvedExecution {
  model: string | null
  effort: string | null
}

/** One provider invocation: run the selected local CLI in workdir. */
export interface AgentProvider {
  readonly name: ProviderName
  readonly fake: boolean
  /** True when this provider streams partial usage via onPartialUsage. */
  readonly partialUsage: boolean
  /**
   * Resolve the execution settings (explicit > env > preset > default)
   * WITHOUT launching anything. The runner saves these before the call so
   * the resolved configuration is on record even if the call never reports.
   */
  resolveExecution(requested: {
    requestedModel: string | null
    requestedEffort: string | null
  }): ResolvedExecution
  call(options: AgentCallOptions): Promise<AgentResult>
}

/**
 * Where one physical grading attempt left the check's full output. The exit
 * code is null when the check was killed before it exited (a timeout).
 */
export interface VerificationLog {
  stdoutPath: string
  stderrPath: string
  exitCode: number | null
}

/** Persisted per-attempt measurement. Missing values stay null (never 0-filled). */
export interface AttemptMeasurement {
  provider: ProviderName
  fake: boolean
  /** Stage/iteration snapshot — merged, never wholesale-replaced. */
  stage: string | null
  role?: AgentRole | null
  iteration: number | null
  operationKey?: string | null
  invocationId?: string | null
  sessionId?: string | null
  /** True when a saved completed invocation was read without sending again. */
  recovered?: boolean
  /** Whether usage is for one provider invocation or a larger CLI session. */
  usageScope?: 'invocation' | 'session' | null
  requestedModel: string | null
  requestedEffort: string | null
  effectiveModel: string | null
  effectiveEffort: string | null
  reportedModel: string | null
  reportedEffort: string | null
  /** Original provider invocation interval, retained across recovery. */
  invocationStartedAt?: string | null
  invocationCompletedAt?: string | null
  /** Subprocess/CLI versions at call time (null when unresolvable). */
  versions: Record<string, string | null>
  elapsedMs: number | null
  usage: TokenUsage | null
  /** API-equivalent price estimate; null when usage or pricing unknown. */
  costUsdEstimate: number | null
  costBasis: 'api-equivalent-estimate' | null
  /** Per-meter USD split of `costUsdEstimate`; absent when unpriced. */
  costMeters?: Partial<Record<string, number>> | null
  /** True when cache legs were reported and priced at their own rates. */
  costCacheAware?: boolean | null
  /**
   * Hash of the run's fixed configuration (provider, models, efforts,
   * context mode, instructions version). Runs sharing it are comparable.
   */
  configVersion?: string | null
  result: string | null
  error: string | null
  /** Why the attempt stopped early (cancel / lease-loss / timeout). */
  interruptionReason: string | null
  /** A verification attempt's full check output; absent on LLM calls. */
  verificationLog?: VerificationLog | null
}
