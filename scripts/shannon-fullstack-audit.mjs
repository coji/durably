#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const support = join(root, 'scripts', 'shannon-fullstack')
const shannonCommit = '2468b67d9e40d70d0b189462c5041c24e1dc886c'
const shannonVersion = 'git-' + shannonCommit
const shannonSource = 'https://github.com/KeygraphHQ/shannon.git'
const pinnedShannonFiles = join(support, 'pinned-shannon')
const buildManifestName = '.durably-audit-build.json'
const proxyImage =
  'alpine/socat@sha256:3d9e7966201dd3a065df591020a09fd3c70845de7e7086e3531ea69db774406b'
const workerImage = 'shannon-worker'
const workerPiVersion = '1.2.0'
const workerPiPackages = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
]
const patchedScannerFiles = {
  'apps/worker/package.json':
    '35ce612b44dcd2b9bde098157f89f3b2d5333926e5faf2de5c6e44f8566ce6f0',
  'pnpm-lock.yaml':
    'e7ac65e86a58509994933def3f25d081cb609cb5728f44271ac1c67d1d0dea4e',
  'pnpm-workspace.yaml':
    '489bec1784e964b27d6a78792950b4e6ca57b7bdc51dcda3f5549654c1c92e1e',
}
const defaultShannonDir = join(
  homedir(),
  '.cache',
  'durably-shannon',
  'shannon-' + shannonCommit.slice(0, 7),
)
const model = 'openai:gpt-6-sol'
const requiredPhases = [
  'preflight',
  'cyber-access',
  'agentic-sast',
  'pre-recon',
  'recon',
  'vulnerability-analysis',
  'reporting',
]
const auditPrefix = 'durably-shannon-'
const defaultTimeout = 2 * 60 * 1000
const scanTimeout = 6 * 60 * 60 * 1000
const terminationGraceMs = 5 * 1000
const activeChildren = new Set()
const activeAborts = new Map()
let auditSignalActive = false

function abortActiveChildren() {
  for (const abort of activeAborts.values()) abort()
}

function killChildTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error
    }
  }
  child.kill(signal)
}

export function parseOptions(argv) {
  const [action = 'help', ...rest] = argv
  const options = { action, output: undefined, shannonDir: defaultShannonDir }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!value || !['--output', '--shannon-dir'].includes(key)) {
      throw new Error(
        'Expected --output <directory> or --shannon-dir <directory>',
      )
    }
    if (key === '--output') options.output = value
    if (key === '--shannon-dir') options.shannonDir = resolve(value)
  }
  return options
}

export function checkedStatus(status) {
  if (status?.status !== 'completed') {
    throw new Error(
      'Shannon did not complete: ' + String(status?.status ?? 'unknown'),
    )
  }
  const phases = new Map(
    (status.phases ?? []).map((phase) => [phase.key, phase.state]),
  )
  for (const phase of requiredPhases) {
    if (phases.get(phase) !== 'completed') {
      throw new Error(
        'Shannon phase did not complete: ' +
          phase +
          ' (' +
          String(phases.get(phase) ?? 'missing') +
          ')',
      )
    }
  }
  for (const phase of ['auth-validation', 'exploitation']) {
    if (
      phases.has(phase) &&
      !['completed', 'skipped'].includes(phases.get(phase))
    ) {
      throw new Error('Shannon phase did not complete: ' + phase)
    }
  }
  return status
}

export async function checkedOutputPath(output, worktree = root) {
  if (!output || !isAbsolute(output))
    throw new Error('An absolute --output directory is required')
  const actualRoot = await realpath(worktree)
  let parent = output
  let actualParent
  while (true) {
    try {
      actualParent = await realpath(parent)
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const next = dirname(parent)
      if (next === parent) throw error
      parent = next
    }
  }
  const suffix = relative(parent, output)
  const actualOutput = resolve(actualParent, suffix)
  const inside = relative(actualRoot, actualOutput)
  if (
    inside === '' ||
    (!inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside))
  ) {
    throw new Error('Output directory must be outside the repository worktree')
  }
  return actualOutput
}

function childEnvironment() {
  const env = { ...process.env }
  for (const key of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'SHANNON_AI_API_KEY',
    'SHANNON_AI_BASE_URL',
  ]) {
    delete env[key]
  }
  return { ...env, SHANNON_USE_PI_AUTH: '1', SHANNON_AI_MODEL: model }
}

export async function command(file, args, options = {}) {
  const {
    cwd = root,
    timeout = defaultTimeout,
    env = process.env,
    signal,
    allowNonzero = false,
  } = options
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(file, args, {
      cwd,
      env,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let truncated = false
    let terminationReason
    let forceTimer
    const append = (current, chunk) => {
      if (current.length >= 1024 * 1024) {
        truncated = true
        return current
      }
      return (current + chunk.toString()).slice(0, 1024 * 1024)
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    const terminate = (reason) => {
      if (terminationReason) return
      terminationReason = reason
      killChildTree(child, 'SIGTERM')
      forceTimer = setTimeout(() => {
        killChildTree(child, 'SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        activeChildren.delete(child)
        activeAborts.delete(child)
        rejectCommand(new Error(basename(file) + ' ' + reason))
      }, terminationGraceMs)
    }
    activeAborts.set(child, () => terminate('interrupted'))
    const timer = setTimeout(() => terminate('timed out'), timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      activeChildren.delete(child)
      activeAborts.delete(child)
      rejectCommand(error)
    })
    child.on('close', (code, signalName) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      activeChildren.delete(child)
      activeAborts.delete(child)
      if (terminationReason) {
        rejectCommand(new Error(basename(file) + ' ' + terminationReason))
      } else if (code === 0 || allowNonzero)
        resolveCommand({ stdout, stderr, truncated, exitCode: code })
      else {
        const error = new Error(
          basename(file) +
            ' failed (exit ' +
            String(code) +
            ', signal ' +
            String(signalName) +
            ')',
        )
        error.stderr = stderr
        rejectCommand(error)
      }
    })
  })
}

async function docker(args, options) {
  return await command('docker', args, options)
}

async function git(args, options) {
  return await command('git', args, options)
}

async function log(output, message) {
  await appendFile(
    join(output, 'workflow.log'),
    new Date().toISOString() + ' ' + message + '\n',
  )
}

function scanner(shannonDir) {
  return join(shannonDir, 'shannon')
}

async function checkTools(shannonDir, dependencyHash) {
  const piVersion = (await command('pi', ['--version'])).stdout.trim()
  const parts = piVersion.split('.').map(Number)
  if (
    parts[0] < 1 ||
    (parts[0] === 1 && parts[1] < 2) ||
    parts.some(Number.isNaN)
  ) {
    throw new Error('Pi 1.2.0 or later is required')
  }
  const auth = (
    await command('pi', ['auth', 'check', '--provider', 'openai-codex'])
  ).stdout.trim()
  if (auth !== 'ready') throw new Error('Pi ChatGPT OAuth is not ready')
  await checkScannerSource(shannonDir)
  const workerImageId = await checkScannerBuild(shannonDir, dependencyHash)
  for (const name of workerPiPackages) {
    const installed = JSON.parse(
      await readFile(
        join(
          shannonDir,
          'apps',
          'worker',
          'node_modules',
          name,
          'package.json',
        ),
        'utf8',
      ),
    )
    if (installed.version !== workerPiVersion)
      throw new Error('Shannon worker Pi package version mismatch: ' + name)
  }
  const imageVersions = JSON.parse(
    (
      await docker(
        [
          'run',
          '--rm',
          '--entrypoint',
          'node',
          workerImage,
          '-e',
          'console.log(JSON.stringify(Object.fromEntries(' +
            JSON.stringify(workerPiPackages) +
            '.map(name=>[name,require("/app/apps/worker/node_modules/"+name+"/package.json").version]))))',
        ],
        { timeout: 30 * 1000 },
      )
    ).stdout,
  )
  for (const name of workerPiPackages) {
    if (imageVersions[name] !== workerPiVersion)
      throw new Error('Shannon worker image Pi version mismatch: ' + name)
  }
  const version = JSON.parse(
    (
      await command(scanner(shannonDir), ['version', '--json'], {
        cwd: shannonDir,
      })
    ).stdout,
  )
  if (version.version !== shannonVersion)
    throw new Error('Shannon source version does not match the pinned commit')
  return {
    piVersion,
    workerPiVersion,
    workerImageId,
    shannonVersion: version.version,
  }
}

async function checkScannerSource(shannonDir) {
  if ((await scannerSourceState(shannonDir)) !== 'patched')
    throw new Error('Shannon source is missing the pinned Pi patch')
}

async function scannerSourceState(shannonDir) {
  try {
    await lstat(join(shannonDir, '.env'))
    throw new Error('Shannon checkout .env must be removed before an audit')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const actualCommit = (
    await git(['-C', shannonDir, 'rev-parse', 'HEAD'])
  ).stdout.trim()
  if (actualCommit !== shannonCommit)
    throw new Error('Shannon directory is not at the pinned commit')
  const changed = (
    await git([
      '-C',
      shannonDir,
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      'HEAD',
    ])
  ).stdout
    .split('\0')
    .filter(Boolean)
  const untracked = (
    await git(['-C', shannonDir, 'ls-files', '--others', '--exclude-standard'])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
  if (untracked.some((name) => name !== buildManifestName))
    throw new Error('Shannon source has untracked files')
  if (changed.length === 0) return 'clean'
  if (
    changed.length !== Object.keys(patchedScannerFiles).length ||
    changed.some((name) => !(name in patchedScannerFiles))
  ) {
    throw new Error('Shannon source differs from the pinned Pi patch')
  }
  for (const [file, expected] of Object.entries(patchedScannerFiles)) {
    const actual = createHash('sha256')
      .update(await readFile(join(shannonDir, file)))
      .digest('hex')
    if (actual !== expected)
      throw new Error('Shannon source differs from the pinned Pi patch')
  }
  return 'patched'
}

async function scannerBuildFiles(shannonDir) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) {
        files.push({
          path: relative(shannonDir, file),
          sha256: createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        })
      } else throw new Error('Unexpected Shannon build entry: ' + file)
    }
  }
  await walk(join(shannonDir, 'apps', 'cli', 'dist'))
  await walk(join(shannonDir, 'apps', 'worker', 'dist'))
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function dependencyLinkTrace(file) {
  const hops = []
  const absolute = resolve(file)
  let current = parse(absolute).root
  let pending = absolute.slice(current.length).split(sep)
  while (pending.length > 0) {
    const part = pending.shift()
    if (!part || part === '.') continue
    if (part === '..') {
      current = dirname(current)
      continue
    }
    current = join(current, part)
    if (!(await lstat(current)).isSymbolicLink()) continue
    if (hops.length === 40)
      throw new Error('Too many Shannon dependency link redirects: ' + file)
    const link = await readlink(current)
    hops.push([current, link])
    if (isAbsolute(link)) {
      current = parse(link).root
      pending = [...link.slice(current.length).split(sep), ...pending]
    } else {
      current = dirname(current)
      pending = [...link.split(sep), ...pending]
    }
  }
  return hops
}

export async function scannerDependencyHash(shannonDir) {
  shannonDir = await realpath(shannonDir)
  const hash = createHash('sha256')
  const roots = [
    'node_modules',
    'apps/cli/node_modules',
    'apps/worker/node_modules',
  ]
  const coveredRoots = await Promise.all(
    roots.map((path) => realpath(join(shannonDir, path))),
  )
  const workspaceRoots = await Promise.all(
    ['apps/cli', 'apps/worker'].map((path) => realpath(join(shannonDir, path))),
  )
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const file = join(directory, entry.name)
      const path = relative(shannonDir, file).split(sep).join('/')
      if (entry.isDirectory()) {
        hash.update('directory\0' + path + '\0')
        await walk(file)
      } else if (entry.isFile()) {
        const digest = createHash('sha256')
          .update(await readFile(file))
          .digest('hex')
        hash.update('file\0' + path + '\0' + digest + '\0')
      } else if (entry.isSymbolicLink()) {
        const target = await realpath(file)
        if (
          !coveredRoots.some(
            (covered) => target === covered || target.startsWith(covered + sep),
          ) &&
          !workspaceRoots.includes(target)
        ) {
          throw new Error(
            'Shannon dependency link points outside verified roots: ' +
              file +
              ' -> ' +
              target +
              '. Use the default pnpm virtual store and rerun security:scan:setup',
          )
        }
        hash.update(
          'link\0' +
            path +
            '\0' +
            JSON.stringify(await dependencyLinkTrace(file)) +
            '\0' +
            target +
            '\0',
        )
      } else throw new Error('Unexpected Shannon dependency entry: ' + file)
    }
  }
  for (const path of roots) {
    const directory = join(shannonDir, path)
    hash.update('root\0' + path + '\0')
    await walk(directory)
  }
  return hash.digest('hex')
}

async function checkScannerBuild(shannonDir, expectedDependencyHash) {
  let saved
  try {
    saved = JSON.parse(
      await readFile(join(shannonDir, buildManifestName), 'utf8'),
    )
  } catch {
    throw new Error('Shannon build manifest missing; run security:scan:setup')
  }
  const actual = await scannerBuildFiles(shannonDir)
  const dependencyHash =
    expectedDependencyHash ?? (await scannerDependencyHash(shannonDir))
  const imageId = (
    await docker(['image', 'inspect', workerImage, '--format', '{{.Id}}'])
  ).stdout.trim()
  if (
    saved.commit !== shannonCommit ||
    JSON.stringify(saved.files) !== JSON.stringify(actual) ||
    saved.dependencyHash !== dependencyHash ||
    saved.workerImageId !== imageId
  ) {
    throw new Error('Shannon build output differs from the pinned setup')
  }
  return imageId
}

async function withPreflightServer(work) {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/plain',
      'cache-control': 'no-store',
    })
    response.end('audit preflight\n')
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '0.0.0.0', resolveListen)
  })
  try {
    return await work('http://host.docker.internal:' + server.address().port)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

async function validate(shannonDir) {
  const versions = await checkTools(shannonDir)
  const scratch = await mkdtemp(join(tmpdir(), 'durably-shannon-preflight-'))
  try {
    await writeFile(join(scratch, 'README.md'), 'Benign validation target\n')
    await withPreflightServer(async (url) => {
      await command(
        scanner(shannonDir),
        ['start', '--url', url, '--repo', scratch, '--validate-model'],
        { cwd: shannonDir, env: childEnvironment(), timeout: 3 * 60 * 1000 },
      )
    })
    return versions
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function setup(shannonDir) {
  await checkedOutputPath(shannonDir)
  let existing = false
  try {
    await stat(shannonDir)
    existing = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!existing) {
    await mkdir(dirname(shannonDir), { recursive: true })
    await git(['clone', '--no-checkout', shannonSource, shannonDir], {
      timeout: 10 * 60 * 1000,
    })
    await git(['-C', shannonDir, 'checkout', '--detach', shannonCommit])
  }
  if ((await scannerSourceState(shannonDir)) === 'clean') {
    for (const file of Object.keys(patchedScannerFiles)) {
      await copyFile(join(pinnedShannonFiles, file), join(shannonDir, file))
    }
  }
  await checkScannerSource(shannonDir)
  await command(
    'npx',
    ['--yes', 'pnpm@10.33.0', 'install', '--frozen-lockfile'],
    {
      cwd: shannonDir,
      timeout: 10 * 60 * 1000,
    },
  )
  await command('npx', ['--yes', 'pnpm@10.33.0', 'build'], {
    cwd: shannonDir,
    timeout: 10 * 60 * 1000,
  })
  await command(scanner(shannonDir), ['build'], {
    cwd: shannonDir,
    env: childEnvironment(),
    timeout: 30 * 60 * 1000,
  })
  const workerImageId = (
    await docker(['image', 'inspect', workerImage, '--format', '{{.Id}}'])
  ).stdout.trim()
  const dependencyHash = await scannerDependencyHash(shannonDir)
  await writeFile(
    join(shannonDir, buildManifestName),
    JSON.stringify(
      {
        commit: shannonCommit,
        files: await scannerBuildFiles(shannonDir),
        dependencyHash,
        workerImageId,
      },
      null,
      2,
    ) + '\n',
  )
  await checkTools(shannonDir, dependencyHash)
}

async function sourceRevision() {
  const clean = (await git(['status', '--porcelain=v1'])).stdout
  if (clean !== '')
    throw new Error('The repository worktree must be clean and committed')
  return (await git(['rev-parse', 'HEAD'])).stdout.trim()
}

export async function snapshotSource(temporary, revision, sourceRoot = root) {
  const source = join(temporary, 'source')
  await git(
    [
      'clone',
      '--depth',
      '1',
      '--no-checkout',
      pathToFileURL(sourceRoot).href,
      source,
    ],
    { timeout: 5 * 60 * 1000 },
  )
  await git(['-C', source, 'checkout', '--detach', revision])
  const actual = (await git(['-C', source, 'rev-parse', 'HEAD'])).stdout.trim()
  if (actual !== revision) throw new Error('Source snapshot HEAD changed')
  if ((await git(['-C', source, 'status', '--porcelain=v1'])).stdout !== '') {
    throw new Error('Source snapshot is not clean')
  }
  const tracked = (await git(['-C', source, 'ls-files', '-z'])).stdout
    .split('\0')
    .filter(Boolean)
  if (
    tracked.some((file) => {
      const name = basename(file)
      return (
        name.startsWith('.env') &&
        !['.env.example', '.env.sample', '.env.template'].includes(name)
      )
    })
  ) {
    throw new Error(
      'Committed environment files are not allowed in the audit snapshot',
    )
  }
  return source
}

export function sqliteEvidence(file) {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    const integrity = database
      .prepare('PRAGMA integrity_check')
      .all()
      .map((row) => Object.values(row)[0])
    const schema = database
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name LIKE 'durably_%' OR tbl_name LIKE 'durably_%' ORDER BY type, name",
      )
      .all()
      .map((row) => ({ ...row }))
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'durably_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    const counts = {}
    for (const table of tables) {
      counts[table] = database
        .prepare('SELECT COUNT(*) AS count FROM "' + table + '"')
        .get().count
    }
    const runIds = tables.includes('durably_runs')
      ? database
          .prepare('SELECT id FROM durably_runs ORDER BY id')
          .all()
          .map((row) => row.id)
      : []
    return { integrity, schema, counts, runIds }
  } finally {
    database.close()
  }
}

export function evidenceDiff(before, after) {
  const counts = {}
  for (const table of new Set([
    ...Object.keys(before.counts),
    ...Object.keys(after.counts),
  ])) {
    counts[table] = {
      before: before.counts[table] ?? 0,
      after: after.counts[table] ?? 0,
      change: (after.counts[table] ?? 0) - (before.counts[table] ?? 0),
    }
  }
  const existing = new Set(before.runIds)
  return {
    counts,
    createdRunIds: after.runIds.filter((id) => !existing.has(id)),
  }
}

function resources(id) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid audit resource ID')
  return {
    id,
    image: auditPrefix + 'target:' + id,
    target: auditPrefix + 'target-' + id,
    proxy: auditPrefix + 'proxy-' + id,
    network: auditPrefix + 'isolated-' + id,
    volume: auditPrefix + 'data-' + id,
    workspace: auditPrefix + 'scan-' + id,
    url: 'http://' + auditPrefix + 'proxy-' + id + ':3001',
  }
}

async function saveState(output, state) {
  await writeFile(
    join(output, 'state.json'),
    JSON.stringify(state, null, 2) + '\n',
  )
}

async function readState(output) {
  const state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'))
  const expected = resources(state.id)
  for (const key of [
    'image',
    'target',
    'proxy',
    'network',
    'volume',
    'workspace',
    'url',
  ]) {
    if (state[key] !== expected[key])
      throw new Error('Invalid audit resource state')
  }
  return state
}

async function ignoreDocker(args, output) {
  try {
    await docker(args, { timeout: 45 * 1000 })
  } catch (error) {
    if (
      /No such (container|network|volume|image)|not found/i.test(
        error.stderr ?? '',
      )
    )
      return
    await log(
      output,
      'Cleanup command failed: docker ' + args[0] + ' ' + args[1],
    )
    throw error
  }
}

export async function cleanupResources(state, output, runner = ignoreDocker) {
  const expected = resources(state.id)
  const failures = []
  for (const args of [
    ['rm', '-f', expected.proxy],
    ['rm', '-f', expected.target],
    ['network', 'rm', expected.network],
    ['volume', 'rm', expected.volume],
    ['image', 'rm', expected.image],
  ]) {
    try {
      await runner(args, output)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0)
    throw new Error('Some audit resources could not be removed')
}

async function waitForTarget(state) {
  const deadline = Date.now() + 90 * 1000
  while (Date.now() < deadline) {
    if (state.interrupted) throw new Error('Audit interrupted')
    try {
      await docker(
        [
          'exec',
          state.target,
          'node',
          '-e',
          'fetch("http://127.0.0.1:3000").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
        ],
        { timeout: 10 * 1000 },
      )
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
    }
  }
  throw new Error('Audit target did not become ready')
}

async function waitForProxy(state) {
  const deadline = Date.now() + 30 * 1000
  while (Date.now() < deadline) {
    if (state.interrupted) throw new Error('Audit interrupted')
    try {
      await docker(
        [
          'run',
          '--rm',
          '--network',
          'shannon-net',
          '--entrypoint',
          '/usr/bin/wget',
          proxyImage,
          '-q',
          '-O',
          '/dev/null',
          state.url,
        ],
        { timeout: 10 * 1000 },
      )
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
    }
  }
  throw new Error('Audit proxy did not become ready')
}

async function copyRequired(file, destination) {
  const details = await stat(file)
  if (!details.isFile() || details.size === 0)
    throw new Error('Missing or empty report: ' + basename(file))
  await copyFile(file, destination)
}

export async function collectReports(shannonDir, state, output) {
  const workspace = join(shannonDir, 'workspaces', state.workspace, '.shannon')
  const reports = join(output, 'reports')
  await mkdir(reports, { recursive: true })
  const published = join(output, 'shannon-output')
  const missing = []
  for (const name of [
    'Security-Assessment-Report.md',
    'Security-Assessment-Report.pdf',
    'report.sarif',
  ]) {
    const fallback =
      name === 'report.sarif'
        ? join(workspace, 'deliverables', name)
        : join(
            workspace,
            'deliverables',
            name.replace(
              'Security-Assessment-Report',
              'comprehensive_security_assessment_report',
            ),
          )
    let source = join(published, name)
    try {
      await stat(source)
    } catch {
      source = fallback
    }
    try {
      await copyRequired(source, join(reports, name))
    } catch {
      missing.push(name)
    }
  }
  for (const [name, source] of [
    ['Static-Analysis-Report.md', join(workspace, 'capella', 'report.md')],
    ['static-analysis.sarif', join(workspace, 'capella', 'capella.sarif')],
  ]) {
    try {
      await copyRequired(source, join(reports, name))
    } catch {
      missing.push(name)
    }
  }
  if (missing.length > 0)
    throw new Error('Missing or empty reports: ' + missing.join(', '))
}

export async function captureScannerLog(shannonDir, state, output) {
  const source = join(
    shannonDir,
    'workspaces',
    state.workspace,
    '.shannon',
    'workflow.log',
  )
  const raw = await readFile(source, 'utf8')
  const lines = raw.split(/\r?\n/).map((line) => {
    if (
      line !== '' &&
      !/^\[[^\]]+\] \[[^\]]+\]/.test(line) &&
      !/^(?:Workflow ID|Target URL|Started):/.test(line)
    ) {
      return '[details omitted]'
    }
    const preservePhase = /^\[[^\]]+\] \[(?:PHASE|AGENTIC-SAST)\]/.test(line)
    const payload = line.indexOf('{')
    const colon = preservePhase
      ? -1
      : line.indexOf(': ', line.indexOf('] [') + 3)
    const boundary =
      payload === -1 ? colon : Math.min(payload, colon === -1 ? payload : colon)
    const withoutPayload =
      boundary === -1 ? line : line.slice(0, boundary) + ': [details omitted]'
    return withoutPayload
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
      .replace(
        /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*.*$/gi,
        '[redacted]',
      )
      .replace(
        /\b[A-Za-z0-9_-]*(?:access_token|refresh_token|id_token|api_key|secret|password|token)\s*[:=]\s*.*$/gi,
        '[redacted]',
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        '[redacted]',
      )
      .replace(/\b(?:sk-|gh[pousr]_|shp_)[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
      .slice(0, 1000)
  })
  await writeFile(join(output, 'shannon-workflow.log'), lines.join('\n'))
}

async function stopAndCopyDatabase(state, output) {
  await docker(['stop', state.target], { timeout: 45 * 1000 })
  await docker([
    'cp',
    state.target + ':/data/audit.db',
    join(output, 'after.sqlite'),
  ])
  const after = sqliteEvidence(join(output, 'after.sqlite'))
  if (after.integrity.join(',') !== 'ok')
    throw new Error('Final SQLite integrity check failed')
  return after
}

async function stopUnfinishedScan(state, shannonDir, output) {
  if (state.scanStarted === false) return
  let status
  try {
    const result = await command(
      scanner(shannonDir),
      ['status', state.workspace, '--json'],
      {
        cwd: shannonDir,
        env: childEnvironment(),
        allowNonzero: true,
        timeout: 30 * 1000,
      },
    )
    status = JSON.parse(result.stdout)
  } catch {
    await log(
      output,
      'Shannon status unavailable during cleanup; trying exact-workspace stop',
    )
  }
  if (['completed', 'failed', 'cancelled', 'partial'].includes(status?.status))
    return
  try {
    await command(scanner(shannonDir), ['stop', state.workspace, '--yes'], {
      cwd: shannonDir,
      env: childEnvironment(),
      timeout: 30 * 1000,
    })
  } catch (error) {
    if (/No scan found for workspace:/i.test(error.stderr ?? '')) return
    if (
      !status?.workflowId ||
      !status.workflowId.startsWith(state.workspace + '_')
    ) {
      throw new Error('Could not stop the unfinished Shannon workflow')
    }
    await docker(
      [
        'exec',
        'shannon-temporal',
        'temporal',
        'workflow',
        'terminate',
        '--workflow-id',
        status.workflowId,
        '--reason',
        'Audit operator workflow failed or was interrupted',
      ],
      { timeout: 30 * 1000 },
    )
  }
  await log(output, 'Unfinished Shannon workflow stopped')
}

async function runAudit(options) {
  const output = await checkedOutputPath(options.output)
  try {
    await lstat(output)
    throw new Error('Output directory already exists; use a new directory')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const versions = await validate(options.shannonDir)
  const revision = await sourceRevision()
  await mkdir(output, { recursive: true })
  const state = {
    ...resources(randomUUID().replaceAll('-', '').slice(0, 12)),
    sourceRevision: revision,
    status: 'preparing',
    scanStarted: false,
  }
  await saveState(output, state)
  await log(output, 'Preflight passed; source revision ' + revision)
  const temporary = await mkdtemp(join(tmpdir(), 'durably-shannon-source-'))
  auditSignalActive = true
  const onSignal = () => {
    process.exitCode = 130
    state.interrupted = true
    if (!state.cleaning) abortActiveChildren()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  const ensureRunning = () => {
    if (state.interrupted) throw new Error('Audit interrupted')
  }
  const preparingDocker = async (args, commandOptions) => {
    ensureRunning()
    return await docker(args, commandOptions)
  }
  let failure
  let capturedStatus = false
  let capturedLog = false
  let capturedReports = false
  try {
    ensureRunning()
    const source = await snapshotSource(temporary, revision)
    await log(output, 'Created detached Git source snapshot')
    await preparingDocker(
      [
        'build',
        '-t',
        state.image,
        '-f',
        join(support, 'Dockerfile.audit'),
        source,
      ],
      {
        timeout: 20 * 60 * 1000,
      },
    )
    await preparingDocker(['network', 'create', '--internal', state.network])
    await preparingDocker(['volume', 'create', state.volume])
    await preparingDocker([
      'run',
      '-d',
      '--name',
      state.target,
      '--network',
      state.network,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=64m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      'type=volume,src=' + state.volume + ',dst=/data',
      state.image,
    ])
    await waitForTarget(state)
    await preparingDocker([
      'run',
      '-d',
      '--name',
      state.proxy,
      '--network',
      'shannon-net',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      proxyImage,
      'TCP-LISTEN:3001,fork,reuseaddr',
      'TCP:' + state.target + ':3000',
    ])
    await preparingDocker(['network', 'connect', state.network, state.proxy])
    await waitForProxy(state)
    await preparingDocker([
      'cp',
      state.target + ':/data/audit.db',
      join(output, 'before.sqlite'),
    ])
    const before = sqliteEvidence(join(output, 'before.sqlite'))
    if (before.integrity.join(',') !== 'ok')
      throw new Error('Initial SQLite integrity check failed')
    await writeFile(
      join(output, 'before.json'),
      JSON.stringify(before, null, 2) + '\n',
    )
    const template = await readFile(
      join(support, 'shannon-config.yaml'),
      'utf8',
    )
    if (!template.includes('__TARGET_URL__'))
      throw new Error('Scanner target placeholder is missing')
    const config = template.replaceAll('__TARGET_URL__', state.url)
    await writeFile(join(output, 'shannon-config.yaml'), config)
    await writeFile(
      join(output, 'metadata.json'),
      JSON.stringify(
        {
          sourceRevision: revision,
          piVersion: versions.piVersion,
          workerPiVersion: versions.workerPiVersion,
          workerImageId: versions.workerImageId,
          shannonVersion: versions.shannonVersion,
          model,
          target: 'examples/fullstack',
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    )
    ensureRunning()
    state.status = 'scanning'
    state.scanStarted = true
    await saveState(output, state)
    await log(output, 'Scan started; workspace ' + state.workspace)
    try {
      await command(
        scanner(options.shannonDir),
        [
          'start',
          '--url',
          state.url,
          '--repo',
          source,
          '--config',
          join(output, 'shannon-config.yaml'),
          '--workspace',
          state.workspace,
          '--output',
          join(output, 'shannon-output'),
          '--follow',
        ],
        {
          cwd: options.shannonDir,
          env: childEnvironment(),
          timeout: scanTimeout,
        },
      )
    } catch (error) {
      failure = state.interrupted ? new Error('Audit interrupted') : error
      await log(output, 'Scanner command failed')
    }
    const after = await stopAndCopyDatabase(state, output)
    await writeFile(
      join(output, 'after.json'),
      JSON.stringify(after, null, 2) + '\n',
    )
    await writeFile(
      join(output, 'diff.json'),
      JSON.stringify(evidenceDiff(before, after), null, 2) + '\n',
    )
    await log(output, 'Final SQLite integrity check passed')
    const statusResult = await command(
      scanner(options.shannonDir),
      ['status', state.workspace, '--json'],
      {
        cwd: options.shannonDir,
        env: childEnvironment(),
        allowNonzero: true,
      },
    )
    const status = JSON.parse(statusResult.stdout)
    await writeFile(
      join(output, 'shannon-status.json'),
      JSON.stringify(status, null, 2) + '\n',
    )
    capturedStatus = true
    await captureScannerLog(options.shannonDir, state, output)
    capturedLog = true
    await collectReports(options.shannonDir, state, output)
    capturedReports = true
    if (state.interrupted) throw new Error('Audit interrupted')
    if (failure) throw failure
    if (statusResult.exitCode !== 0)
      throw new Error('Shannon status command failed')
    checkedStatus(status)
    state.status = 'completed'
    await log(output, 'Shannon completed all required phases')
  } catch (error) {
    failure ??= error
    state.status = 'failed'
    state.error = failure.message
    await log(output, 'Audit failed: ' + error.message)
  } finally {
    state.cleaning = true
    if (state.status !== 'completed') {
      if (!capturedLog) {
        try {
          await captureScannerLog(options.shannonDir, state, output)
        } catch {
          await log(output, 'Shannon execution log unavailable')
        }
      }
      if (!capturedStatus) {
        try {
          const result = await command(
            scanner(options.shannonDir),
            ['status', state.workspace, '--json'],
            {
              cwd: options.shannonDir,
              env: childEnvironment(),
              allowNonzero: true,
              timeout: 30 * 1000,
            },
          )
          await writeFile(
            join(output, 'shannon-status.json'),
            JSON.stringify(JSON.parse(result.stdout), null, 2) + '\n',
          )
        } catch {
          await log(output, 'Shannon structured status unavailable')
        }
      }
      if (!capturedReports) {
        try {
          await collectReports(options.shannonDir, state, output)
        } catch {
          await log(output, 'Only available Shannon reports were preserved')
        }
      }
      try {
        await stopUnfinishedScan(state, options.shannonDir, output)
      } catch (error) {
        failure ??= error
        await log(output, 'Failed to stop unfinished Shannon workflow')
      }
    }
    try {
      await cleanupResources(state, output)
      await log(output, 'Audit resources removed')
    } catch (error) {
      failure ??= error
      state.status = 'failed'
      await log(output, error.message)
    }
    try {
      await rm(temporary, { recursive: true, force: true })
    } catch (error) {
      failure ??= error
      state.status = 'failed'
    }
    if (failure) state.error = failure.message
    delete state.cleaning
    await saveState(output, state)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    auditSignalActive = false
  }
  if (failure) throw failure
  return { output, state }
}

async function down(options) {
  const output = await checkedOutputPath(options.output)
  const state = await readState(output)
  let failure
  try {
    await stopUnfinishedScan(state, options.shannonDir, output)
  } catch (error) {
    failure = error
    await log(output, 'Could not stop unfinished Shannon workflow')
  }
  try {
    await cleanupResources(state, output)
    await log(output, 'Manual cleanup completed')
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
}

async function showStatus(options) {
  const output = await checkedOutputPath(options.output)
  const state = await readState(output)
  process.stdout.write(
    JSON.stringify(
      {
        status: state.status,
        sourceRevision: state.sourceRevision,
        workspace: state.workspace,
        output,
      },
      null,
      2,
    ) + '\n',
  )
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.action === 'help') {
    process.stdout.write(
      'Usage: node scripts/shannon-fullstack-audit.mjs setup|validate|run|status|down [--output absolute-directory] [--shannon-dir directory]\n',
    )
    return
  }
  const onSignal = () => {
    process.exitCode = 130
    if (auditSignalActive) return
    if (activeChildren.size === 0) process.exit(130)
    abortActiveChildren()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  try {
    if (options.action === 'setup') {
      await setup(options.shannonDir)
      process.stdout.write('Pinned Shannon build is ready\n')
    } else if (options.action === 'validate') {
      await validate(options.shannonDir)
      process.stdout.write('Pi OAuth, model, and cyber access validated\n')
    } else if (options.action === 'run') {
      const result = await runAudit(options)
      process.stdout.write('Audit completed: ' + result.output + '\n')
    } else if (options.action === 'status') {
      await showStatus(options)
    } else if (options.action === 'down') {
      await down(options)
    } else {
      throw new Error('Unknown action: ' + options.action)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write('Shannon audit: ' + error.message + '\n')
    if (process.exitCode !== 130) process.exitCode = 1
  })
}
