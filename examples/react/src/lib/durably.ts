/**
 * Durably singleton instance
 *
 * This module exports a singleton durably instance for use throughout the app.
 *
 * NOTE: This simple singleton pattern does NOT handle HMR (Hot Module Replacement).
 * During development, if this file is modified, a full page reload is required.
 *
 * In the future, @coji/durably-react will provide DurablyProvider that handles
 * HMR and StrictMode correctly using dialectFactory pattern.
 * See: docs/spec-react.md
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
