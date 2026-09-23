import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

describe('codex provider usage accounting', () => {
  it('runs with the local patch that sums usage across the turn', async () => {
    // ai-sdk-provider-codex-cli@2.2.1 overwrites its usage on every
    // `thread/tokenUsage/updated` event, so an invocation reports only its
    // final model response. The first real run of this factory recorded
    // $0.114 for work Codex's own log put at $1.79. patches/ fixes that; this
    // guards against the patch being dropped without anyone noticing, since
    // removing both the patch file and its workspace entry is silent.
    const entry = fileURLToPath(
      import.meta.resolve('ai-sdk-provider-codex-cli'),
    )
    const source = await readFile(entry, 'utf8')
    assert.match(
      source,
      /this\.usage = accumulateAppServerUsage\(this\.usage, nextUsage\)/,
      'the Codex provider reports only the last response again; see patches/ai-sdk-provider-codex-cli@2.2.1.patch',
    )
  })
})
