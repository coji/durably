import { useEffect, useMemo, useState } from 'react'

/**
 * The response's `now`, advanced by the time since it arrived, every second
 * while the run is open. It never reads the browser's wall clock, so a skewed
 * laptop clock cannot move the bars.
 */
export function useLiveNow(serverNow: string, open: boolean): number {
  const base = useMemo(
    () => ({ server: Date.parse(serverNow), client: performance.now() }),
    [serverNow],
  )
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [open])
  return open
    ? base.server + Math.max(0, performance.now() - base.client)
    : base.server
}
