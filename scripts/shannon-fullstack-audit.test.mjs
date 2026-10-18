import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  realpath,
  symlink,
  writeFile,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  checkedOutputPath,
  checkedStatus,
  cleanupResources,
  command,
  collectReports,
  evidenceDiff,
  parseOptions,
  scannerDependencyHash,
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

test('requires an absolute output path', async () => {
  await assert.rejects(
    checkedOutputPath(parseOptions(['run', '--output', '../audit']).output),
    /absolute/,
  )
})

test(
  'command timeout forces a child that ignores SIGTERM to exit',
  { timeout: 8_000 },
  async () => {
    const started = Date.now()
    await assert.rejects(
      command(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        { timeout: 300 },
      ),
      /timed out/,
    )
    assert.ok(Date.now() - started < 7_000)
  },
)

test(
  'command timeout closes pipes held by a descendant',
  { timeout: 8_000 },
  async () => {
    const started = Date.now()
    await assert.rejects(
      command(
        process.execPath,
        [
          '-e',
          'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] }); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
        ],
        { timeout: 300 },
      ),
      /timed out/,
    )
    assert.ok(Date.now() - started < 7_000)
  },
)

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
  assert.deepEqual(
    before.schema,
    [
      {
        type: 'table',
        name: 'durably_runs',
        tableName: 'durably_runs',
        sql: 'CREATE TABLE durably_runs (id TEXT PRIMARY KEY)',
      },
      {
        type: 'index',
        name: 'sqlite_autoindex_durably_runs_1',
        tableName: 'durably_runs',
        sql: null,
      },
    ].sort(
      (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    ),
  )
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
  for (const path of [
    'apps/worker/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]) {
    const destination = join(scannerDir, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(
      join(worktree, 'scripts', 'shannon-fullstack', 'pinned-shannon', path),
      destination,
    )
  }
  const buildFiles = []
  for (const [path, contents] of [
    ['apps/cli/dist/index.mjs', 'cli'],
    ['apps/worker/dist/index.js', 'worker'],
  ]) {
    const file = join(scannerDir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
    buildFiles.push({
      path,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }
  await mkdir(join(scannerDir, 'node_modules'))
  const cliDependency = join(
    scannerDir,
    'apps',
    'cli',
    'node_modules',
    'fake-runtime',
    'index.js',
  )
  await mkdir(dirname(cliDependency), { recursive: true })
  await writeFile(cliDependency, 'export const version = 1\n')
  for (const name of ['pi-agent-core', 'pi-ai', 'pi-coding-agent']) {
    const directory = join(
      scannerDir,
      'apps',
      'worker',
      'node_modules',
      '@earendil-works',
      name,
    )
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), '{"version":"1.2.0"}')
  }
  await writeFile(
    join(scannerDir, '.durably-audit-build.json'),
    JSON.stringify({
      commit: '2468b67d9e40d70d0b189462c5041c24e1dc886c',
      files: buildFiles,
      dependencyHash: await scannerDependencyHash(scannerDir),
      workerImageId: 'sha256:fake-worker-image',
    }),
  )
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
      'if [ "$1" = "-C" ] && [ "$2" = "$FAKE_SCANNER_DIR" ]; then',
      '  if [ "$3" = "rev-parse" ]; then echo 2468b67d9e40d70d0b189462c5041c24e1dc886c; exit 0; fi',
      '  if [ "$3" = "diff" ]; then',
      '    if [ "$FAKE_DRIFT" = 1 ] || [ "$FAKE_STAGED" = 1 ]; then printf "unexpected.txt\\0"; else printf "apps/worker/package.json\\0pnpm-lock.yaml\\0pnpm-workspace.yaml\\0"; fi',
      '    exit 0',
      '  fi',
      '  if [ "$3" = "ls-files" ]; then exit 0; fi',
      'fi',
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
      'if [ "$1" = image ] && [ "$2" = inspect ]; then',
      '  if [ "$FAKE_IMAGE_DRIFT" = 1 ]; then echo sha256:stale-worker-image; else echo sha256:fake-worker-image; fi',
      '  exit 0',
      'fi',
      'if [ "$1" = run ] && [ "$4" = node ] && [ "$5" = shannon-worker ]; then',
      '  if [ "$FAKE_IMAGE_PI_DRIFT" = 1 ]; then',
      '    echo \'{"@earendil-works/pi-agent-core":"1.2.0","@earendil-works/pi-ai":"1.3.0","@earendil-works/pi-coding-agent":"1.2.0"}\'',
      '    exit 0',
      '  fi',
      '  echo \'{"@earendil-works/pi-agent-core":"1.2.0","@earendil-works/pi-ai":"1.2.0","@earendil-works/pi-coding-agent":"1.2.0"}\'',
      '  exit 0',
      'fi',
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
      '  if [ "$FAKE_STATUS_ERROR" = 1 ]; then echo invalid; exit 1; fi',
      '  if [ "$FAKE_SCAN_FAIL" = 1 ]; then',
      '    echo \'{"status":"failed","phases":[{"key":"preflight","state":"completed"},{"key":"reporting","state":"failed"}]}\'',
      '    exit 1',
      '  fi',
      '  if [ "$FAKE_STATUS" = running ]; then',
      '    printf \'{"status":"running","workflowId":"%s_workflow"}\\n\' "$2"',
      '    exit 0',
      '  fi',
      '  echo \'{"status":"completed","phases":[{"key":"preflight","state":"completed"},{"key":"cyber-access","state":"completed"},{"key":"agentic-sast","state":"completed"},{"key":"pre-recon","state":"completed"},{"key":"recon","state":"completed"},{"key":"vulnerability-analysis","state":"completed"},{"key":"reporting","state":"completed"}]}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "start" ]; then',
      '  for value do',
      '    if [ "$value" = "--validate-model" ]; then',
      '      if [ "$FAKE_PREFLIGHT_HANG" = 1 ]; then',
      '        echo "$$" > "$HANG_MARKER"',
      '        while :; do :; done',
      '      fi',
      '      exit 0',
      '    fi',
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
      '  echo \'[2026-10-18 09:00:00] [agent] step: {"secret":"synthetic-secret"}\' > "$(dirname "$0")/workspaces/$workspace/.shannon/workflow.log"',
      '  echo \'[2026-10-18 09:00:01] [agent] Authorization: Basic synthetic-basic\' >> "$(dirname "$0")/workspaces/$workspace/.shannon/workflow.log"',
      '  echo \'[2026-10-18 09:00:02] [agent] token=eyJhbGci.eyJwYXlsb2Fk.signature\' >> "$(dirname "$0")/workspaces/$workspace/.shannon/workflow.log"',
      '  echo \'[2026-10-18 09:00:03] [PHASE] PI_REFRESH_TOKEN=synthetic-refresh\' >> "$(dirname "$0")/workspaces/$workspace/.shannon/workflow.log"',
      '  if [ "$FAKE_SCAN_FAIL" = 1 ]; then exit 1; fi',
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
      FAKE_SCANNER_DIR: scannerDir,
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
  const scannerLog = await readFile(
    join(output, 'shannon-workflow.log'),
    'utf8',
  )
  assert.match(scannerLog, /details omitted/)
  assert.doesNotMatch(scannerLog, /synthetic-secret/)
  assert.doesNotMatch(scannerLog, /synthetic-basic|eyJhbGci|synthetic-refresh/)
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
  const unreadable = spawnSync(
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
      env: { ...env, FAKE_STATUS_ERROR: '1' },
      encoding: 'utf8',
    },
  )
  assert.equal(unreadable.status, 0, unreadable.stderr)
  assert.equal(
    (await readFile(env.FAKE_STOP_MARKER, 'utf8')).trim().split('\n').length,
    2,
  )
})

test('source or worker Pi drift fails before Docker setup', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'durably-shannon-drift-test-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const { scannerDir, env } = await fakeAuditTools(temporary)
  const args = [
    join(worktree, 'scripts', 'shannon-fullstack-audit.mjs'),
    'run',
    '--output',
    join(temporary, 'output'),
    '--shannon-dir',
    scannerDir,
  ]
  const source = spawnSync(process.execPath, args, {
    cwd: worktree,
    env: { ...env, FAKE_DRIFT: '1' },
    encoding: 'utf8',
  })
  assert.equal(source.status, 1)
  assert.match(source.stderr, /differs from the pinned Pi patch/)
  const staged = spawnSync(process.execPath, args, {
    cwd: worktree,
    env: { ...env, FAKE_STAGED: '1' },
    encoding: 'utf8',
  })
  assert.equal(staged.status, 1)
  assert.match(staged.stderr, /differs from the pinned Pi patch/)
  const workspaceFile = join(scannerDir, 'pnpm-workspace.yaml')
  const originalWorkspace = await readFile(workspaceFile)
  await writeFile(
    workspaceFile,
    Buffer.concat([originalWorkspace, Buffer.from('\n# drift\n')]),
  )
  const patchedFile = spawnSync(process.execPath, args, {
    cwd: worktree,
    env,
    encoding: 'utf8',
  })
  assert.equal(patchedFile.status, 1)
  assert.match(patchedFile.stderr, /differs from the pinned Pi patch/)
  await writeFile(workspaceFile, originalWorkspace)
  await writeFile(
    join(scannerDir, '.env'),
    'SHANNON_AI_BASE_URL=https://other.example\n',
  )
  const dotenv = spawnSync(process.execPath, args, {
    cwd: worktree,
    env,
    encoding: 'utf8',
  })
  assert.equal(dotenv.status, 1)
  assert.match(dotenv.stderr, /checkout \.env must be removed/)
  await rm(join(scannerDir, '.env'))
  await writeFile(
    join(
      scannerDir,
      'apps',
      'worker',
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'package.json',
    ),
    '{"version":"1.3.0"}',
  )
  const worker = spawnSync(process.execPath, args, {
    cwd: worktree,
    env,
    encoding: 'utf8',
  })
  assert.equal(worker.status, 1)
  assert.match(worker.stderr, /build output differs/)
  await writeFile(
    join(
      scannerDir,
      'apps',
      'worker',
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'package.json',
    ),
    '{"version":"1.2.0"}',
  )
  const staleImage = spawnSync(process.execPath, args, {
    cwd: worktree,
    env: { ...env, FAKE_IMAGE_DRIFT: '1' },
    encoding: 'utf8',
  })
  assert.equal(staleImage.status, 1)
  assert.match(staleImage.stderr, /build output differs/)
  const imagePi = spawnSync(process.execPath, args, {
    cwd: worktree,
    env: { ...env, FAKE_IMAGE_PI_DRIFT: '1' },
    encoding: 'utf8',
  })
  assert.equal(imagePi.status, 1)
  assert.match(imagePi.stderr, /worker image Pi version mismatch/)
  await writeFile(join(scannerDir, 'apps', 'cli', 'dist', 'index.mjs'), 'drift')
  const build = spawnSync(process.execPath, args, {
    cwd: worktree,
    env,
    encoding: 'utf8',
  })
  assert.equal(build.status, 1)
  assert.match(build.stderr, /build output differs/)
  await writeFile(join(scannerDir, 'apps', 'cli', 'dist', 'index.mjs'), 'cli')
  await writeFile(
    join(scannerDir, 'apps', 'cli', 'node_modules', 'fake-runtime', 'index.js'),
    'export const version = 2\n',
  )
  const dependency = spawnSync(process.execPath, args, {
    cwd: worktree,
    env,
    encoding: 'utf8',
  })
  assert.equal(dependency.status, 1)
  assert.match(dependency.stderr, /build output differs/)
  await symlink(
    join(scannerDir, 'apps', 'cli', 'node_modules', 'fake-runtime'),
    join(scannerDir, 'node_modules', 'internal-dependency'),
  )
  const linkedScannerDir = join(temporary, 'scanner-link')
  await symlink(scannerDir, linkedScannerDir)
  assert.equal(
    await scannerDependencyHash(linkedScannerDir),
    await scannerDependencyHash(scannerDir),
  )
  for (const workspace of ['cli', 'worker']) {
    const link = join(scannerDir, 'node_modules', workspace + '-workspace')
    await symlink(join(scannerDir, 'apps', workspace), link)
    await scannerDependencyHash(scannerDir)
    await rm(link)
  }
  const workerSource = join(scannerDir, 'apps', 'worker', 'src')
  await mkdir(workerSource)
  const badWorkspaceLink = join(scannerDir, 'node_modules', 'workspace-subpath')
  await symlink(workerSource, badWorkspaceLink)
  await assert.rejects(
    scannerDependencyHash(scannerDir),
    /dependency link points outside verified roots/,
  )
  await rm(badWorkspaceLink)
  await symlink(scannerDir, badWorkspaceLink)
  await assert.rejects(
    scannerDependencyHash(scannerDir),
    /dependency link points outside verified roots/,
  )
  await rm(badWorkspaceLink)

  const alternatePackage = join(
    scannerDir,
    'apps',
    'cli',
    'node_modules',
    'alternate-runtime',
  )
  await mkdir(alternatePackage)
  await writeFile(
    join(alternatePackage, 'index.js'),
    'export const version = 2\n',
  )
  const intermediate = join(temporary, 'dependency-hop')
  const hopLink = join(scannerDir, 'node_modules', 'through-hop')
  await symlink(
    join(scannerDir, 'apps', 'cli', 'node_modules', 'fake-runtime'),
    intermediate,
  )
  await symlink(intermediate, hopLink)
  const beforeHopChange = await scannerDependencyHash(scannerDir)
  const originalResolvedTarget = await realpath(hopLink)
  const sameTargetHop = join(temporary, 'same-target-hop')
  await symlink(
    join(scannerDir, 'apps', 'cli', 'node_modules', 'fake-runtime'),
    sameTargetHop,
  )
  await rm(intermediate)
  await symlink(sameTargetHop, intermediate)
  assert.equal(await realpath(hopLink), originalResolvedTarget)
  assert.notEqual(await scannerDependencyHash(scannerDir), beforeHopChange)
  await rm(intermediate)
  await symlink(alternatePackage, intermediate)
  assert.notEqual(await scannerDependencyHash(scannerDir), beforeHopChange)
  await rm(hopLink)
  await rm(intermediate)
  await rm(sameTargetHop)

  const outsideDependency = join(temporary, 'outside-dependency.js')
  await writeFile(outsideDependency, 'export const version = 1\n')
  await symlink(
    outsideDependency,
    join(scannerDir, 'node_modules', 'outside-dependency.js'),
  )
  await assert.rejects(scannerDependencyHash(scannerDir), (error) => {
    assert.match(error.message, /dependency link points outside verified roots/)
    assert.match(error.message, /outside-dependency\.js/)
    assert.ok(error.message.includes(outsideDependency))
    assert.match(error.message, /default pnpm virtual store/)
    return true
  })
  await rm(join(scannerDir, 'node_modules', 'outside-dependency.js'))
  const ignoredStore = join(scannerDir, 'workspaces', 'alternate-store')
  await mkdir(ignoredStore, { recursive: true })
  await writeFile(join(ignoredStore, 'index.js'), 'alternate dependency\n')
  await symlink(
    ignoredStore,
    join(scannerDir, 'node_modules', 'unverified-dependency'),
  )
  await assert.rejects(
    scannerDependencyHash(linkedScannerDir),
    /dependency link points outside verified roots/,
  )
  const calls = await readFile(env.DOCKER_MARKER, 'utf8')
  assert.doesNotMatch(calls, /network create|volume create|build/)
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

test('failed Shannon run preserves status, reports, and sanitized log', async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), 'durably-shannon-failed-scan-test-'),
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
      env: { ...env, FAKE_SCAN_FAIL: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    },
  )
  assert.equal(result.status, 1)
  const status = JSON.parse(
    await readFile(join(output, 'shannon-status.json'), 'utf8'),
  )
  assert.equal(status.status, 'failed')
  assert.match(
    await readFile(
      join(output, 'reports', 'Static-Analysis-Report.md'),
      'utf8',
    ),
    /static/,
  )
  assert.doesNotMatch(
    await readFile(join(output, 'shannon-workflow.log'), 'utf8'),
    /synthetic-secret/,
  )
  assert.equal(
    JSON.parse(await readFile(join(output, 'state.json'), 'utf8')).status,
    'failed',
  )
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
    { cwd: worktree, env: { ...env, FAKE_SCAN_FAIL: '1' }, encoding: 'utf8' },
  )
  assert.equal(down.status, 0, down.stderr)
  await assert.rejects(readFile(env.FAKE_STOP_MARKER))
})

for (const signal of ['SIGINT', 'SIGHUP']) {
  test(`interrupting the scanner with ${signal} removes audit resources`, async (context) => {
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
    child.kill(signal)
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(
        () => rejectExit(new Error(`Audit did not stop after ${signal}`)),
        10_000,
      )
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
    })
    assert.equal(exitCode, 130)
    const state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
    assert.equal(state.status, 'failed')
    assert.match(
      await readFile(env.DOCKER_MARKER, 'utf8'),
      /volume rm durably-shannon-data-/,
    )
  })
}

for (const hookName of ['afterSnapshot', 'beforeScanner']) {
  test(`interrupt between commands at ${hookName} stops the next command`, async (context) => {
    const temporary = await mkdtemp(
      join(tmpdir(), `durably-shannon-${hookName}-interrupt-test-`),
    )
    context.after(() => rm(temporary, { recursive: true, force: true }))
    const { scannerDir, env } = await fakeAuditTools(temporary)
    const output = join(temporary, 'output')
    const scannerMarker = join(temporary, 'scanner-started')
    const moduleUrl = pathToFileURL(
      join(worktree, 'scripts', 'shannon-fullstack-audit.mjs'),
    ).href
    const childScript = `
      import { runAudit } from ${JSON.stringify(moduleUrl)}
      try {
        await runAudit(
          { output: process.env.TEST_OUTPUT, shannonDir: process.env.TEST_SCANNER_DIR },
          { ${hookName}: async () => {
            process.kill(process.pid, 'SIGINT')
            await new Promise((resolve) => setTimeout(resolve, 10))
          } },
        )
      } catch (error) {
        process.stderr.write(String(error) + '\\n')
      }
    `
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', childScript],
      {
        cwd: worktree,
        env: {
          ...env,
          TEST_OUTPUT: output,
          TEST_SCANNER_DIR: scannerDir,
          FAKE_HANG: '1',
          HANG_MARKER: scannerMarker,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    assert.equal(result.status, 130, result.stderr)
    const state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
    assert.equal(state.status, 'failed')
    const calls = await readFile(env.DOCKER_MARKER, 'utf8')
    if (hookName === 'afterSnapshot')
      assert.doesNotMatch(calls, /^build|^network create|^volume create/m)
    await assert.rejects(readFile(scannerMarker), { code: 'ENOENT' })
  })
}

test('interrupting model preflight stops its detached child', async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), 'durably-shannon-preflight-interrupt-test-'),
  )
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const { scannerDir, env } = await fakeAuditTools(temporary)
  const marker = join(temporary, 'preflight-pid')
  const output = join(temporary, 'output')
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
      env: { ...env, FAKE_PREFLIGHT_HANG: '1', HANG_MARKER: marker },
      stdio: 'ignore',
    },
  )
  const deadline = Date.now() + 10_000
  let preflightPid
  while (Date.now() < deadline) {
    try {
      const pid = (await readFile(marker, 'utf8')).trim()
      if (/^[0-9]+$/.test(pid)) {
        preflightPid = Number(pid)
        break
      }
    } catch {
      // The marker may not exist yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  assert.ok(preflightPid > 0)
  child.kill('SIGINT')
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error('Preflight did not stop after SIGINT')),
      10_000,
    )
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
  assert.equal(exitCode, 130)
  assert.throws(() => process.kill(preflightPid, 0), { code: 'ESRCH' })
  await assert.rejects(readFile(join(output, 'state.json')))
})
