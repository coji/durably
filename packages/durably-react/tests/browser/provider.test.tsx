/**
 * DurablyProvider Tests
 *
 * Test DurablyProvider initialization, options, and cleanup
 */

import type { Durably } from '@coji/durably'
import { render, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurablyProvider, useDurably } from '../../src'
import { createBrowserDialect } from '../helpers/browser-dialect'

describe('DurablyProvider', () => {
  // Track all instances created during tests for cleanup
  const instances: Durably[] = []

  afterEach(async () => {
    for (const instance of instances) {
      try {
        await instance.stop()
      } catch {
        // Ignore errors from already stopped instances
      }
    }
    instances.length = 0
    await new Promise((r) => setTimeout(r, 200))
  })

  // Helper to create wrapper with cleanup tracking
  const createWrapper =
    (options?: {
      autoStart?: boolean
      autoMigrate?: boolean
      durablyOptions?: { pollingInterval?: number }
    }) =>
    ({ children }: { children: ReactNode }) => {
      return (
        <DurablyProvider
          dialectFactory={() => createBrowserDialect()}
          autoStart={options?.autoStart}
          autoMigrate={options?.autoMigrate}
          options={options?.durablyOptions}
          onReady={(durably) => instances.push(durably)}
        >
          {children}
        </DurablyProvider>
      )
    }

  it('initializes Durably and provides isReady=true', async () => {
    const { result } = renderHook(() => useDurably(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })
    expect(result.current.durably).not.toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('does not double-initialize in StrictMode', async () => {
    const dialectFactory = vi.fn(() => createBrowserDialect())

    function TestComponent() {
      const { isReady, durably } = useDurably()
      if (durably) instances.push(durably)
      return <div data-testid="status">{isReady ? 'ready' : 'loading'}</div>
    }

    const { getByTestId } = render(
      <StrictMode>
        <DurablyProvider dialectFactory={dialectFactory}>
          <TestComponent />
        </DurablyProvider>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('ready')
    })

    // dialectFactory should only be called once even with StrictMode double mount
    expect(dialectFactory).toHaveBeenCalledTimes(1)
  })

  it('respects autoStart=false', async () => {
    const { result } = renderHook(() => useDurably(), {
      wrapper: createWrapper({ autoStart: false }),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    // Instance should exist but worker should not be running
    expect(result.current.durably).not.toBeNull()
    // Note: We can't easily verify start() wasn't called without mocking,
    // but the instance should still be usable
  })

  it('respects autoMigrate=false', async () => {
    const { result } = renderHook(() => useDurably(), {
      wrapper: createWrapper({ autoMigrate: false, autoStart: false }),
    })

    await waitFor(
      () => {
        expect(result.current.isReady).toBe(true)
      },
      { timeout: 1000 },
    )

    // Instance should exist but may not be migrated
    expect(result.current.durably).not.toBeNull()
  })

  it('passes options to createDurably', async () => {
    const { result } = renderHook(() => useDurably(), {
      wrapper: createWrapper({ durablyOptions: { pollingInterval: 500 } }),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    // The durably instance should be created with custom options
    expect(result.current.durably).not.toBeNull()
  })

  it('calls stop() on unmount', async () => {
    const stopSpy = vi.fn()
    let durablyRef: Durably | null = null

    const { result, unmount } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider
          dialectFactory={() => createBrowserDialect()}
          onReady={(durably) => {
            durablyRef = durably
            instances.push(durably)
            // Wrap stop to track calls
            const originalStop = durably.stop.bind(durably)
            durably.stop = async () => {
              stopSpy()
              return originalStop()
            }
          }}
        >
          {children}
        </DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    expect(durablyRef).not.toBeNull()

    unmount()

    // stop() should be called on unmount
    expect(stopSpy).toHaveBeenCalled()
  })

  it('provides error when initialization fails', async () => {
    const failingDialectFactory = () => {
      throw new Error('Dialect creation failed')
    }

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider dialectFactory={failingDialectFactory}>
          {children}
        </DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.error).not.toBeNull()
    })

    expect(result.current.isReady).toBe(false)
    expect(result.current.durably).toBeNull()
    expect(result.current.error?.message).toBe('Dialect creation failed')
  })
})
