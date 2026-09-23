import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  codexCacheWriteTokens,
  parseCodexAuthMode,
} from '../src/engine/providers/codex.js'

describe('codex cache-write reporting', () => {
  it('does not believe a zero from a ChatGPT login', () => {
    // The server returns 0 for every subscription request, including ones
    // that demonstrably wrote the cache (openai/codex#32479). Reporting that
    // as zero would price the 1.25x write premium out of the estimate.
    assert.equal(codexCacheWriteTokens(0, 'chatgpt'), null)
    assert.equal(codexCacheWriteTokens(0, 'unknown'), null)
  })

  it('believes a zero from an API key, where the value is real', () => {
    assert.equal(codexCacheWriteTokens(0, 'api-key'), 0)
  })

  it('always takes a positive count, whatever the login', () => {
    for (const auth of ['chatgpt', 'api-key', 'unknown'] as const) {
      assert.equal(codexCacheWriteTokens(1234, auth), 1234)
    }
  })

  it('keeps an absent value unknown', () => {
    assert.equal(codexCacheWriteTokens(undefined, 'api-key'), null)
    assert.equal(codexCacheWriteTokens(null, 'api-key'), null)
  })

  it('classifies the login status messages Codex actually prints', () => {
    // Strings from codex-rs/cli/src/login.rs.
    assert.equal(parseCodexAuthMode('Logged in using ChatGPT\n'), 'chatgpt')
    assert.equal(
      parseCodexAuthMode('Logged in using an API key - sk-proj-***abcd\n'),
      'api-key',
    )
    // Modes whose cache-write behaviour is unverified stay unknown, so a
    // zero from them is not believed either.
    for (const other of [
      'Logged in using Amazon Bedrock API key',
      'Logged in using Amazon Bedrock AWS access keys',
      'Logged in using access token',
      'Logged in using personal access token',
      'Logged in using workload identity',
      'Not logged in',
      '',
    ]) {
      assert.equal(parseCodexAuthMode(other), 'unknown', other)
    }
  })
})
