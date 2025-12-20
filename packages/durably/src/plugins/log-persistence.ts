import type { DurablyPlugin } from '../durably'

/**
 * Plugin that persists log events to the database
 */
export function withLogPersistence(): DurablyPlugin {
  return {
    name: 'log-persistence',
    install(durably) {
      durably.on('log:write', async (event) => {
        await durably.storage.createLog({
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
