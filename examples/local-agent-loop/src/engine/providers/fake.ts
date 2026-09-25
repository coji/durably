/**
 * Fake provider: deterministic local behavior for loop/kill reproduction.
 * NEVER counts as real-LLM verification. Marked fake:true everywhere.
 *
 * Honors AbortSignal (sleep becomes rejectable) so cancel/kill paths are
 * exercisable without a real CLI.
 *
 * Resolved model/effort are always the fixed fake label (there is no native
 * response to read); fake rows never count as real-LLM verification.
 *
 * Env controls (tests / rehearsal only):
 * - FAKE_FAIL_FIRST=0 ......... iteration 1 implement already fixes the bug
 * - FAKE_REVIEW_SEQUENCE ...... comma list consumed per review call, e.g.
 *   "needsChanges,pass,pass" (default: every review passes). Entries may be
 *   `pass`, `needsChanges`, `invalid` (garbled output), or `empty`.
 * - FAKE_REVIEW_SLOW_MS ....... extra delay (ms) on review-b for kill tests
 * - FAKE_TRIAGE ............... comma list consumed per triage call (default:
 *   every triage answers `routine`). Entries may be `routine`, `probe`,
 *   `empty`, `invalid` (no JUDGMENT line), `contradictory` (two judgments),
 *   `unsupported` (a judgment outside the closed set), or `error` (the call
 *   itself fails).
 * - FAKE_LATENCY_MS ........... `<min>-<max>` (or one number): each call waits
 *   a random duration in that range instead of 50ms, and stops at once when
 *   the call is aborted or times out.
 * - FAKE_USAGE=realistic ...... each call reports plausible token usage for
 *   its role. The reported model is then the role's requested model, so the
 *   existing price table prices it. Without it usage stays null, as before.
 *
 * Preflight is decided by the role's requested model, so one run can hold a
 * usable and an unusable profile:
 * - `unlisted-*` ............. the free check refuses it, and no call is made
 * - `probe-*` ................ the free check cannot tell; the minimal call
 *   answers OK
 * - `refused-*` .............. the free check cannot tell; the minimal call
 *   is refused outright, as an unknown model would be
 * - `rejects-*` .............. the free check accepts it, and every later
 *   call (implement, repair, review or triage) is refused outright, as a
 *   revoked login or a spent quota would be
 * - anything else ............ the free check accepts it
 *
 * A run can carry a `FakeScenario` in its input (demo seeding only). Its
 * fields override the matching env knob for that run alone, so runs in one
 * worker can behave differently. Its review verdicts are read by round and
 * lens, not consumed, so a replay after a restart gives the same answers.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type { TokenUsage } from '../usage.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
  AgentRole,
  AvailabilityCheck,
  AvailabilityRequest,
} from './types.js'

export const FAKE_REVIEW_DECISIONS = [
  'pass',
  'needsChanges',
  'invalid',
  'empty',
] as const
export const FAKE_TRIAGE_KINDS = [
  'routine',
  'probe',
  'empty',
  'invalid',
  'contradictory',
  'unsupported',
  'error',
] as const

/** Per-run fake behavior. Every field is optional; absent means "use env". */
export interface FakeScenario {
  /** Leading implement iterations that leave the bug in place. */
  failIterations?: number
  /**
   * Verdicts in pairs, one pair per review round: correctness, then
   * edge-cases. Round r's lens l reads entry `2(r-1)+l`, so the verdict never
   * depends on which lens answers first or on a replay after a restart.
   */
  reviewSequence?: (typeof FAKE_REVIEW_DECISIONS)[number][]
  /** NOTES text for each review call, indexed like `reviewSequence`. */
  reviewNotes?: string[]
  triage?: (typeof FAKE_TRIAGE_KINDS)[number][]
  /** REASON text for a `routine` or `probe` triage answer. */
  triageReason?: string
  latencyMs?: { min: number; max: number }
  usage?: 'none' | 'realistic'
  /** Summary the implementer returns when it makes the change. */
  summary?: string
  /** Files written into the workdir, relative paths, on a successful implement. */
  changes?: Record<string, string>
}

/** Per-run state shared by every fake provider instance of one run. */
export class FakeRun {
  private readonly triages: string[]
  constructor(readonly scenario: FakeScenario) {
    this.triages = [...(scenario.triage ?? [])]
  }
  /** The scripted verdict and note for one lens in one round, if any. */
  review(round: number, role: AgentRole): { decision?: string; note?: string } {
    const at = 2 * (round - 1) + (role === 'review-b' ? 1 : 0)
    return {
      decision: this.scenario.reviewSequence?.[at],
      note: this.scenario.reviewNotes?.[at],
    }
  }
  nextTriage(): string | undefined {
    return this.scenario.triage ? this.triages.shift() : undefined
  }
}

export interface FakeProviderOptions {
  run?: FakeRun | null
  /** The role's requested model: what realistic usage is reported and priced as. */
  requestedModel?: string | null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('fake call cancelled before start'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('fake call cancelled (lease lost or run cancelled)'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Consume the head of a comma-list env var, or `fallback` when it is empty. */
function nextFromEnv(name: string, fallback: string): string {
  const [head, ...rest] = (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (head === undefined) return fallback
  process.env[name] = rest.join(',')
  return head
}

/** Parse `FAKE_LATENCY_MS`: `<min>-<max>` or one number. Null when unset. */
export function parseLatency(
  raw: string | undefined,
): { min: number; max: number } | null {
  if (raw === undefined || raw.trim() === '') return null
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(raw)
  if (!m) throw new Error(`FAKE_LATENCY_MS must be <min>-<max> (got ${raw})`)
  const min = Number(m[1])
  const max = m[2] === undefined ? min : Number(m[2])
  if (max < min) throw new Error(`FAKE_LATENCY_MS: max ${max} < min ${min}`)
  return { min, max }
}

const randomIn = (min: number, max: number) =>
  Math.round(min + Math.random() * (max - min))

/**
 * Token ranges per role for one agent CLI invocation: input is the sum over
 * every model turn in the call, most of it served from cache.
 */
const USAGE_RANGES: Record<
  AgentRole,
  { input: [number, number]; output: [number, number] }
> = {
  implement: { input: [450_000, 1_300_000], output: [9_000, 28_000] },
  repair: { input: [180_000, 600_000], output: [4_000, 13_000] },
  'review-a': { input: [120_000, 360_000], output: [2_500, 8_000] },
  'review-b': { input: [120_000, 360_000], output: [2_500, 8_000] },
  triage: { input: [7_000, 18_000], output: [250, 900] },
  preflight: { input: [6_000, 9_000], output: [2, 8] },
}

/**
 * Thrown by a minimal preflight call on a `refused-*` model, and by every
 * call after preflight on a `rejects-*` model.
 */
class FakeRefusal extends Error {
  readonly fakeRefusal = true
}

/**
 * Plausible usage for one call. Claude reports cache writes; Codex on a
 * ChatGPT login does not, so its cache write stays unknown, as it does for a
 * real Codex call.
 */
export function realisticUsage(
  role: AgentRole,
  model: string | null,
): TokenUsage {
  const range = USAGE_RANGES[role]
  const input = randomIn(...range.input)
  const output = randomIn(...range.output)
  const cacheRead = Math.round(input * (0.78 + Math.random() * 0.16))
  const claude = (model ?? '').toLowerCase().startsWith('claude')
  const cacheWrite = claude
    ? Math.min(input - cacheRead, Math.round(input * 0.04))
    : null
  return {
    inputTokens: input,
    cachedInputTokens: cacheRead,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    totalTokens: input + output,
    usageSource: 'provider-final',
  }
}

const TRIAGE_TEXT: Record<string, string> = {
  routine:
    'JUDGMENT: routine\nREASON: fake triage: a one-line fix with a pinned check.',
  probe:
    'JUDGMENT: probe\nREASON: fake triage: treat this task as risky and try it first.',
  empty: '',
  invalid: 'this looks easy enough (no structured judgment)',
  contradictory:
    'JUDGMENT: routine\nJUDGMENT: probe\nREASON: fake triage could not decide.',
  unsupported: 'JUDGMENT: escalate\nREASON: fake triage wants a person.',
}

export class FakeProvider implements AgentProvider {
  readonly name = 'fake' as const
  readonly fake = true
  readonly cliPath = null
  readonly partialUsage = false
  private readonly run: FakeRun | null
  private readonly requestedModel: string | null

  constructor(options: FakeProviderOptions = {}) {
    this.run = options.run ?? null
    this.requestedModel = options.requestedModel ?? null
  }

  resolveExecution(): { model: string | null; effort: string | null } {
    return { model: 'fake-model', effort: 'low' }
  }

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    const scenario = this.run?.scenario ?? {}
    const latency =
      scenario.latencyMs ?? parseLatency(process.env.FAKE_LATENCY_MS)
    await sleep(
      latency ? randomIn(latency.min, latency.max) : 50,
      options.signal,
    )
    const realistic = (scenario.usage ?? process.env.FAKE_USAGE) === 'realistic'
    const reportedModel = realistic
      ? (this.requestedModel ?? 'fake-model')
      : 'fake-model'
    if (
      options.role !== 'preflight' &&
      this.requestedModel?.startsWith('rejects-')
    )
      throw new FakeRefusal(
        `fake: the ${options.role} call on ${this.requestedModel} is refused`,
      )
    const result = (text: string, sessionId?: string): AgentResult => ({
      text,
      session: { id: sessionId ?? `fake-${randomUUID()}` },
      resolvedModel: 'fake-model',
      resolvedEffort: 'low',
      reportedModel,
      reportedEffort: 'low',
      usage: realistic ? realisticUsage(options.role, reportedModel) : null,
      elapsedMs: Date.now() - started,
    })

    if (options.role === 'implement' || options.role === 'repair') {
      const iter = options.prompt.match(/iteration (\d+)/)?.[1] ?? '1'
      const failIterations =
        scenario.failIterations ?? (process.env.FAKE_FAIL_FIRST !== '0' ? 1 : 0)
      if (Number(iter) <= failIterations) {
        return result(
          'fake: left the bug in place (simulated first-iteration miss)',
          options.sessionId ?? undefined,
        )
      }
      const target = join(options.workdir, 'src', 'calc.js')
      try {
        const current = await readFile(target, 'utf8')
        if (current.includes('Math.trunc')) {
          await mkdir(join(options.workdir, 'src'), { recursive: true })
          await writeFile(
            target,
            current.replace(
              'return Math.trunc(a) + Math.trunc(b)',
              'return a + b',
            ),
          )
        }
      } catch {
        // leave as-is; test step will report the failure
      }
      for (const [path, content] of Object.entries(scenario.changes ?? {})) {
        const dest = resolve(options.workdir, path)
        if (relative(options.workdir, dest).startsWith('..'))
          throw new Error(`fake scenario change escapes the workdir: ${path}`)
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, content)
      }
      return result(
        scenario.summary ?? 'fake: fixed add() to return a + b',
        options.sessionId ?? undefined,
      )
    }
    if (options.role === 'preflight') {
      if (this.requestedModel?.startsWith('refused-'))
        throw new FakeRefusal(
          `fake: model ${this.requestedModel} is not supported`,
        )
      return result('OK')
    }
    if (options.role === 'triage') {
      const kind =
        this.run?.nextTriage() ?? nextFromEnv('FAKE_TRIAGE', 'routine')
      if (kind === 'error') throw new Error('fake triage call failed')
      if (scenario.triageReason && (kind === 'routine' || kind === 'probe'))
        return result(`JUDGMENT: ${kind}\nREASON: ${scenario.triageReason}`)
      return result(TRIAGE_TEXT[kind] ?? TRIAGE_TEXT['routine'] ?? '')
    }
    const slow = process.env.FAKE_REVIEW_SLOW_MS
    if (options.role === 'review-b' && slow) {
      await sleep(parseInt(slow, 10), options.signal)
    }
    const scripted = this.run?.review(options.reviewRound ?? 1, options.role)
    const decision =
      scripted?.decision ?? nextFromEnv('FAKE_REVIEW_SEQUENCE', 'pass')
    if (decision === 'empty') return result('')
    if (decision === 'invalid')
      return result('looks good to me, ship it (no structured verdict)')
    const notes =
      scripted?.note ??
      `fake ${options.role ?? 'review'} deterministic ${decision}`
    return result(
      `PLAN: fake plan\nCOUNTEREXAMPLE: fake counterexample, none found\nDECISION: ${decision}\nNOTES: ${notes}`,
    )
  }

  async checkAvailability(
    request: AvailabilityRequest,
  ): Promise<AvailabilityCheck> {
    const model = request.requestedModel ?? 'fake-model'
    const method = 'fake list'
    if (model.startsWith('unlisted-'))
      return {
        verdict: 'unavailable',
        method,
        detail: `${model} is not in the fake model list`,
      }
    if (model.startsWith('probe-') || model.startsWith('refused-'))
      return {
        verdict: 'unknown',
        method,
        detail: `the fake list cannot tell about ${model}`,
      }
    return { verdict: 'available', method, detail: `${model} is listed` }
  }

  rejectionReason(error: unknown): string | null {
    return error instanceof FakeRefusal ? error.message : null
  }
}
