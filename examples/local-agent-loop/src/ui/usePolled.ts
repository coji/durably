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

const EMPTY: PollState<never> = {
  data: null,
  error: null,
  fetchedAt: null,
  recovered: false,
}

/**
 * Fetch `url` now and every 3 seconds, one request at a time. Leaving the
 * page aborts the request in flight and stops the timer. What another URL
 * answered is never returned, so a page whose URL changed, such as one
 * narrowed to another repository, shows loading until its own answer comes
 * instead of the old answer under the new address.
 */
export function usePolled<T>(url: string): PollState<T> {
  const [state, setState] = useState<{ url: string; poll: PollState<T> }>({
    url,
    poll: EMPTY,
  })
  useEffect(
    () =>
      pollJson<T>(
        url,
        REFRESH_MS,
        (data) =>
          setState((s) => ({
            url,
            poll: {
              data,
              error: null,
              fetchedAt: new Date(),
              recovered:
                s.url === url && (s.poll.recovered || s.poll.error !== null),
            },
          })),
        (error) =>
          setState((s) => ({
            url,
            poll: {
              ...(s.url === url ? s.poll : EMPTY),
              error,
              recovered: false,
            },
          })),
      ),
    [url],
  )
  return state.url === url ? state.poll : EMPTY
}
