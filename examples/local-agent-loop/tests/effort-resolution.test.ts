import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ClaudeProvider, resolveClaudeEffort } from '../src/providers/claude.js'
import { CodexProvider, resolveCodexEffort } from '../src/providers/codex.js'
import type { AgentCallOptions } from '../src/providers/types.js'

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

  it('lets an explicit model carry its preset effort', () => {
    const resolved = new CodexProvider().resolveExecution({
      requestedModel: 'gpt-5.6-luna',
      requestedEffort: null,
    })
    assert.equal(resolved.model, 'gpt-5.6-luna')
    assert.equal(resolved.effort, 'max')
  })
})
