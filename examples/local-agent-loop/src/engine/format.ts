/**
 * How a person reads the factory's quantities: cost, tokens, time, when,
 * and which run. The web UI and the Markdown of `report` and `compare` use
 * these, so the same number is rounded the same way everywhere. JSON output
 * keeps the raw values and never goes through here.
 *
 * Every function takes a `lang`: `'ja'` (the default) is for the web UI and
 * `'en'` is for the English Markdown. Only the words differ; the rounding
 * rules are one implementation. Cost and tokens read the same in both.
 * `formatters(lang)` returns the set bound to one language, for a caller that
 * uses one language throughout.
 *
 * A value that is missing or not a usable number is `不明` / `unknown`,
 * never `0`.
 */

export type Lang = 'ja' | 'en'

const UNKNOWN_WORD: Record<Lang, string> = { ja: '不明', en: 'unknown' }

/** The Japanese word for a missing value, as the UI writes it. */
export const UNKNOWN = UNKNOWN_WORD.ja

/** The word for a missing value in `lang`. */
export function unknownWord(lang: Lang = 'ja'): string {
  return UNKNOWN_WORD[lang]
}

type Maybe = number | null | undefined

function known(v: Maybe): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** `$6.44`; a known cost too small to show in cents is `<$0.01`, not `$0.00`. */
export function formatCost(usd: Maybe, lang: Lang = 'ja'): string {
  if (!known(usd)) return unknownWord(lang)
  if (usd > 0 && usd < 0.005) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

const TOKEN_UNITS: [number, string][] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

/**
 * `940`, `12.4K`, `5.1M`: one decimal below 100 of a unit, none above.
 * A value that rounds up to the next unit is written in that unit.
 */
export function formatTokens(tokens: Maybe, lang: Lang = 'ja'): string {
  if (!known(tokens)) return unknownWord(lang)
  const n = Math.round(tokens)
  for (const [i, [size, unit]] of TOKEN_UNITS.entries()) {
    if (Math.abs(n) < size) continue
    const v = n / size
    // 999,960 would read 1000K; it is written one unit up, as 1.0M.
    const up = TOKEN_UNITS[i - 1]
    if (Math.abs(v) >= 999.5 && up) return `${(n / up[0]).toFixed(1)}${up[1]}`
    return `${v.toFixed(Math.abs(v) < 99.95 ? 1 : 0)}${unit}`
  }
  return String(n)
}

/** A whole count with thousands separators, rounded as compare rounds it. */
export function formatCount(v: Maybe, lang: Lang = 'ja'): string {
  if (!known(v)) return unknownWord(lang)
  return Number(v.toFixed(0)).toLocaleString('en-US')
}

const DURATION_UNITS = {
  ja: { s: '秒', m: '分', h: '時間', d: '日', gap: '', tiny: '0.1秒未満' },
  en: { s: 's', m: 'm', h: 'h', d: 'd', gap: ' ', tiny: '<0.1s' },
}

/**
 * `18分13秒` / `18m 13s`, `2時間5分` / `2h 5m`, `3日4時間` / `3d 4h`. Under ten
 * seconds keeps a tenth of a second; under a tenth it says so
 * (`0.1秒未満` / `<0.1s`) rather than printing `0`. A zero part at the end is
 * dropped: `1分`, not `1分0秒`.
 */
export function formatDuration(ms: Maybe, lang: Lang = 'ja'): string {
  if (!known(ms) || ms < 0) return unknownWord(lang)
  const u = DURATION_UNITS[lang]
  if (ms === 0) return `0${u.s}`
  if (ms < 100) return u.tiny
  if (ms < 9950) return `${trimZero((ms / 1000).toFixed(1))}${u.s}`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}${u.s}`
  const m = Math.floor(s / 60)
  if (m < 60) return pair(m, u.m, s % 60, u.s, u.gap)
  const h = Math.floor(m / 60)
  if (h < 24) return pair(h, u.h, m % 60, u.m, u.gap)
  return pair(Math.floor(h / 24), u.d, h % 24, u.h, u.gap)
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

function pair(
  big: number,
  bigUnit: string,
  small: number,
  smallUnit: string,
  gap: string,
) {
  return small === 0
    ? `${big}${bigUnit}`
    : `${big}${bigUnit}${gap}${small}${smallUnit}`
}

/** An axis tick: the origin is a bare `0`, every other tick a duration. */
export function formatTick(ms: number, lang: Lang = 'ja'): string {
  return ms === 0 ? '0' : formatDuration(ms, lang)
}

const AGO = {
  ja: (n: number, unit: 's' | 'm' | 'h' | 'd') =>
    `${n}${{ s: '秒', m: '分', h: '時間', d: '日' }[unit]}前`,
  en: (n: number, unit: 's' | 'm' | 'h' | 'd') =>
    `${n} ${{ s: 'sec', m: 'min', h: 'h', d: 'd' }[unit]} ago`,
}

/**
 * `3分前` / `3 min ago` from `now`. Both are ISO strings (the server's clock,
 * not the browser's). A time slightly after `now`, from clock skew, is
 * `0秒前` / `0 sec ago`.
 */
export function formatRelative(
  iso: string | null | undefined,
  now: string,
  lang: Lang = 'ja',
) {
  const diff = Date.parse(now) - Date.parse(iso ?? '')
  if (!Number.isFinite(diff)) return unknownWord(lang)
  const ago = AGO[lang]
  const s = Math.max(0, Math.floor(diff / 1000))
  if (s < 60) return ago(s, 's')
  const m = Math.floor(s / 60)
  if (m < 60) return ago(m, 'm')
  const h = Math.floor(m / 60)
  if (h < 24) return ago(h, 'h')
  return ago(Math.floor(h / 24), 'd')
}

/** `67%`: a share from 0 to 1, rounded to a whole percent. */
export function formatPercent(share: Maybe, lang: Lang = 'ja'): string {
  if (!known(share)) return unknownWord(lang)
  return `${Math.round(share * 100)}%`
}

/**
 * A week by its first day, `YYYY-MM-DD` as the trend keys it: `9/28〜` in
 * Japanese, `week of 2026-09-28` in English.
 */
export function formatWeek(
  weekStart: string | null | undefined,
  lang: Lang = 'ja',
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart ?? '')
  if (!m) return unknownWord(lang)
  return lang === 'ja'
    ? `${Number(m[2])}/${Number(m[3])}〜`
    : `week of ${weekStart}`
}

/** The last six characters of an ID: enough to tell runs apart. */
export function formatShortId(
  id: string | null | undefined,
  lang: Lang = 'ja',
): string {
  return id ? `…${id.slice(-6)}` : unknownWord(lang)
}

/**
 * The formatters bound to one language, each taking just the value. Use it
 * where a function is passed as a callback or one language is used throughout.
 */
export function formatters(lang: Lang) {
  return {
    unknown: unknownWord(lang),
    formatCost: (usd: Maybe) => formatCost(usd, lang),
    formatTokens: (tokens: Maybe) => formatTokens(tokens, lang),
    formatCount: (v: Maybe) => formatCount(v, lang),
    formatDuration: (ms: Maybe) => formatDuration(ms, lang),
    formatTick: (ms: number) => formatTick(ms, lang),
    formatRelative: (iso: string | null | undefined, now: string) =>
      formatRelative(iso, now, lang),
    formatShortId: (id: string | null | undefined) => formatShortId(id, lang),
    formatPercent: (share: Maybe) => formatPercent(share, lang),
    formatWeek: (weekStart: string | null | undefined) =>
      formatWeek(weekStart, lang),
  }
}
