/**
 * API-equivalent price estimates (USD per 1K tokens).
 *
 * Comparison labels for local cost reasoning only — NOT subscription billing.
 * Unknown models, and usage missing either priced leg, yield null (never
 * zero-filled, never priced from a partial leg).
 */
export const PRICE_BASIS = {
  source:
    'OpenAI docs / openai.com pricing posts; Anthropic docs + Sep-2026 pricing roundups',
  checkedAt: '2026-09-21',
  basis: 'api-equivalent-estimate',
} as const

const PRICE_PER_1K: Record<string, { in: number; out: number }> = {
  'gpt-6-astra': { in: 0.01, out: 0.05 },
  'gpt-5.6-sol': { in: 0.005, out: 0.03 },
  'gpt-5.6-luna': { in: 0.0002, out: 0.0012 },
  'claude-fable-5-1': { in: 0.01, out: 0.05 },
  'claude-opus-5': { in: 0.005, out: 0.025 },
  'claude-sonnet-5': { in: 0.002, out: 0.01 },
  'gpt-5-codex': { in: 0.00125, out: 0.01 },
  'gpt-5': { in: 0.00125, out: 0.01 },
  'claude-opus-4-6': { in: 0.015, out: 0.075 },
  'claude-sonnet-4-6': { in: 0.003, out: 0.015 },
}

function matchPrice(model: string | null): { in: number; out: number } | null {
  if (!model) return null
  const key = model.toLowerCase()
  const names = Object.keys(PRICE_PER_1K).sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (key.includes(name)) return PRICE_PER_1K[name]
  }
  return null
}

/**
 * Estimate cost only when the model is known AND both priced legs
 * (input + output) are known. Anything else is `null` (unknown) —
 * a partial leg must never read as a complete cost.
 */
export function estimateCostUsd(
  model: string | null,
  usage: { inputTokens: number | null; outputTokens: number | null } | null,
): number | null {
  if (!usage) return null
  if (usage.inputTokens == null || usage.outputTokens == null) return null
  const price = matchPrice(model)
  if (!price) return null
  return (
    (usage.inputTokens / 1000) * price.in +
    (usage.outputTokens / 1000) * price.out
  )
}
