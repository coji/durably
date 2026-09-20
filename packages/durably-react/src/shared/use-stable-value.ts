import { useMemo } from 'react'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
    )
  }
  return value
}

/**
 * Stabilize a value reference using JSON serialization.
 * Prevents re-render loops when callers pass inline arrays/objects.
 */
export function useStableValue<T>(value: T | undefined): T | undefined {
  const key =
    value !== undefined ? JSON.stringify(canonicalize(value)) : undefined
  return useMemo(
    () => (key !== undefined ? (JSON.parse(key) as T) : undefined),
    [key],
  )
}
