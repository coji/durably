import type { DurablyPlugin } from '../durably'

/**
 * Plugin that persists log events to the database.
 * Uses fire-and-forget writes — log persistence is best-effort.
 */
export function withLogPersistence(): DurablyPlugin {
  return {
    name: 'log-persistence',
    install(durably) {
      durably.on('log:write', (event) => {
        void durably.storage.createLog({
          runId: event.runId,
          stepName: event.stepName,
          level: event.level,
          message: event.message,
          data: event.data,
        })
      })
    },
  }
}
