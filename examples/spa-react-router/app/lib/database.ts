/**
 * Database Configuration
 *
 * SQLocal instance for SQLite WASM with OPFS backend.
 */

import { SQLocalKysely } from 'sqlocal/kysely'

export const sqlocal = new SQLocalKysely('example.sqlite3')
