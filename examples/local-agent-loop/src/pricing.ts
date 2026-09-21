/** API-equivalent price estimates (USD per 1K tokens).
 * These are rough order-of-magnitude labels for local cost comparison only —
 * NOT subscription billing. Unknown models yield null (never guessed).
 */
const PRICE_PER_1K: Record<string, { in: number; out: number }> = {
  'gpt-5': { in: 0.00125, out: 0.01 },
  'gpt-5-codex': { in: 0.00125, out: 0.01 },
  'claude-opus-4-6': { in: 0.015, out: 0.075 },
  'claude-sonnet-4-6': { in: 0.003, out: 0.015 },
}

function matchPrice(model: string | null): { in: number; out: number } | null {
  if (!model) return null
  const key = model.toLowerCase()
  for (const [name, price] of Object.entries(PRICE_PER_1K)) {
    if (key.includes(name)) return price
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
