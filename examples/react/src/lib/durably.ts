/**
 * Durably singleton instance
 *
 * This module exports a singleton durably instance for use throughout the app.
 * In the future, this pattern will be provided by @coji/durably-react.
 */

import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'

const sqlocal = new SQLocalKysely('example.sqlite3')
export const { dialect, deleteDatabaseFile } = sqlocal

export const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})
