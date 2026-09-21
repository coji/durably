/**
 * Token-usage accounting.
 *
 * - Missing values stay `null` (never zero-filled).
 * - `usageSource` records where the numbers came from; providers that only
 *   report a final number are labeled `provider-final` and partial snapshots
 *   are labeled `provider-partial`.
 * - Aggregation dedupes by attempt id so re-reports never double-count, and
 *   replayed (non-re-executed) steps contribute nothing new.
 */

/** Where a usage number came from. Never fabricated. */
export type UsageSource = 'provider-partial' | 'provider-final' | 'unknown'

export interface TokenUsage {
  inputTokens: number | null
  /** Cached input tokens read (subset of input when known). */
  cachedInputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  usageSource: UsageSource
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usageSource: 'unknown',
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

/**
 * Merge an incremental snapshot into the stored usage.
 *
 * Each field keeps the newest non-null value; `usageSource` escalates
 * `unknown` -> `provider-partial` -> `provider-final` and never downgrades.
 * Field order is the write order, so sequential `setMetadata` calls stay
 * consistent even when a later failure preserves an earlier partial.
 */
export function mergeUsage(
  base: TokenUsage | null,
  patch: Partial<TokenUsage> | null,
): TokenUsage | null {
  if (!patch) return base
  if (!base) {
    return {
      inputTokens: num(patch.inputTokens),
      cachedInputTokens: num(patch.cachedInputTokens),
      outputTokens: num(patch.outputTokens),
      totalTokens: num(patch.totalTokens),
      usageSource: patch.usageSource ?? 'unknown',
    }
  }
  const rank: Record<UsageSource, number> = {
    unknown: 0,
    'provider-partial': 1,
    'provider-final': 2,
  }
  const nextSource = patch.usageSource ?? 'unknown'
  return {
    inputTokens: num(patch.inputTokens) ?? base.inputTokens,
    cachedInputTokens: num(patch.cachedInputTokens) ?? base.cachedInputTokens,
    outputTokens: num(patch.outputTokens) ?? base.outputTokens,
    totalTokens: num(patch.totalTokens) ?? base.totalTokens,
    usageSource:
      rank[nextSource] > rank[base.usageSource] ? nextSource : base.usageSource,
  }
}

/** True when both priced legs are known (partial usage must not be priced). */
export function isCompleteUsage(u: TokenUsage | null): boolean {
  return u !== null && u.inputTokens !== null && u.outputTokens !== null
}

export interface UsageAggregate {
  /** Sums over attempts that reported the leg (confirmed minimums). */
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  /** Attempt ids that contributed (dedupe key). */
  attempts: string[]
  /** Attempt ids with usage === null (missing, not zero). */
  missingAttempts: string[]
  /** False when any contributing attempt lacks a priced leg. */
  complete: boolean
}

/**
 * Sum usage across attempts, counting each attempt id once. Attempts without
 * usage (replayed steps, local tests, failures before any report) are listed
 * under `missingAttempts` — never zero-filled. Each leg sums only the rows
 * that know it; `complete` is false when any contributing attempt lacks a
 * priced leg, so confirmed partial sums are never presented as exact totals.
 */
export function aggregateUsage(
  rows: { attemptId: string; usage: TokenUsage | null }[],
): UsageAggregate {
  const seen = new Set<string>()
  let input = 0
  let cached = 0
  let output = 0
  let total = 0
  let hasInput = false
  let hasCached = false
  let hasOutput = false
  let hasTotal = false
  let complete = true
  const attempts: string[] = []
  const missingAttempts: string[] = []
  for (const row of rows) {
    if (seen.has(row.attemptId)) continue
    seen.add(row.attemptId)
    const u = row.usage
    if (!u) {
      missingAttempts.push(row.attemptId)
      continue
    }
    attempts.push(row.attemptId)
    if (u.inputTokens !== null) {
      input += u.inputTokens
      hasInput = true
    } else {
      complete = false
    }
    if (u.outputTokens !== null) {
      output += u.outputTokens
      hasOutput = true
    } else {
      complete = false
    }
    if (u.cachedInputTokens !== null) {
      cached += u.cachedInputTokens
      hasCached = true
    }
    if (u.totalTokens !== null) {
      total += u.totalTokens
      hasTotal = true
    }
  }
  return {
    inputTokens: hasInput ? input : null,
    cachedInputTokens: hasCached ? cached : null,
    outputTokens: hasOutput ? output : null,
    totalTokens: hasTotal ? total : null,
    attempts,
    missingAttempts,
    complete,
  }
}
