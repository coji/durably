import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  checkedOutputPath,
  checkedStatus,
  cleanupResources,
  collectReports,
  evidenceDiff,
  sqliteEvidence,
} from './shannon-fullstack-audit.mjs'

const worktree = resolve(import.meta.dirname, '..')

test('accepts only a fully completed Shannon run', () => {
  const phases = [
    'preflight',
    'cyber-access',
    'agentic-sast',
    'pre-recon',
    'recon',
    'vulnerability-analysis',
    'reporting',
  ].map((key) => ({ key, state: 'completed' }))
  const status = {
    status: 'completed',
    phases: [...phases, { key: 'exploitation', state: 'skipped' }],
  }
  assert.equal(checkedStatus(status), status)
  assert.throws(
    () => checkedStatus({ ...status, status: 'partial' }),
    /did not complete/,
  )
  assert.throws(
    () =>
      checkedStatus({
        ...status,
        phases: phases.map((phase) =>
          phase.key === 'agentic-sast' ? { ...phase, state: 'failed' } : phase,
        ),
      }),
    /agentic-sast/,
  )
  assert.throws(
    () => checkedStatus({ ...status, phases: phases.slice(1) }),
    /preflight/,
  )
})

test('rejects output paths inside the worktree, including a symlink', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'durably-shannon-test-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  await symlink(worktree, join(temporary, 'repo-link'))
  await assert.rejects(
    checkedOutputPath(join(worktree, 'audit-test')),
    /outside/,
  )
  await assert.rejects(
    checkedOutputPath(join(temporary, 'repo-link', 'audit-test')),
    /outside/,
  )
  assert.equal(
    await checkedOutputPath(join(temporary, 'reports')),
    join(await realpath(temporary), 'reports'),
  )
})

test('SQLite evidence records integrity, table counts, and new run IDs', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'durably-shannon-sqlite-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const file = join(temporary, 'audit.sqlite')
  const database = new DatabaseSync(file)
  database.exec('CREATE TABLE durably_runs (id TEXT PRIMARY KEY)')
  database.exec("INSERT INTO durably_runs (id) VALUES ('first')")
  database.close()
  const before = sqliteEvidence(file)
  assert.deepEqual(before.integrity, ['ok'])
  assert.equal(before.counts.durably_runs, 1)
  const next = new DatabaseSync(file)
  next.exec("INSERT INTO durably_runs (id) VALUES ('second')")
  next.close()
  const after = sqliteEvidence(file)
  assert.deepEqual(evidenceDiff(before, after), {
    counts: { durably_runs: { before: 1, after: 2, change: 1 } },
    createdRunIds: ['second'],
  })
  await writeFile(join(temporary, 'invalid.sqlite'), 'not sqlite')
  assert.throws(() => sqliteEvidence(join(temporary, 'invalid.sqlite')))
})

test('cleanup attempts every resource after one removal fails', async () => {
  const calls = []
  const state = { id: '123456789abc' }
  await assert.rejects(
    cleanupResources(state, '/unused', async (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'rm' && args[2].includes('proxy'))
        throw new Error('interrupted cleanup')
    }),
    /could not be removed/,
  )
  assert.equal(calls.length, 5)
  assert.match(calls[4], /^image rm durably-shannon-target:123456789abc$/)
})

test('missing static report fails even if the main report exists', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'durably-shannon-report-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const published = join(temporary, 'shannon-output')
  await mkdir(published)
  for (const name of [
    'Security-Assessment-Report.md',
    'Security-Assessment-Report.pdf',
    'report.sarif',
  ]) {
    await writeFile(join(published, name), 'report')
  }
  await assert.rejects(
    collectReports(temporary, { workspace: 'missing' }, temporary),
  )
})

test('failed Pi preflight creates no audit output or Docker resources', async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), 'durably-shannon-preflight-test-'),
  )
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const bin = join(temporary, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'pi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await writeFile(
    join(bin, 'docker'),
    '#!/bin/sh\necho called >> "$DOCKER_MARKER"\n',
    { mode: 0o755 },
  )
  const output = join(temporary, 'output')
  const marker = join(temporary, 'docker-marker')
  const result = spawnSync(
    process.execPath,
    [
      join(worktree, 'scripts', 'shannon-fullstack-audit.mjs'),
      'run',
      '--output',
      output,
      '--shannon-dir',
      temporary,
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        DOCKER_MARKER: marker,
      },
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /pi failed/)
  await assert.rejects(readFile(marker))
  await assert.rejects(readFile(join(output, 'state.json')))
})
