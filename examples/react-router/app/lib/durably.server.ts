/**
 * Durably Server Configuration
 *
 * Sets up Durably instance, registers jobs, and provides HTTP handler.
 * Server-only - do not import in client code.
 */

import {
  createDurably,
  createDurablyHandler,
} from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { jobs } from '~/jobs'

/**
 * HMR-safe singleton helper for React Router dev server.
 *
 * During development, React Router's HMR reloads this module on every change,
 * which would create new Durably/database instances each time. This helper
 * stores instances on globalThis to persist them across HMR reloads.
 *
 * In production, this just works as a normal singleton pattern.
 */
function singleton<T>(name: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, T>
  if (g[name] === undefined) {
    g[name] = factory()
  }
  return g[name]
}

// Durably instance
export const durably = singleton('__durably', () =>
  createDurably({
    dialect: new LibsqlDialect({
      url: process.env.DATABASE_URL ?? 'file:./local.db',
    }),
  }),
)

// Registered jobs
export const registeredJobs = singleton('__jobs', () => durably.register(jobs))

// HTTP handler
export const durablyHandler = singleton('__durablyHandler', () =>
  createDurablyHandler(durably),
)

// Initialize on first load
singleton('__durablyInitialized', async () => {
  await durably.migrate()
  durably.start()
  return true
})
