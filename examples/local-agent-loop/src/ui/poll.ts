/**
 * Run `load` now and again every `intervalMs`, never two at once: the next
 * call is scheduled only after the previous one settles, so a slow response
 * delays the next refresh instead of stacking requests. The returned stop
 * function aborts the call in flight and cancels the next one.
 */
export function pollEvery(
  load: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    const started = Date.now()
    try {
      await load(controller.signal)
    } catch {
      // `load` reports its own failures; polling goes on.
    }
    if (controller.signal.aborted) return
    timer = setTimeout(
      () => void tick(),
      Math.max(0, intervalMs - (Date.now() - started)),
    )
  }
  void tick()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}

/**
 * Poll a JSON endpoint of the UI API. `onData` gets each body; `onError`
 * gets the message of a failed refresh (never for one cut short by stop).
 */
export function pollJson<T>(
  url: string,
  intervalMs: number,
  onData: (body: T) => void,
  onError: (message: string) => void,
): () => void {
  return pollEvery(async (signal) => {
    try {
      const res = await fetch(url, { signal, cache: 'no-store' })
      const body = (await res.json()) as T & { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      onData(body)
    } catch (error) {
      if (!signal.aborted) onError((error as Error).message)
    }
  }, intervalMs)
}

/** One read of a log endpoint: `LogChunk` in `server.ts`. */
export interface LogPart {
  chunk: string
  nextOffset: number
  done: boolean
}

/** The status a log endpoint answers when the recorded file is gone. */
const LOG_MISSING = 410

/**
 * Read a log endpoint from byte 0, one request at a time: again at once
 * while a read returns more, then every `intervalMs`, until a read says it
 * is done or the file is missing. Each outcome goes to its handler; the
 * returned function stops it.
 */
export function followLogParts(
  url: string,
  intervalMs: number,
  on: {
    part: (part: LogPart) => void
    missing: () => void
    error: () => void
  },
): () => void {
  let offset = 0
  const stop = pollEvery(async (signal) => {
    try {
      for (;;) {
        const res = await fetch(`${url}&from=${offset}`, {
          signal,
          cache: 'no-store',
        })
        if (res.status === LOG_MISSING) {
          on.missing()
          return stop()
        }
        const body = (await res.json()) as LogPart & { error?: string }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        offset = body.nextOffset
        on.part(body)
        if (body.done) return stop()
        if (body.chunk === '') return
      }
    } catch {
      if (!signal.aborted) on.error()
    }
  }, intervalMs)
  return stop
}
