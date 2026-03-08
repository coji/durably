/**
 * Worker configuration
 */
export interface WorkerConfig {
  pollingIntervalMs: number
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
): Worker {
  let running = false
  let pollingTimeout: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let stopResolver: (() => void) | null = null
  let activeWorkerId: string | undefined

  async function poll(): Promise<void> {
    if (!running) {
      return
    }

    try {
      inFlight = processOne({ workerId: activeWorkerId }).then(() => undefined)
      await inFlight
    } finally {
      inFlight = null
    }

    if (running) {
      pollingTimeout = setTimeout(() => {
        void poll()
      }, config.pollingIntervalMs)
      return
    }

    if (stopResolver) {
      stopResolver()
      stopResolver = null
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
      void poll()
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

      if (inFlight) {
        return new Promise<void>((resolve) => {
          stopResolver = resolve
        })
      }
    },
  }
}
