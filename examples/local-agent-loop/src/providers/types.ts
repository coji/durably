/**
 * Provider contract + attempt measurement stored in Durably metadata.
 *
 * Requested (input) vs reported (provider-observed) model/effort are stored
 * separately: a value the provider never reported must never be presented as
 * a reported value. Incremental usage snapshots merge via `mergeUsage`
 * (see usage.ts) so a failure preserves already-reported partial numbers.
 */
import type { TokenUsage } from '../usage.js'

export type ProviderName = 'codex' | 'claude' | 'fake'

export type AgentRole = 'implement' | 'review-a' | 'review-b'

export interface AgentResult {
  text: string
  /** Model the provider reports for this call (null when unreported). */
  reportedModel: string | null
  /** Effort the provider reports/confirms (null when unreported). */
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
  /** Durably step signal: cancel / lease-loss aborts the call. */
  signal?: AbortSignal
  /**
   * Called (in order) with incremental usage snapshots when the provider
   * offers them. Providers without partial usage document that constraint
   * instead of fabricating numbers.
   */
  onPartialUsage?: (usage: TokenUsage) => void
}

/** One provider invocation: run the selected local CLI in workdir. */
export interface AgentProvider {
  readonly name: ProviderName
  readonly fake: boolean
  /** True when this provider streams partial usage via onPartialUsage. */
  readonly partialUsage: boolean
  call(options: AgentCallOptions): Promise<AgentResult>
}

/** Persisted per-attempt measurement. Missing values stay null (never 0-filled). */
export interface AttemptMeasurement {
  provider: ProviderName
  fake: boolean
  /** Stage/iteration snapshot — merged, never wholesale-replaced. */
  stage: string | null
  iteration: number | null
  requestedModel: string | null
  requestedEffort: string | null
  reportedModel: string | null
  reportedEffort: string | null
  /** Subprocess/CLI versions at call time (null when unresolvable). */
  versions: Record<string, string | null>
  elapsedMs: number | null
  usage: TokenUsage | null
  /** API-equivalent price estimate; null when usage or pricing unknown. */
  costUsdEstimate: number | null
  costBasis: 'api-equivalent-estimate' | null
  result: string | null
  error: string | null
  /** Why the attempt stopped early (cancel / lease-loss / timeout). */
  interruptionReason: string | null
}
