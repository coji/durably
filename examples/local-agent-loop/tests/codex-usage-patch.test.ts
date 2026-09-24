import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

async function providerSource(): Promise<string> {
  const entry = fileURLToPath(import.meta.resolve('ai-sdk-provider-codex-cli'))
  return await readFile(entry, 'utf8')
}

describe('codex provider usage accounting', () => {
  it('sums usage across the turn instead of keeping the last response', async () => {
    // ai-sdk-provider-codex-cli@2.2.1 overwrote its usage on every
    // `thread/tokenUsage/updated` event, so an invocation reported only its
    // final model response. The first real run of this factory recorded
    // $0.114 for work Codex's own log put at $1.79. A local patch fixed that
    // until 2.3.0 shipped the fix upstream; this guards against a provider
    // update that brings the overwrite back.
    const source = await providerSource()
    assert.match(
      source,
      /this\.usage = addCodexUsage\(this\.usage, nextUsage\)/,
      'the Codex provider no longer sums usage across the turn',
    )
    // The increment is taken against the thread total from before this turn,
    // so a reused thread does not charge earlier calls to this one.
    assert.match(source, /getTokenUsageTotalBeforeTurn\(turnId\)/)
  })

  it('reads cache writes instead of claiming zero', async () => {
    // `cacheWriteInputTokens` is optional in the app-server protocol. The
    // 2.2.1 mapping hard-coded `cacheWrite: 0`, which both discarded a
    // reported value and asserted zero when nothing was reported.
    const source = await providerSource()
    assert.doesNotMatch(source, /cacheWrite: 0\b/)
    assert.match(source, /increment\.cacheWriteInputTokens/)
    assert.match(source, /reported\.cache_write_input_tokens/)
  })
})
