import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDurably, type Durably } from '../../src'
import { createBrowserDialectForName } from '../helpers/browser-dialect'

describe('browser singleton warning', () => {
  const runtimes: Durably[] = []

  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
    await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
    runtimes.length = 0
    vi.restoreAllMocks()
  })

  it('warns when multiple runtimes are created for the same browser-local database in one tab', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const runtimeA = createDurably({
      dialect: createBrowserDialectForName('singleton-warning.sqlite3'),
    })
    const runtimeB = createDurably({
      dialect: createBrowserDialectForName('singleton-warning.sqlite3'),
    })

    runtimes.push(runtimeA, runtimeB)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'Multiple runtimes were created for browser-local store',
    )
  })

  it('does not warn after the previous runtime has been stopped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const firstRuntime = createDurably({
      dialect: createBrowserDialectForName('singleton-reuse.sqlite3'),
    })
    runtimes.push(firstRuntime)

    await firstRuntime.stop()

    const secondRuntime = createDurably({
      dialect: createBrowserDialectForName('singleton-reuse.sqlite3'),
    })
    runtimes.push(secondRuntime)

    expect(warnSpy).not.toHaveBeenCalled()
  })
})
