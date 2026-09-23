import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createAgentDurably,
  dbPath,
  defaultStateRoot,
  legacyDbPath,
  legacyDbWarning,
} from '../src/durably.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

let saved: string | undefined

beforeEach(() => {
  saved = process.env['DURABLY_DB']
})

afterEach(() => {
  if (saved === undefined) delete process.env['DURABLY_DB']
  else process.env['DURABLY_DB'] = saved
})

describe('database path resolution', () => {
  it('defaults to the fixed state directory under the home directory', () => {
    assert.equal(
      defaultStateRoot(),
      join(homedir(), '.local', 'state', 'local-agent-loop'),
    )
    assert.equal(dbPath(), join(defaultStateRoot(), 'local-agent-loop.db'))
  })

  it('does not depend on where the checkout is', () => {
    // A checkout pinned to another commit, or moved, must still find the
    // same database and the same runs.
    assert.equal(dbPath().startsWith(packageRoot), false, dbPath())
    assert.equal(/%[0-9A-Fa-f]{2}/.test(dbPath()), false, dbPath())
  })

  it('ignores DURABLY_DB', () => {
    process.env['DURABLY_DB'] = '/tmp/explicit agent loop.db'
    assert.equal(dbPath(), join(defaultStateRoot(), 'local-agent-loop.db'))
  })

  it('lets tests put the whole state root elsewhere, creating it first', async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), 'state-root-')),
      'nested',
      'state',
    )
    process.env['DURABLY_DB'] = join(root, 'ignored.db')
    const durably = createAgentDurably({ stateRoot: root })
    try {
      await durably.migrate()
      assert.ok(existsSync(dbPath(root)), 'database is created in the root')
      assert.equal(existsSync(join(root, 'ignored.db')), false)
    } finally {
      await durably.db.destroy()
    }
  })

  it('warns once, naming both files, when the checkout has an old database', async () => {
    assert.equal(legacyDbPath(), join(packageRoot, 'local-agent-loop.db'))
    const dir = await mkdtemp(join(tmpdir(), 'legacy-db-'))
    const legacy = join(dir, 'local-agent-loop.db')
    assert.equal(legacyDbWarning(legacy, '/new/state.db'), null)
    await writeFile(legacy, '')
    const warning = legacyDbWarning(legacy, '/new/state.db')
    assert.ok(warning?.includes(legacy), warning ?? '')
    assert.ok(warning?.includes('/new/state.db'), warning ?? '')
  })
})
