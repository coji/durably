/**
 * Durably instance for browser-only mode
 *
 * This creates a singleton Durably instance that can be used
 * both by DurablyProvider and by clientAction for triggering jobs.
 *
 * IMPORTANT: Job definitions are exported from here to ensure the same
 * object references are used throughout the app. This prevents
 * "already registered with a different definition" errors.
 */

import { createDurably, type Durably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { dataSyncJob, processImageJob } from './jobs'

// Re-export job definitions to ensure consistent object references
export { dataSyncJob, processImageJob }

// SQLocal instance for SQLite WASM with OPFS
export const sqlocal = new SQLocalKysely('example.sqlite3')

// Singleton Durably instance (lazily initialized)
let durablyInstance: Durably | null = null
let durablyPromise: Promise<Durably> | null = null

/**
 * Get the shared Durably instance.
 * Creates and migrates on first call, returns cached instance thereafter.
 */
export async function getDurably(): Promise<Durably> {
  if (durablyInstance) {
    return durablyInstance
  }

  if (!durablyPromise) {
    durablyPromise = (async () => {
      const instance = createDurably({
        dialect: sqlocal.dialect,
        pollingInterval: 100,
        heartbeatInterval: 500,
        staleThreshold: 3000,
      })
      await instance.migrate()

      // Pre-register jobs immediately after migration
      // This ensures they're registered before any component tries to use them
      instance.register({
        processImage: processImageJob,
        dataSync: dataSyncJob,
      })

      durablyInstance = instance
      return instance
    })()
  }

  return durablyPromise
}

/**
 * Trigger a job by name.
 * This uses the shared durably instance and its registered jobs.
 */
export async function triggerJob<T extends { filename: string; width: number }>(
  jobName: 'processImage',
  payload: T,
): Promise<{ id: string }>
export async function triggerJob<T extends { userId: string }>(
  jobName: 'dataSync',
  payload: T,
): Promise<{ id: string }>
export async function triggerJob(
  jobName: 'processImage' | 'dataSync',
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const durably = await getDurably()
  const jobHandle = durably.getJob(
    jobName === 'processImage' ? 'process-image' : 'data-sync',
  )
  if (!jobHandle) {
    throw new Error(`Job ${jobName} not found`)
  }
  return jobHandle.trigger(payload)
}
