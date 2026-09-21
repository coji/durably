/** API-equivalent price estimates (USD per 1K tokens).
 * Sources (checked 2026-09-21): OpenAI docs / openai.com pricing posts for
 * gpt-6-astra ($10/$50 per 1M), gpt-5.6-sol ($5/$30), gpt-5.6-luna ($0.20/$1.20);
 * Anthropic docs and Sep-2026 pricing roundups for claude-fable-5-1 ($10/$50),
 * claude-opus-5 ($5/$25), claude-sonnet-5 ($2/$10, introductory rate permanent).
 * Comparison labels for local cost reasoning only — NOT subscription billing.
 * Unknown models yield null (never guessed).
 */
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

export function estimateCostUsd(
  model: string | null,
  usage: { inputTokens: number | null; outputTokens: number | null } | null,
): number | null {
  if (!usage) return null
  if (usage.inputTokens == null && usage.outputTokens == null) return null
  const price = matchPrice(model)
  if (!price) return null
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  if (usage.inputTokens == null && usage.outputTokens == null) return null
  return (input / 1000) * price.in + (output / 1000) * price.out
}
