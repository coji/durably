import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
  snapshotSource,
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

test('source snapshot has the original HEAD without local edits or .env', async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), 'durably-shannon-source-test-'),
  )
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const repository = join(temporary, 'repository')
  const scratch = join(temporary, 'scratch')
  await mkdir(repository)
  await mkdir(scratch)
  const runGit = (...args) => {
    const result = spawnSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  runGit('init', '-b', 'main')
  runGit('config', 'user.name', 'Audit Test')
  runGit('config', 'user.email', 'audit@example.invalid')
  await writeFile(join(repository, 'app.txt'), 'committed\n')
  runGit('add', 'app.txt')
  runGit('commit', '-m', 'fixture')
  const revision = runGit('rev-parse', 'HEAD')
  await writeFile(join(repository, 'app.txt'), 'uncommitted\n')
  await writeFile(join(repository, '.env'), 'LOCAL_SECRET=do-not-copy\n')
  const source = await snapshotSource(scratch, revision, repository)
  assert.equal(await readFile(join(source, 'app.txt'), 'utf8'), 'committed\n')
  await assert.rejects(readFile(join(source, '.env')))
  const head = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  })
  assert.equal(head.stdout.trim(), revision)
  const count = spawnSync(
    'git',
    ['-C', source, 'rev-list', '--count', 'HEAD'],
    { encoding: 'utf8' },
  )
  assert.equal(count.stdout.trim(), '1')
  runGit('add', '.env')
  runGit('commit', '-m', 'tracked environment fixture')
  const unsafeRevision = runGit('rev-parse', 'HEAD')
  const unsafeScratch = join(temporary, 'unsafe-scratch')
  await mkdir(unsafeScratch)
  await assert.rejects(
    snapshotSource(unsafeScratch, unsafeRevision, repository),
    /environment files/,
  )
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

async function fakeAuditTools(temporary) {
  const bin = join(temporary, 'bin')
  const scannerDir = join(temporary, 'scanner')
  await mkdir(bin)
  await mkdir(scannerDir)
  const revision = 'a'.repeat(40)
  await writeFile(
    join(bin, 'pi'),
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo 1.3.0; else echo ready; fi',
    ].join('\n') + '\n',
    { mode: 0o755 },
  )
  await writeFile(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" clone "*) for value do last="$value"; done; mkdir -p "$last"; exit 0 ;;',
      '  *" rev-parse HEAD "*) echo "$FAKE_REVISION"; exit 0 ;;',
      '  *" status --porcelain=v1 "*) exit 0 ;;',
      '  *" ls-files -z "*) exit 0 ;;',
      '  *" checkout --detach "*) exit 0 ;;',
      'esac',
      'exit 1',
    ].join('\n') + '\n',
    { mode: 0o755 },
  )
  await writeFile(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$DOCKER_MARKER"',
      'if [ "$1" = "cp" ]; then',
      '  count=$(cat "$CP_COUNT" 2>/dev/null || echo 0)',
      '  count=$((count + 1))',
      '  echo "$count" > "$CP_COUNT"',
      '  if [ "$count" -eq 2 ] && [ "$CORRUPT_AFTER" = 1 ]; then',
      '    printf invalid > "$3"',
      '  else',
      '    cp "$DB_SOURCE" "$3"',
      '  fi',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  )
  await writeFile(
    join(scannerDir, 'shannon'),
    [
      '#!/bin/sh',
      'if [ "$1" = "version" ]; then',
      '  echo \'{"version":"git-2468b67d9e40d70d0b189462c5041c24e1dc886c"}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "stop" ]; then',
      '  echo stopped >> "$FAKE_STOP_MARKER"',
      '  exit 0',
      'fi',
      'if [ "$1" = "status" ]; then',
      '  if [ "$FAKE_STATUS" = running ]; then',
      '    printf \'{"status":"running","workflowId":"%s_workflow"}\\n\' "$2"',
      '    exit 0',
      '  fi',
      '  echo \'{"status":"completed","phases":[{"key":"preflight","state":"completed"},{"key":"cyber-access","state":"completed"},{"key":"agentic-sast","state":"completed"},{"key":"pre-recon","state":"completed"},{"key":"recon","state":"completed"},{"key":"vulnerability-analysis","state":"completed"},{"key":"reporting","state":"completed"}]}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "start" ]; then',
      '  for value do',
      '    if [ "$value" = "--validate-model" ]; then exit 0; fi',
      '  done',
      '  follow=0',
      '  while [ "$#" -gt 0 ]; do',
      '    case "$1" in',
      '      --follow) follow=1 ;;',
      '      --workspace) shift; workspace="$1" ;;',
      '      --output) shift; output="$1" ;;',
      '    esac',
      '    shift',
      '  done',
      '  if [ "$follow" -ne 1 ]; then exit 0; fi',
      '  if [ "$FAKE_HANG" = 1 ]; then',
      '    echo ready > "$HANG_MARKER"',
      '    while :; do :; done',
      '  fi',
      '  mkdir -p "$output" "$(dirname "$0")/workspaces/$workspace/.shannon/capella"',
      '  for name in Security-Assessment-Report.md Security-Assessment-Report.pdf report.sarif; do',
      '    echo report > "$output/$name"',
      '  done',
      '  echo static > "$(dirname "$0")/workspaces/$workspace/.shannon/capella/report.md"',
      '  echo "{}" > "$(dirname "$0")/workspaces/$workspace/.shannon/capella/capella.sarif"',
      '  exit 0',
      'fi',
      'exit 1',
    ].join('\n') + '\n',
    { mode: 0o755 },
  )
  const databaseFile = join(temporary, 'source.sqlite')
  const database = new DatabaseSync(databaseFile)
  database.exec('CREATE TABLE durably_runs (id TEXT PRIMARY KEY)')
  database.close()
  return {
    scannerDir,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      FAKE_REVISION: revision,
      DOCKER_MARKER: join(temporary, 'docker-marker'),
      CP_COUNT: join(temporary, 'copy-count'),
      DB_SOURCE: databaseFile,
      FAKE_STOP_MARKER: join(temporary, 'stop-marker'),
    },
  }
}

test('stubbed full run waits for reports and cleans up', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'durably-shannon-run-test-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const { scannerDir, env } = await fakeAuditTools(temporary)
  const output = join(temporary, 'output')
  const result = spawnSync(
    process.execPath,
    [
      join(worktree, 'scripts', 'shannon-fullstack-audit.mjs'),
      'run',
      '--output',
      output,
      '--shannon-dir',
      scannerDir,
    ],
    { cwd: worktree, env, encoding: 'utf8', timeout: 20_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  const state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
  assert.equal(state.status, 'completed')
  assert.match(
    await readFile(
      join(output, 'reports', 'Static-Analysis-Report.md'),
      'utf8',
    ),
    /static/,
  )
  const calls = await readFile(env.DOCKER_MARKER, 'utf8')
  assert.match(calls, /network create --internal/)
  assert.match(calls, /image rm durably-shannon-target:/)
  const down = spawnSync(
    process.execPath,
    [
      join(worktree, 'scripts', 'shannon-fullstack-audit.mjs'),
      'down',
      '--output',
      output,
      '--shannon-dir',
      scannerDir,
    ],
    {
      cwd: worktree,
      env: { ...env, FAKE_STATUS: 'running' },
      encoding: 'utf8',
    },
  )
  assert.equal(down.status, 0, down.stderr)
  assert.match(await readFile(env.FAKE_STOP_MARKER, 'utf8'), /stopped/)
})

test('failed final SQLite copy still removes audit resources', async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), 'durably-shannon-final-db-test-'),
  )
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const { scannerDir, env } = await fakeAuditTools(temporary)
  const output = join(temporary, 'output')
  const result = spawnSync(
    process.execPath,
    [
      join(worktree, 'scripts', 'shannon-fullstack-audit.mjs'),
      'run',
      '--output',
      output,
      '--shannon-dir',
      scannerDir,
    ],
    {
      cwd: worktree,
      env: { ...env, CORRUPT_AFTER: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    },
  )
  assert.equal(result.status, 1)
  const state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
  assert.equal(state.status, 'failed')
  const calls = await readFile(env.DOCKER_MARKER, 'utf8')
  assert.match(calls, /rm -f durably-shannon-target-/)
  assert.match(calls, /volume rm durably-shannon-data-/)
  assert.match(calls, /image rm durably-shannon-target:/)
})

test('interrupting the scanner still removes audit resources', async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), 'durably-shannon-interrupt-test-'),
  )
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const { scannerDir, env } = await fakeAuditTools(temporary)
  const output = join(temporary, 'output')
  const marker = join(temporary, 'scanner-ready')
  const child = spawn(
    process.execPath,
    [
      join(worktree, 'scripts', 'shannon-fullstack-audit.mjs'),
      'run',
      '--output',
      output,
      '--shannon-dir',
      scannerDir,
    ],
    {
      cwd: worktree,
      env: { ...env, FAKE_HANG: '1', HANG_MARKER: marker },
      stdio: 'ignore',
    },
  )
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await readFile(marker)
      break
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  }
  await readFile(marker)
  child.kill('SIGINT')
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error('Audit did not stop after SIGINT')),
      10_000,
    )
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
  assert.notEqual(exitCode, 0)
  const state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
  assert.equal(state.status, 'failed')
  assert.match(
    await readFile(env.DOCKER_MARKER, 'utf8'),
    /volume rm durably-shannon-data-/,
  )
})
