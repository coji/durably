import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { dbPath } from '../src/durably.js'

let saved: string | undefined

beforeEach(() => {
  saved = process.env['DURABLY_DB']
  delete process.env['DURABLY_DB']
})

afterEach(() => {
  if (saved === undefined) delete process.env['DURABLY_DB']
  else process.env['DURABLY_DB'] = saved
})

describe('database path resolution', () => {
  it('returns a real filesystem path, not a percent-encoded URL path', () => {
    const path = dbPath()
    // `new URL(...).pathname` encodes spaces as %20, so a checkout under
    // "/Users/my name/..." would send better-sqlite3 to a directory that does
    // not exist — and the worker and the CLI would open different databases.
    assert.equal(/%[0-9A-Fa-f]{2}/.test(path), false, path)
    assert.ok(existsSync(dirname(path)), `${dirname(path)} must exist`)
  })

  it('honours an explicit DURABLY_DB override', () => {
    process.env['DURABLY_DB'] = '/tmp/explicit agent loop.db'
    assert.equal(dbPath(), '/tmp/explicit agent loop.db')
  })
})
