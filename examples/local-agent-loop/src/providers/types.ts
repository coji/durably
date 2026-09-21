/** Provider contract + attempt measurement stored in Durably metadata. */
export type ProviderName = 'codex' | 'claude' | 'fake'

export interface TokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface AgentResult {
  text: string
  model: string | null
  effort: string | null
  usage: TokenUsage | null
  elapsedMs: number | null
}

export interface AgentCallOptions {
  prompt: string
  workdir: string
  /** Upper bound per subprocess call (ms). */
  timeoutMs: number
  model?: string
  effort?: string
  /** Extra hint for review vs implement prompts. */
  role?: 'implement' | 'review-a' | 'review-b'
}

/** One provider invocation: run a local CLI subprocess in workdir. */
export interface AgentProvider {
  readonly name: ProviderName
  readonly fake: boolean
  call(options: AgentCallOptions): Promise<AgentResult>
}

/** Persisted per-attempt measurement. Missing values stay null (never 0-filled). */
export interface AttemptMeasurement {
  provider: ProviderName
  fake: boolean
  model: string | null
  effort: string | null
  elapsedMs: number | null
  usage: TokenUsage | null
  /** API-equivalent price estimate; null when usage or pricing unknown. */
  costUsdEstimate: number | null
  costBasis: 'api-equivalent-estimate' | null
  result: string | null
  error: string | null
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: null, outputTokens: null, totalTokens: null }
}
