/** Fake provider: deterministic local behavior for loop/kill reproduction.
 * NEVER counts as real-LLM verification. Marked fake:true everywhere.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentCallOptions, AgentProvider, AgentResult } from './types.js'

const FAIL_FIRST = process.env.FAKE_FAIL_FIRST !== '0'

export class FakeProvider implements AgentProvider {
  readonly name = 'fake' as const
  readonly fake = true

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    await new Promise((r) => setTimeout(r, 50))
    if (options.role === 'implement') {
      const iter = options.prompt.match(/iteration (\d+)/)?.[1] ?? '1'
      const shouldFail = FAIL_FIRST && iter === '1'
      if (shouldFail) {
        return {
          text: 'fake: left the bug in place (simulated first-iteration miss)',
          model: 'fake-model',
          effort: 'low',
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
        model: 'fake-model',
        effort: 'low',
        usage: null,
        elapsedMs: Date.now() - started,
      }
    }
    const slow = process.env.FAKE_REVIEW_SLOW_MS
    if (options.role === 'review-b' && slow) {
      await new Promise((r) => setTimeout(r, parseInt(slow, 10)))
    }
    const decision = options.role === 'review-a' ? 'pass' : 'pass'
    return {
      text: `DECISION: ${decision}\nNOTES: fake ${options.role ?? 'review'} deterministic pass`,
      model: 'fake-model',
      effort: 'low',
      usage: null,
      elapsedMs: Date.now() - started,
    }
  }
}
