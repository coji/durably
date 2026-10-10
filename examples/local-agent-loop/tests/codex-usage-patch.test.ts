import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  codexPartialUsage,
  codexRawUsage,
  watchActivity,
} from '../src/engine/providers/codex.js'
import type { TokenUsage } from '../src/engine/usage.js'

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

describe('codex usage before the turn finishes (ADR-0034)', () => {
  it('still hands raw notifications and the session to the caller', async () => {
    // The running usage and the early thread id depend on these; a provider
    // update that drops them would silently lose a stopped call's usage.
    const source = await providerSource()
    assert.match(source, /this\.emitter\.emitRaw\(method, params\);/)
    assert.match(
      source,
      /emitRaw\(method, params, id\) \{\s*if \(!this\.options\.includeRawChunks\) return;/,
    )
    assert.match(
      source,
      /resolveIncludeRawChunks\(\s*options\.includeRawChunks,/,
    )
    assert.match(source, /"thread\/tokenUsage\/updated": \(params\) =>/)
    assert.match(source, /await onSessionCreated\(session\);/)
  })

  const update = (
    last: Record<string, number>,
    total?: Record<string, number>,
  ) => ({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 't',
      turnId: 'u',
      tokenUsage: { last, ...(total ? { total } : {}) },
    },
  })
  const counts = (input: number, cached: number, output: number) => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  })

  it("sums the turn's growth as a running total, never a resumed thread's earlier turns", () => {
    const read = codexPartialUsage(() => 'unknown')
    // A resumed thread: its total already holds 10,000 earlier tokens.
    const first = read(update(counts(100, 50, 10), counts(10_100, 9_050, 510)))
    assert.equal(first?.inputTokens, 100)
    assert.equal(first?.cacheReadTokens, 50)
    assert.equal(first?.outputTokens, 10)
    assert.equal(first?.usageSource, 'provider-partial')
    const second = read(
      update(counts(300, 200, 20), counts(10_400, 9_250, 530)),
    )
    assert.equal(second?.inputTokens, 400)
    assert.equal(second?.cacheReadTokens, 250)
    assert.equal(second?.outputTokens, 30)
    assert.equal(second?.totalTokens, 430)
  })

  it('adds each response without a total, and nothing for an update without tokens or another notification', () => {
    const read = codexPartialUsage(() => 'unknown')
    assert.equal(read(update(counts(0, 0, 0))), null)
    assert.equal(read({ method: 'item/started', params: {} }), null)
    assert.equal(read(update(counts(100, 0, 10)))?.inputTokens, 100)
    assert.equal(read(update(counts(50, 0, 5)))?.inputTokens, 150)
  })

  it('takes a reported zero cache write only with an API key', () => {
    const withWrite = { ...counts(100, 0, 10), cacheWriteInputTokens: 0 }
    assert.equal(
      codexPartialUsage(() => 'chatgpt')(update(withWrite))?.cacheWriteTokens,
      null,
    )
    assert.equal(
      codexPartialUsage(() => 'api-key')(update(withWrite))?.cacheWriteTokens,
      0,
    )
  })

  it('asks the stream for raw notifications and takes them out of it, never as activity', async () => {
    let asked: unknown = null
    const parts = [
      { type: 'stream-start' },
      { type: 'raw', rawValue: update(counts(100, 0, 10)) },
      { type: 'text-delta', id: 't', delta: 'hi' },
      { type: 'finish' },
    ]
    const model = {
      doStream: async (options?: unknown) => {
        asked = options
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part)
              controller.close()
            },
          }),
        }
      },
    }
    const raws: unknown[] = []
    let activity = 0
    const watched = watchActivity(
      model,
      () => activity++,
      undefined,
      (raw) => raws.push(raw),
    )
    const { stream } = await watched.doStream({ prompt: [] })
    const seen: string[] = []
    for await (const part of stream as unknown as AsyncIterable<{
      type: string
    }>)
      seen.push(part.type)
    assert.deepEqual(asked, { prompt: [], includeRawChunks: true })
    assert.deepEqual(seen, ['stream-start', 'text-delta', 'finish'])
    assert.equal(raws.length, 1)
    assert.equal(activity, 1)
  })
  it('restarts the idle timer only through a usage report with tokens, never through any other raw notification', async () => {
    // What a Codex call wires up: raw notifications to `onRaw`, usage
    // reports to `onPartialUsage`. The runner restarts the idle timer on
    // `onActivity` and on `onPartialUsage` (ADR-0032), so neither may hear
    // a raw notification that is not a usage update with model tokens.
    const raw = (rawValue: unknown) => ({ type: 'raw', rawValue })
    const parts = [
      { type: 'stream-start' },
      raw({ method: 'rawResponseItem/completed', params: { threadId: 't' } }),
      raw({ method: 'item/started', params: { threadId: 't', turnId: 'u' } }),
      raw(update(counts(0, 0, 0), counts(0, 0, 0))),
      raw({ method: 'turn/started', params: { threadId: 't' } }),
      { type: 'finish' },
    ]
    // `watchActivity` replaces the model's own `doStream`, so each run
    // watches a model of its own.
    const model = () => ({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }),
    })
    let activity = 0
    const reports: [TokenUsage, Record<string, TokenUsage> | undefined][] = []
    const watched = watchActivity(
      model(),
      () => activity++,
      undefined,
      codexRawUsage(
        codexPartialUsage(() => 'unknown'),
        'gpt-model',
        (u, m) => reports.push([u, m]),
      ),
    )
    const { stream } = await watched.doStream()
    for await (const _ of stream as unknown as AsyncIterable<unknown>);
    assert.equal(activity, 0)
    assert.equal(reports.length, 0)

    // A usage update with tokens is a report, split under the call's
    // model, and still not activity.
    parts.splice(1, 0, raw(update(counts(100, 0, 10), counts(100, 0, 10))))
    const again = watchActivity(
      model(),
      () => activity++,
      undefined,
      codexRawUsage(
        codexPartialUsage(() => 'unknown'),
        'gpt-model',
        (u, m) => reports.push([u, m]),
      ),
    )
    const second = await again.doStream()
    for await (const _ of second.stream as unknown as AsyncIterable<unknown>);
    assert.equal(activity, 0)
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.[0].inputTokens, 100)
    assert.deepEqual(Object.keys(reports[0]?.[1] ?? {}), ['gpt-model'])
  })
})
