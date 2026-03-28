/**
 * Worker configuration
 */
export interface WorkerConfig {
  pollingIntervalMs: number
  /**
   * Maximum number of concurrent `processOne()` invocations. Default is `1` (sequential).
   */
  maxConcurrentRuns: number
}

/**
 * Worker state
 */
export interface Worker {
  start(options?: { workerId?: string }): void
  stop(): Promise<void>
  readonly isRunning: boolean
}

/**
 * Create a thin worker loop around processOne().
 */
export function createWorker(
  config: WorkerConfig,
  processOne: (options?: { workerId?: string }) => Promise<boolean>,
  onIdle?: () => Promise<void>,
): Worker {
  const maxConcurrentRuns = config.maxConcurrentRuns
  let running = false
  let pollingTimeout: ReturnType<typeof setTimeout> | null = null
  let activeCount = 0
  let activeWorkerId: string | undefined
  const activePromises = new Set<Promise<void>>()
  let idleMaintenanceInFlight: Promise<void> | null = null

  function scheduleDelayedPoll(): void {
    if (!running) {
      return
    }
    if (pollingTimeout) {
      clearTimeout(pollingTimeout)
      pollingTimeout = null
    }
    pollingTimeout = setTimeout(() => {
      pollingTimeout = null
      if (running) {
        fillSlots()
      }
    }, config.pollingIntervalMs)
  }

  async function runIdleMaintenanceSafe(): Promise<void> {
    if (!onIdle) {
      return
    }
    const cycle = (async () => {
      try {
        await onIdle()
      } catch {
        // onIdle errors are non-fatal; allow polling to continue
      }
    })()
    idleMaintenanceInFlight = cycle
    try {
      await cycle
    } finally {
      if (idleMaintenanceInFlight === cycle) {
        idleMaintenanceInFlight = null
      }
    }
  }

  async function processSlotCycle(): Promise<void> {
    try {
      const didProcess = await processOne({ workerId: activeWorkerId })
      activeCount--
      if (didProcess && running) {
        // Work was found — immediately try to refill slots
        fillSlots()
      } else if (!didProcess && activeCount === 0 && running) {
        // All slots idle — run maintenance then schedule a delayed poll
        await runIdleMaintenanceSafe()
        if (running) {
          scheduleDelayedPoll()
        }
      }
      // Otherwise (!didProcess, other slots still active): do nothing — let the
      // remaining active slots handle idle detection when they finish
    } catch (err) {
      activeCount--
      if (running) {
        fillSlots()
      }
      throw err
    }
  }

  function fillSlots(): void {
    if (!running) {
      return
    }
    while (running && activeCount < maxConcurrentRuns) {
      activeCount++
      const p = processSlotCycle()
      activePromises.add(p)
      void p.catch(() => {
        // processOne errors are handled by the caller's event system;
        // catch here to prevent unhandled rejection from the tracked promise
      })
      void p.finally(() => {
        activePromises.delete(p)
      })
    }
  }

  return {
    get isRunning(): boolean {
      return running
    },

    start(options?: { workerId?: string }): void {
      if (running) {
        return
      }

      activeWorkerId = options?.workerId
      running = true
      fillSlots()
    },

    async stop(): Promise<void> {
      if (!running) {
        return
      }

      running = false

      if (pollingTimeout) {
        clearTimeout(pollingTimeout)
        pollingTimeout = null
      }

      const pending: Promise<void>[] = [...activePromises]
      if (idleMaintenanceInFlight) {
        pending.push(idleMaintenanceInFlight)
      }
      if (pending.length === 0) {
        return
      }
      await Promise.allSettled(pending)
    },
  }
}
