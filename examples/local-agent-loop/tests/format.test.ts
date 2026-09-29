import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatCost,
  formatCount,
  formatDuration,
  formatRelative,
  formatShortId,
  formatTick,
  formatTokens,
  formatters,
  UNKNOWN,
  unknownWord,
} from '../src/engine/format.js'

const MISSING = [null, undefined, Number.NaN, Infinity, -Infinity]

describe('formatCost', () => {
  it('shows dollars and cents', () => {
    assert.equal(formatCost(6.443984), '$6.44')
    assert.equal(formatCost(0), '$0.00')
    assert.equal(formatCost(12.5), '$12.50')
    assert.equal(formatCost(0.019), '$0.02')
  })

  it('never shows a known cost below a cent as zero', () => {
    assert.equal(formatCost(0.0004), '<$0.01')
    assert.equal(formatCost(0.004999), '<$0.01')
  })

  it('says unknown for a missing value, never 0', () => {
    for (const v of MISSING) assert.equal(formatCost(v), UNKNOWN)
    assert.equal(UNKNOWN, '不明')
  })
})

describe('formatTokens', () => {
  it('shortens large counts to K, M and B', () => {
    assert.equal(formatTokens(5_123_456), '5.1M')
    assert.equal(formatTokens(940), '940')
    assert.equal(formatTokens(0), '0')
    assert.equal(formatTokens(1_000), '1.0K')
    assert.equal(formatTokens(12_400), '12.4K')
    assert.equal(formatTokens(123_456), '123K')
    assert.equal(formatTokens(2_300_000_000), '2.3B')
  })

  it('moves a value that rounds to 1000 of a unit to the next unit', () => {
    assert.equal(formatTokens(999_960), '1.0M')
    assert.equal(formatTokens(99_960), '100K')
  })

  it('says unknown for a missing value', () => {
    for (const v of MISSING) assert.equal(formatTokens(v), UNKNOWN)
  })
})

describe('formatCount', () => {
  it('groups thousands and rounds like compare', () => {
    assert.equal(formatCount(12_345), '12,345')
    assert.equal(formatCount(2.5), '3')
    assert.equal(formatCount(0), '0')
    for (const v of MISSING) assert.equal(formatCount(v), UNKNOWN)
  })
})

describe('formatDuration', () => {
  it('shows minutes and seconds in Japanese', () => {
    assert.equal(formatDuration(1_093_000), '18分13秒')
    assert.equal(formatDuration(60_000), '1分')
    assert.equal(formatDuration(42_400), '42秒')
    assert.equal(formatDuration(4_200), '4.2秒')
    assert.equal(formatDuration(3_000), '3秒')
    assert.equal(formatDuration(7_500_000), '2時間5分')
    assert.equal(formatDuration(3_600_000), '1時間')
    assert.equal(formatDuration(3 * 86_400_000 + 4 * 3_600_000), '3日4時間')
  })

  it('never prints milliseconds or a bare zero for a short time', () => {
    assert.equal(formatDuration(0), '0秒')
    assert.equal(formatDuration(40), '0.1秒未満')
    assert.equal(formatDuration(360), '0.4秒')
    assert.equal(formatDuration(9_960), '10秒')
    assert.equal(formatDuration(59_600), '1分')
    for (const ms of [0, 40, 360, 1_093_000])
      assert.doesNotMatch(formatDuration(ms), /ms/)
  })

  it('says unknown for a missing or negative value', () => {
    for (const v of [...MISSING, -1]) assert.equal(formatDuration(v), UNKNOWN)
  })

  it('writes axis ticks as durations from a bare 0', () => {
    assert.equal(formatTick(0), '0')
    assert.equal(formatTick(30_000), '30秒')
    assert.equal(formatTick(90_000), '1分30秒')
  })
})

describe('formatRelative', () => {
  const now = '2026-09-30T12:00:00.000Z'
  it('says how long ago from the given now', () => {
    assert.equal(formatRelative('2026-09-30T11:59:50.000Z', now), '10秒前')
    assert.equal(formatRelative('2026-09-30T11:57:00.000Z', now), '3分前')
    assert.equal(formatRelative('2026-09-30T09:00:00.000Z', now), '3時間前')
    assert.equal(formatRelative('2026-09-28T12:00:00.000Z', now), '2日前')
  })

  it('treats a time just after now, from clock skew, as now', () => {
    assert.equal(formatRelative('2026-09-30T12:00:05.000Z', now), '0秒前')
  })

  it('says unknown for a missing or unreadable time', () => {
    for (const iso of [null, undefined, '', 'yesterday'])
      assert.equal(formatRelative(iso, now), UNKNOWN)
    assert.equal(formatRelative('2026-09-30T11:00:00.000Z', 'bad'), UNKNOWN)
  })
})

describe('formatShortId', () => {
  it('keeps the last six characters', () => {
    assert.equal(formatShortId('01K5ZQ8X7MABCDEF'), '…ABCDEF')
    assert.equal(formatShortId(null), UNKNOWN)
    assert.equal(formatShortId(''), UNKNOWN)
  })
})

describe('English forms', () => {
  it('writes durations in English with the same rounding', () => {
    const en = (ms: number | null) => formatDuration(ms, 'en')
    assert.equal(en(1_093_000), '18m 13s')
    assert.equal(en(60_000), '1m')
    assert.equal(en(42_400), '42s')
    assert.equal(en(4_200), '4.2s')
    assert.equal(en(7_500_000), '2h 5m')
    assert.equal(en(3_600_000), '1h')
    assert.equal(en(3 * 86_400_000 + 4 * 3_600_000), '3d 4h')
    assert.equal(en(0), '0s')
    assert.equal(en(40), '<0.1s')
    assert.equal(en(9_960), '10s')
    assert.equal(en(59_600), '1m')
    assert.equal(en(null), 'unknown')
    assert.equal(en(-1), 'unknown')
    assert.equal(formatTick(0, 'en'), '0')
    assert.equal(formatTick(90_000, 'en'), '1m 30s')
  })

  it('writes relative time and missing values in English', () => {
    const now = '2026-09-30T12:00:00.000Z'
    assert.equal(
      formatRelative('2026-09-30T11:59:50.000Z', now, 'en'),
      '10 sec ago',
    )
    assert.equal(
      formatRelative('2026-09-30T11:57:00.000Z', now, 'en'),
      '3 min ago',
    )
    assert.equal(
      formatRelative('2026-09-30T09:00:00.000Z', now, 'en'),
      '3 h ago',
    )
    assert.equal(
      formatRelative('2026-09-28T12:00:00.000Z', now, 'en'),
      '2 d ago',
    )
    assert.equal(formatRelative(null, now, 'en'), 'unknown')
    assert.equal(formatCost(null, 'en'), 'unknown')
    assert.equal(formatTokens(undefined, 'en'), 'unknown')
    assert.equal(formatCount(Number.NaN, 'en'), 'unknown')
    assert.equal(formatShortId(null, 'en'), 'unknown')
    assert.equal(unknownWord('en'), 'unknown')
    assert.equal(unknownWord(), UNKNOWN)
  })

  it('reads cost and tokens the same in both languages', () => {
    for (const v of [0, 0.0004, 6.443984, 12.5])
      assert.equal(formatCost(v, 'en'), formatCost(v, 'ja'))
    for (const v of [0, 940, 12_400, 999_960, 5_123_456])
      assert.equal(formatTokens(v, 'en'), formatTokens(v, 'ja'))
    assert.equal(formatCount(12_345, 'en'), formatCount(12_345, 'ja'))
  })

  it('binds a language once with formatters()', () => {
    const en = formatters('en')
    assert.equal(en.formatDuration(1_093_000), '18m 13s')
    assert.equal(en.unknown, 'unknown')
    assert.equal(formatters('ja').formatDuration(1_093_000), '18分13秒')
  })
})
