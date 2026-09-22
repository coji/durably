import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ClaudeProvider,
  resolveClaudeEffort,
} from '../src/engine/providers/claude.js'
import {
  CodexProvider,
  resolveCodexEffort,
} from '../src/engine/providers/codex.js'
import type { AgentCallOptions } from '../src/engine/providers/types.js'

/**
 * Names that resolution must ignore. `CLAUDE_EFFORT` is the sharp one: Claude
 * Code exports it into the shell it runs commands in, so honouring it would
 * tie a run's effort to the effort of whichever agent session launched it —
 * invisible in the command, invisible in the shell history, and enough to
 * split otherwise-identical runs across config versions.
 */
const AMBIENT_NAMES = [
  'MODEL',
  'CODEX_MODEL',
  'CODEX_EFFORT',
  'CLAUDE_MODEL',
  'CLAUDE_EFFORT',
] as const

function withAmbientEnv(body: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const key of AMBIENT_NAMES) {
    saved.set(key, process.env[key])
    process.env[key] = key.endsWith('EFFORT') ? 'max' : 'llama3'
  }
  try {
    body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function opts(over: Partial<AgentCallOptions> = {}): AgentCallOptions {
  return {
    prompt: 'p',
    workdir: '/tmp',
    timeoutMs: 1000,
    requestedModel: null,
    requestedEffort: null,
    role: 'implement',
    sessionId: null,
    ...over,
  }
}

describe('effort resolution against the effective model', () => {
  it('applies the preset of the provider default model', () => {
    assert.equal(resolveCodexEffort(opts(), 'gpt-5.6-sol'), 'low')
    assert.equal(resolveClaudeEffort(opts(), 'claude-opus-5'), 'high')
  })

  it('an explicit effort still wins over the preset', () => {
    assert.equal(
      resolveCodexEffort(opts({ requestedEffort: 'high' }), 'gpt-5.6-sol'),
      'high',
    )
  })

  it('rejects unsupported effort instead of silently dropping it', () => {
    assert.throws(
      () =>
        resolveCodexEffort(opts({ requestedEffort: 'turbo' }), 'gpt-5.6-sol'),
      /unsupported Codex effort/,
    )
    assert.throws(
      () =>
        resolveClaudeEffort(
          opts({ requestedEffort: 'turbo' }),
          'claude-opus-5',
        ),
      /unsupported Claude effort/,
    )
  })
})

describe('resolveExecution (resolved settings, saved before launch)', () => {
  it('falls back to the provider default model and its preset effort', () => {
    const codex = new CodexProvider().resolveExecution({
      requestedModel: null,
      requestedEffort: null,
    })
    assert.equal(codex.model, 'gpt-5.6-sol')
    assert.equal(codex.effort, 'low')
    const claude = new ClaudeProvider().resolveExecution({
      requestedModel: null,
      requestedEffort: null,
    })
    assert.equal(claude.model, 'claude-sonnet-5')
    assert.equal(claude.effort, 'high')
  })

  it('ignores every ambient model and effort variable', () => {
    withAmbientEnv(() => {
      const codex = new CodexProvider().resolveExecution({
        requestedModel: null,
        requestedEffort: null,
      })
      assert.deepEqual(codex, { model: 'gpt-5.6-sol', effort: 'low' })
      const claude = new ClaudeProvider().resolveExecution({
        requestedModel: null,
        requestedEffort: null,
      })
      assert.deepEqual(claude, { model: 'claude-sonnet-5', effort: 'high' })
      // An explicit flag still wins; only the environment is ignored.
      assert.equal(
        new CodexProvider().resolveExecution({
          requestedModel: 'gpt-5.6-luna',
          requestedEffort: 'medium',
        }).effort,
        'medium',
      )
    })
  })

  it('lets an explicit model carry its preset effort', () => {
    const resolved = new CodexProvider().resolveExecution({
      requestedModel: 'gpt-5.6-luna',
      requestedEffort: null,
    })
    assert.equal(resolved.model, 'gpt-5.6-luna')
    assert.equal(resolved.effort, 'max')
  })
})
