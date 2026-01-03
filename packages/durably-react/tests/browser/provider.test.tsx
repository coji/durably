/**
 * DurablyProvider Tests
 *
 * Test DurablyProvider initialization and context
 */

import type { Durably } from '@coji/durably'
import { render, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('provides Durably instance via context', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider durably={durably}>{children}</DurablyProvider>
      ),
    })

    expect(result.current.durably).toBe(durably)
  })

  it('works correctly in StrictMode', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    function TestComponent() {
      const { durably: d } = useDurably()
      return <div data-testid="status">{d ? 'has-durably' : 'no-durably'}</div>
    }

    const { getByTestId } = render(
      <StrictMode>
        <DurablyProvider durably={durably}>
          <TestComponent />
        </DurablyProvider>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('has-durably')
    })
  })

  it('provides the same durably instance from useDurably', async () => {
    const durably = await createTestDurably()
    instances.push(durably)

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider durably={durably}>{children}</DurablyProvider>
      ),
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
