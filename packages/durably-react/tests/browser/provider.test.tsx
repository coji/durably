/**
 * DurablyProvider Tests
 *
 * Test DurablyProvider initialization, options, and cleanup
 */

import type { Durably } from '@coji/durably'
import { render, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurablyProvider, useDurably } from '../../src'
import { createTestDurably } from '../helpers/create-test-durably'

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

  it('initializes Durably and provides isReady=true', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider durably={durably}>{children}</DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })
    expect(result.current.durably).toBe(durably)
    expect(result.current.error).toBeNull()
  })

  it('works correctly in StrictMode', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    function TestComponent() {
      const { isReady, durably: d } = useDurably()
      return (
        <div data-testid="status">
          {isReady ? 'ready' : 'loading'}-{d ? 'has-durably' : 'no-durably'}
        </div>
      )
    }

    const { getByTestId } = render(
      <StrictMode>
        <DurablyProvider durably={durably}>
          <TestComponent />
        </DurablyProvider>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('ready-has-durably')
    })
  })

  it('respects autoStart=false', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    // Spy on start to verify it's not called
    const startSpy = vi.spyOn(durably, 'start')

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider durably={durably} autoStart={false}>
          {children}
        </DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    expect(startSpy).not.toHaveBeenCalled()
  })

  it('calls start() by default (autoStart=true)', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    // Spy on start to verify it's called
    const startSpy = vi.spyOn(durably, 'start')

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider durably={durably}>{children}</DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    expect(startSpy).toHaveBeenCalled()
  })

  it('calls onReady callback when ready', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    const onReady = vi.fn()

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider durably={durably} onReady={onReady}>
          {children}
        </DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    expect(onReady).toHaveBeenCalledWith(durably)
  })

  it('provides the same durably instance from useDurably', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider durably={durably}>{children}</DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })

    // Should be the exact same instance
    expect(result.current.durably).toBe(durably)
  })

  it('throws when useDurably is used outside provider', () => {
    expect(() => {
      renderHook(() => useDurably())
    }).toThrow('useDurably must be used within a DurablyProvider')
  })
})
