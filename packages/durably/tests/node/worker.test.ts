import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorker } from '../../src/worker'
import { createNodeDialect } from '../helpers/node-dialect'
import { createWorkerTests } from '../shared/worker.shared'

createWorkerTests(createNodeDialect)

describe('createWorker scheduler (direct)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never keeps more than one delayed poll for pollingIntervalMs while idle', async () => {
    const processOne = vi.fn().mockResolvedValue(false)
    const onIdle = vi.fn().mockResolvedValue(undefined)
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const worker = createWorker(
      { pollingIntervalMs: 1000, maxConcurrentRuns: 2 },
      processOne,
      onIdle,
    )
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    const pollTimeouts = spy.mock.calls.filter(
      (c) => typeof c[1] === 'number' && (c[1] as number) === 1000,
    )
    expect(pollTimeouts.length).toBeLessThanOrEqual(1)
    spy.mockRestore()
    await worker.stop()
  })

  it('does not exceed maxConcurrentRuns concurrent processOne invocations', async () => {
    let inFlight = 0
    let peak = 0
    let calls = 0
    const processOne = vi.fn(async () => {
      calls++
      if (calls > 8) {
        return false
      }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
      inFlight--
      return calls <= 2
    })
    const worker = createWorker(
      { pollingIntervalMs: 10_000, maxConcurrentRuns: 2 },
      processOne,
    )
    worker.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(peak).toBeLessThanOrEqual(2)
    await worker.stop()
  })

  it('refills a slot immediately after work completes without waiting for pollingIntervalMs', async () => {
    let calls = 0
    const processOne = vi.fn(async () => {
      calls++
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100)
        })
        return true
      }
      return false
    })
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const worker = createWorker(
      { pollingIntervalMs: 50_000, maxConcurrentRuns: 1 },
      processOne,
    )
    worker.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(processOne).toHaveBeenCalledTimes(2)
    const pollTimeouts = spy.mock.calls.filter(
      (c) => typeof c[1] === 'number' && (c[1] as number) === 50_000,
    )
    expect(pollTimeouts.length).toBeLessThanOrEqual(1)
    spy.mockRestore()
    await worker.stop()
  })

  it('does not stack overlapping delayed polls across idle cycles', async () => {
    const processOne = vi.fn().mockResolvedValue(false)
    const worker = createWorker(
      { pollingIntervalMs: 1000, maxConcurrentRuns: 1 },
      processOne,
    )
    const spy = vi.spyOn(globalThis, 'setTimeout')
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    spy.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(0)
    const pollTimeouts = spy.mock.calls.filter(
      (c) => typeof c[1] === 'number' && (c[1] as number) === 1000,
    )
    expect(pollTimeouts.length).toBeLessThanOrEqual(1)
    spy.mockRestore()
    await worker.stop()
  })
})
