import { useMemo } from 'react'

/**
 * Stabilize a value reference using JSON serialization.
 * Prevents re-render loops when callers pass inline arrays/objects.
 */
export function useStableValue<T>(value: T | undefined): T | undefined {
  const key = value !== undefined ? JSON.stringify(value) : undefined
  return useMemo(
    () => (key !== undefined ? (JSON.parse(key) as T) : undefined),
    [key],
  )
}
