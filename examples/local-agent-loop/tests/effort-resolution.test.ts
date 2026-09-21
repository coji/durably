import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveClaudeEffort } from '../src/providers/claude.js'
import { resolveCodexEffort } from '../src/providers/codex.js'
import type { AgentCallOptions } from '../src/providers/types.js'

function opts(over: Partial<AgentCallOptions> = {}): AgentCallOptions {
  return {
    prompt: 'p',
    workdir: '/tmp',
    timeoutMs: 1000,
    requestedModel: null,
    requestedEffort: null,
    role: 'implement',
    ...over,
  }
}

describe('effort resolution against the effective model', () => {
  it('applies the preset of the provider default model', () => {
    assert.equal(resolveCodexEffort(opts(), 'gpt-5.6-sol'), 'low')
    assert.equal(resolveClaudeEffort(opts(), 'claude-opus-5'), 'high')
  })

  it('explicit and env values still win over presets', () => {
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
