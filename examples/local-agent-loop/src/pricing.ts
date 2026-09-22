/**
 * API-equivalent price estimates (USD per 1K tokens).
 *
 * Comparison labels for local cost reasoning only — NOT subscription billing.
 * Unknown models, and usage missing either priced leg, yield null (never
 * zero-filled, never priced from a partial leg).
 *
 * Meters follow the AI SDK v7 usage contract: `inputTokens` is the whole
 * prompt, and cache read/write tokens are subsets of it. When a provider
 * reports the cache legs, the non-cached remainder is billed at the input
 * rate and each cache leg at its own multiplier. When it reports none, the
 * whole input is billed at the input rate and the breakdown says so.
 */
export const PRICE_BASIS = {
  source:
    'OpenAI docs / openai.com pricing posts; Anthropic docs + Sep-2026 pricing roundups',
  checkedAt: '2026-09-21',
  basis: 'api-equivalent-estimate',
} as const

/** Named price meters, one per billable token kind. */
export const PRICING_METERS = [
  'input_tokens',
  'input_cache_read_tokens',
  'input_cache_write_tokens',
  'output_tokens',
] as const
export type PricingMeter = (typeof PRICING_METERS)[number]

interface ModelPrice {
  in: number
  out: number
  /** Cache read price as a multiple of `in`. */
  cacheRead: number
  /** Cache write price as a multiple of `in` (OpenAI charges no premium). */
  cacheWrite: number
}

const OPENAI_CACHE = { cacheRead: 0.1, cacheWrite: 1 }
const ANTHROPIC_CACHE = { cacheRead: 0.1, cacheWrite: 1.25 }

const PRICE_PER_1K: Record<string, ModelPrice> = {
  'gpt-6-astra': { in: 0.01, out: 0.05, ...OPENAI_CACHE },
  'gpt-5.6-sol': { in: 0.005, out: 0.03, ...OPENAI_CACHE },
  'gpt-5.6-luna': { in: 0.0002, out: 0.0012, ...OPENAI_CACHE },
  'claude-fable-5-1': { in: 0.01, out: 0.05, ...ANTHROPIC_CACHE },
  'claude-opus-5': { in: 0.005, out: 0.025, ...ANTHROPIC_CACHE },
  'claude-sonnet-5': { in: 0.002, out: 0.01, ...ANTHROPIC_CACHE },
  'gpt-5-codex': { in: 0.00125, out: 0.01, ...OPENAI_CACHE },
  'gpt-5': { in: 0.00125, out: 0.01, ...OPENAI_CACHE },
  'claude-opus-4-6': { in: 0.015, out: 0.075, ...ANTHROPIC_CACHE },
  'claude-sonnet-4-6': { in: 0.003, out: 0.015, ...ANTHROPIC_CACHE },
}

function matchPrice(model: string | null): ModelPrice | null {
  if (!model) return null
  const key = model.toLowerCase()
  const names = Object.keys(PRICE_PER_1K).sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (key.includes(name)) return PRICE_PER_1K[name]
  }
  return null
}

export interface PriceableUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

export interface CostBreakdown {
  totalUsd: number
  /** USD billed per meter; a meter the provider never reported is absent. */
  meters: Partial<Record<PricingMeter, number>>
  /** False when no cache leg was reported and the whole input was priced flat. */
  cacheAware: boolean
}

/**
 * Price a complete usage row per meter. Null when the model is unknown or
 * either priced leg (input + output) is missing — a partial leg must never
 * read as a complete cost.
 */
export function estimateCostBreakdown(
  model: string | null,
  usage: PriceableUsage | null,
): CostBreakdown | null {
  if (!usage) return null
  if (usage.inputTokens == null || usage.outputTokens == null) return null
  const price = matchPrice(model)
  if (!price) return null
  const cacheRead = usage.cacheReadTokens ?? null
  const cacheWrite = usage.cacheWriteTokens ?? null
  const cacheAware = cacheRead !== null || cacheWrite !== null
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0)
  // Providers that report cache legs count them inside inputTokens; never let
  // an inconsistent report produce a negative non-cached remainder.
  const nonCached = Math.max(0, usage.inputTokens - cached)
  const meters: Partial<Record<PricingMeter, number>> = {
    input_tokens: (nonCached / 1000) * price.in,
    output_tokens: (usage.outputTokens / 1000) * price.out,
  }
  if (cacheRead !== null)
    meters.input_cache_read_tokens =
      (cacheRead / 1000) * price.in * price.cacheRead
  if (cacheWrite !== null)
    meters.input_cache_write_tokens =
      (cacheWrite / 1000) * price.in * price.cacheWrite
  const totalUsd = Object.values(meters).reduce((sum, v) => sum + v, 0)
  return { totalUsd, meters, cacheAware }
}

/** Total of `estimateCostBreakdown`; null under the same conditions. */
export function estimateCostUsd(
  model: string | null,
  usage: PriceableUsage | null,
): number | null {
  return estimateCostBreakdown(model, usage)?.totalUsd ?? null
}
