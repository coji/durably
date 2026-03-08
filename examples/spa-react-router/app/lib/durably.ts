/**
 * Durably instance for browser-only mode
 *
 * Uses Web Locks API to ensure only one tab runs the worker at a time.
 * Exports a Promise that resolves to { durably, tabLocked }.
 */

import { createDurably } from '@coji/durably'
import { dataSyncJob, processImageJob } from '~/jobs'
import { sqlocal } from './database'

/**
 * Acquire an exclusive tab lock via Web Locks API.
 * Returns true if the lock was acquired, false if another tab holds it.
 */
async function acquireTabLock(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      resolve(!!lock)
      if (lock) {
        // Hold the lock for the lifetime of this tab
        return new Promise<void>(() => {})
      }
    })
  })
}

export type InitResult =
  | { tabLocked: true; durably?: undefined }
  | {
      tabLocked: false
      durably: ReturnType<
        typeof createDurably<
          Record<string, string>,
          { processImage: typeof processImageJob; dataSync: typeof dataSyncJob }
        >
      >
    }

async function init(): Promise<InitResult> {
  const acquired = await acquireTabLock('durably:example')
  if (!acquired) {
    return { tabLocked: true }
  }

  const durably = createDurably({
    dialect: sqlocal.dialect,
    pollingIntervalMs: 100,
    leaseRenewIntervalMs: 500,
    leaseMs: 3000,
    jobs: {
      processImage: processImageJob,
      dataSync: dataSyncJob,
    },
  })

  await durably.init()
  return { tabLocked: false, durably }
}

export const initResult = init()
