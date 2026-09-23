/**
 * React StrictMode Tests
 *
 * These tests verify that Durably handles React StrictMode's double mount/unmount
 * behavior safely. StrictMode causes:
 * 1. useEffect to run twice (mount → unmount → mount)
 * 2. Potential race conditions with async initialization
 * 3. Cleanup running before initialization completes
 */

import { render, waitFor } from '@testing-library/react'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDurably, defineJob, type Durably } from '../../src'
import { createBrowserDialect } from '../helpers/browser-dialect'

describe('React StrictMode', () => {
  // Track all instances created during tests for cleanup
  const instances: Durably[] = []

  afterEach(async () => {
    // Clean up all instances - only call stop(), not destroy()
    // destroy() can cause "driver has already been destroyed" errors
    // if there are still pending async operations (like migrations)
    for (const instance of instances) {
      try {
        await instance.stop()
      } catch {
        // Ignore errors from already stopped instances
      }
    }
    instances.length = 0
  })

  it('handles double mount/unmount in StrictMode safely', async () => {
    let mountCount = 0
    let unmountCount = 0

    function TestComponent() {
      const [ready, setReady] = useState(false)
      const cleanedUp = useRef(false)

      useEffect(() => {
        mountCount++
        cleanedUp.current = false
        const instance = createDurably({ dialect: createBrowserDialect() })
        instances.push(instance)

        async function init() {
          try {
            await instance.migrate()
            if (!cleanedUp.current) {
              instance.start()
              setReady(true)
            }
          } catch {
            // Ignore errors if cleaned up
          }
        }
        init()

        return () => {
          unmountCount++
          cleanedUp.current = true
          instance.stop()
        }
      }, [])

      return <div data-testid="status">{ready ? 'ready' : 'loading'}</div>
    }

    const { getByTestId, unmount } = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('ready')
    })

    // StrictMode mounts/unmounts twice in development
    expect(mountCount).toBe(2)
    expect(unmountCount).toBe(1) // First mount's cleanup

    unmount()
    expect(unmountCount).toBe(2) // Final cleanup
  })

  it('singleton pattern prevents duplicate initialization', async () => {
    let sharedInstance: Durably | null = null
    let destroyed = false
    let initCount = 0

    function useDurably() {
      const [instance, setInstance] = useState<Durably | null>(null)

      useEffect(() => {
        if (!sharedInstance) {
          initCount++
          sharedInstance = createDurably({ dialect: createBrowserDialect() })
          instances.push(sharedInstance)
          const localInstance = sharedInstance
          localInstance
            .migrate()
            .then(() => {
              if (!destroyed) {
                localInstance.start()
                setInstance(localInstance)
              }
            })
            .catch(() => {
              // Ignore errors if destroyed
            })
        } else {
          setInstance(sharedInstance)
        }

        return () => {
          // Don't cleanup singleton on unmount
        }
      }, [])

      return instance
    }

    function TestComponent() {
      const instance = useDurably()
      return <div data-testid="status">{instance ? 'ready' : 'loading'}</div>
    }

    const { getByTestId, unmount } = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('ready')
    })

    // Singleton should only be created once even with StrictMode double mount
    expect(initCount).toBe(1)

    // Mark as destroyed before unmount to prevent race conditions
    destroyed = true
    unmount()
  })

  it('migrate() is safe when called concurrently', async () => {
    const durably = createDurably({ dialect: createBrowserDialect() })
    instances.push(durably)

    // Simulate StrictMode double-calling migrate
    const [result1, result2] = await Promise.all([
      durably.migrate(),
      durably.migrate(),
    ])

    // Both should resolve without error
    expect(result1).toBeUndefined()
    expect(result2).toBeUndefined()

    // Database should be usable
    const runs = await durably.storage.getRuns()
    expect(runs).toEqual([])
  })

  it('stop() during migrate() does not cause errors', async () => {
    const durably = createDurably({ dialect: createBrowserDialect() })
    instances.push(durably)

    // Start migration
    const migratePromise = durably.migrate()

    // Immediately call stop (simulates unmount during init)
    const stopPromise = durably.stop()

    // Both should complete without throwing
    await expect(migratePromise).resolves.toBeUndefined()
    await expect(stopPromise).resolves.toBeUndefined()
  })

  it('handles job execution correctly after StrictMode double mount', async () => {
    let executionCount = 0

    function TestComponent() {
      const [result, setResult] = useState<string | null>(null)
      const cleanedUp = useRef(false)

      useEffect(() => {
        cleanedUp.current = false
        const instance = createDurably({
          dialect: createBrowserDialect(),
          pollingIntervalMs: 50,
        })
        instances.push(instance)

        async function init() {
          try {
            await instance.migrate()
            if (cleanedUp.current) return

            const d = instance.register({
              job: defineJob({
                name: 'strict-mode-test',
                input: z.object({ value: z.string() }),
                output: z.object({ processed: z.string() }),
                run: async (_context, input) => {
                  executionCount++
                  return { processed: input.value.toUpperCase() }
                },
              }),
            })

            const run = await d.jobs.job.trigger({ value: 'hello' })
            if (cleanedUp.current) return

            d.start()

            // Wait for completion
            const checkCompletion = async () => {
              if (cleanedUp.current) return
              try {
                const updated = await d.jobs.job.getRun(run.id)
                if (updated?.status === 'completed') {
                  setResult((updated.output as { processed: string }).processed)
                } else if (!cleanedUp.current) {
                  // sleep-ok(poll): re-checks the run until it completes; the
                  // test's waitFor bounds the total wait.
                  setTimeout(checkCompletion, 50)
                }
              } catch {
                // Ignore errors if cleaned up
              }
            }
            checkCompletion()
          } catch {
            // Ignore errors if cleaned up
          }
        }
        init()

        return () => {
          cleanedUp.current = true
          instance.stop()
        }
      }, [])

      return <div data-testid="result">{result ?? 'pending'}</div>
    }

    const { getByTestId } = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>,
    )

    await waitFor(
      () => {
        expect(getByTestId('result').textContent).toBe('HELLO')
      },
      { timeout: 3000 },
    )

    // Each StrictMode mount creates its own instance, so job may run twice
    // This is expected behavior - each instance is independent
    expect(executionCount).toBeGreaterThanOrEqual(1)
  })

  it('event listeners are properly cleaned up on unmount', async () => {
    const events: string[] = []

    function TestComponent() {
      const cleanedUp = useRef(false)

      useEffect(() => {
        cleanedUp.current = false
        const instance = createDurably({
          dialect: createBrowserDialect(),
          pollingIntervalMs: 50,
        })
        instances.push(instance)

        const unsubscribe = instance.on('run:leased', () => {
          events.push('run:leased')
        })

        instance.migrate().then(() => {
          if (cleanedUp.current) return
          const d = instance.register({
            job: defineJob({
              name: 'event-test',
              input: z.object({}),
              run: async () => {},
            }),
          })
          d.jobs.job.trigger({}).then(() => {
            if (!cleanedUp.current) {
              d.start()
            }
          })
        })

        return () => {
          cleanedUp.current = true
          unsubscribe()
          instance.stop()
        }
      }, [])

      return null
    }

    const { unmount } = render(
      <StrictMode>
        <TestComponent />
      </StrictMode>,
    )

    // The listener is live while mounted: the surviving mount's run is leased.
    await waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
    })

    unmount()

    // Every mount unsubscribed in its cleanup, so an event emitted on any
    // instance after unmount reaches no listener.
    const before = events.length
    expect(instances).toHaveLength(2)
    for (const instance of instances) {
      instance.emit({
        type: 'run:leased',
        runId: 'after-unmount',
        jobName: 'event-test',
        input: {},
        leaseOwner: 'test',
        leaseExpiresAt: new Date().toISOString(),
        labels: {},
      })
    }
    expect(events.length).toBe(before)
  })
})
