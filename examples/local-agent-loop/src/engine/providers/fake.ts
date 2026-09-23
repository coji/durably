/**
 * Fake provider: deterministic local behavior for loop/kill reproduction.
 * NEVER counts as real-LLM verification. Marked fake:true everywhere.
 *
 * Honors AbortSignal (sleep becomes rejectable) so cancel/kill paths are
 * exercisable without a real CLI.
 *
 * Resolved and reported model/effort are both the fixed fake label (there is
 * no native response to read); fake rows never count as real-LLM verification.
 *
 * Env controls (tests / rehearsal only):
 * - FAKE_FAIL_FIRST=0 ......... iteration 1 implement already fixes the bug
 * - FAKE_REVIEW_SEQUENCE ...... comma list consumed per review call, e.g.
 *   "needsChanges,pass,pass" (default: every review passes). Entries may be
 *   `pass`, `needsChanges`, `invalid` (garbled output), or `empty`.
 * - FAKE_REVIEW_SLOW_MS ....... extra delay (ms) on review-b for kill tests
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentCallOptions, AgentProvider, AgentResult } from './types.js'

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

function nextReviewDecision(): string {
  const seq = (process.env.FAKE_REVIEW_SEQUENCE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (seq.length === 0) return 'pass'
  const head = seq[0] ?? 'pass'
  process.env.FAKE_REVIEW_SEQUENCE = seq.slice(1).join(',')
  return head
}

export class FakeProvider implements AgentProvider {
  readonly name = 'fake' as const
  readonly fake = true
  readonly partialUsage = false

  resolveExecution(): { model: string | null; effort: string | null } {
    return { model: 'fake-model', effort: 'low' }
  }

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    await sleep(50, options.signal)
    if (options.role === 'implement' || options.role === 'repair') {
      const iter = options.prompt.match(/iteration (\d+)/)?.[1] ?? '1'
      const failFirst = process.env.FAKE_FAIL_FIRST !== '0'
      const shouldFail = failFirst && iter === '1'
      if (shouldFail) {
        return {
          text: 'fake: left the bug in place (simulated first-iteration miss)',
          session: { id: options.sessionId ?? `fake-${randomUUID()}` },
          resolvedModel: 'fake-model',
          resolvedEffort: 'low',
          reportedModel: 'fake-model',
          reportedEffort: 'low',
          usage: null,
          elapsedMs: Date.now() - started,
        }
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
      return {
        text: 'fake: fixed add() to return a + b',
        session: { id: options.sessionId ?? `fake-${randomUUID()}` },
        resolvedModel: 'fake-model',
        resolvedEffort: 'low',
        reportedModel: 'fake-model',
        reportedEffort: 'low',
        usage: null,
        elapsedMs: Date.now() - started,
      }
    }
    const slow = process.env.FAKE_REVIEW_SLOW_MS
    if (options.role === 'review-b' && slow) {
      await sleep(parseInt(slow, 10), options.signal)
    }
    const decision = nextReviewDecision()
    if (decision === 'empty') {
      return {
        text: '',
        session: { id: `fake-${randomUUID()}` },
        resolvedModel: 'fake-model',
        resolvedEffort: 'low',
        reportedModel: 'fake-model',
        reportedEffort: 'low',
        usage: null,
        elapsedMs: Date.now() - started,
      }
    }
    if (decision === 'invalid') {
      return {
        text: 'looks good to me, ship it (no structured verdict)',
        session: { id: `fake-${randomUUID()}` },
        resolvedModel: 'fake-model',
        resolvedEffort: 'low',
        reportedModel: 'fake-model',
        reportedEffort: 'low',
        usage: null,
        elapsedMs: Date.now() - started,
      }
    }
    return {
      text: `PLAN: fake plan\nCOUNTEREXAMPLE: fake counterexample, none found\nDECISION: ${decision}\nNOTES: fake ${options.role ?? 'review'} deterministic ${decision}`,
      session: { id: `fake-${randomUUID()}` },
      resolvedModel: 'fake-model',
      resolvedEffort: 'low',
      reportedModel: 'fake-model',
      reportedEffort: 'low',
      usage: null,
      elapsedMs: Date.now() - started,
    }
  }
}
