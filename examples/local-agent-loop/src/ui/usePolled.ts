import { useEffect, useState } from 'react'

import { pollJson } from './poll'

const REFRESH_MS = 3000

export interface PollState<T> {
  data: T | null
  /** Set while the latest refresh failed; the last data stays on screen. */
  error: string | null
  fetchedAt: Date | null
  /** Set once a refresh works again after failing, until the next failure. */
  recovered: boolean
}

/**
 * Fetch `url` now and every 3 seconds, one request at a time. Leaving the
 * page aborts the request in flight and stops the timer.
 */
export function usePolled<T>(url: string): PollState<T> {
  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: null,
    fetchedAt: null,
    recovered: false,
  })
  useEffect(
    () =>
      pollJson<T>(
        url,
        REFRESH_MS,
        (data) =>
          setState((s) => ({
            data,
            error: null,
            fetchedAt: new Date(),
            recovered: s.recovered || s.error !== null,
          })),
        (error) => setState((s) => ({ ...s, error, recovered: false })),
      ),
    [url],
  )
  return state
}
