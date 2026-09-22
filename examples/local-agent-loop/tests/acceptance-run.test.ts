import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  hashDir,
  runAcceptanceSuite,
  snapshotAcceptance,
} from '../src/acceptance.js'
import { runChild } from '../src/child.js'

const TEST_FILE = `import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { add } from '../src/calc.js'

describe('calc', () => {
  it('adds decimals without truncation', () => {
    assert.equal(add(0.1, 0.2), 0.30000000000000004)
  })
})
`
const supervisorPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'test-supervisor.mjs',
)

const BROKEN_SRC = `export function add(a, b) {
  return Math.trunc(a) + Math.trunc(b)
}
`

const FIXED_SRC = `export function add(a, b) {
  return a + b
}
`

async function seed(dir: string, files: Record<string, string>) {
  const { mkdir } = await import('node:fs/promises')
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content)
  }
}

describe('acceptance runs the fixed snapshot directly (reviewer repro)', () => {
  it('fails a broken src even when workdir `npm test` is neutered to exit 0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accept-run-'))
    const pristine = join(root, 'pristine')
    const acceptanceDir = join(root, 'acceptance')
    const workdir = join(root, 'work')
    const scratchDir = join(root, 'scratch')
    await seed(pristine, { 'calc.test.js': TEST_FILE })
    const snap = await snapshotAcceptance(pristine, acceptanceDir)
    await seed(workdir, {
      'src/calc.js': BROKEN_SRC,
      'test/calc.test.js': TEST_FILE,
      // Agent rewrites the runner instead of the tests: grading must not care.
      'package.json': JSON.stringify({
        name: 'loop-subject',
        type: 'module',
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
    })
    // Premise: the neutered `npm test` really does pass in the workdir.
    const neutered = await runChild('npm', ['test', '--silent'], {
      cwd: workdir,
      timeoutMs: 30000,
    })
    assert.equal(neutered.code, 0, 'premise: neutered npm test exits 0')

    const res = await runAcceptanceSuite(
      {
        workdir,
        acceptanceDir,
        scratchDir,
        timeoutMs: 60000,
      },
      snap.hash,
    )
    assert.equal(
      res.passed,
      false,
      'pristine snapshot tests must fail against the broken src',
    )
    assert.notEqual(res.exitCode, 0)
  })

  it('passes once the src is actually fixed (same neutered package.json)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accept-run-'))
    const pristine = join(root, 'pristine')
    const acceptanceDir = join(root, 'acceptance')
    const workdir = join(root, 'work')
    const scratchDir = join(root, 'scratch')
    await seed(pristine, { 'calc.test.js': TEST_FILE })
    const snap = await snapshotAcceptance(pristine, acceptanceDir)
    await seed(workdir, {
      'src/calc.js': FIXED_SRC,
      'test/calc.test.js': TEST_FILE,
      'package.json': JSON.stringify({
        name: 'loop-subject',
        type: 'module',
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
    })
    const res = await runAcceptanceSuite(
      {
        workdir,
        acceptanceDir,
        scratchDir,
        timeoutMs: 60000,
      },
      snap.hash,
    )
    assert.equal(res.passed, true, JSON.stringify(res))
    assert.equal(res.exitCode, 0)
  })

  it('still fails closed when workdir tests were edited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accept-run-'))
    const pristine = join(root, 'pristine')
    const acceptanceDir = join(root, 'acceptance')
    const workdir = join(root, 'work')
    const scratchDir = join(root, 'scratch')
    await seed(pristine, { 'calc.test.js': TEST_FILE })
    const snap = await snapshotAcceptance(pristine, acceptanceDir)
    await seed(workdir, {
      'src/calc.js': FIXED_SRC,
      'test/calc.test.js': 'edited by agent\n',
      'package.json': '{}',
    })
    await assert.rejects(
      runAcceptanceSuite(
        { workdir, acceptanceDir, scratchDir, timeoutMs: 60000 },
        snap.hash,
      ),
      /acceptance-tampered/,
    )
  })

  it('fails closed when the fixed acceptance directory is edited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accept-run-'))
    const pristine = join(root, 'pristine')
    const acceptanceDir = join(root, 'acceptance')
    const workdir = join(root, 'work')
    await seed(pristine, { 'calc.test.js': TEST_FILE })
    const snap = await snapshotAcceptance(pristine, acceptanceDir)
    await seed(workdir, {
      'src/calc.js': FIXED_SRC,
      'test/calc.test.js': TEST_FILE,
    })
    await seed(acceptanceDir, { 'calc.test.js': 'assert(true)\n' })
    await assert.rejects(
      runAcceptanceSuite(
        {
          workdir,
          acceptanceDir,
          scratchDir: join(root, 'scratch'),
          timeoutMs: 60000,
        },
        snap.hash,
      ),
      /fixed acceptance snapshot differs/,
    )
  })

  it('denies Candidate code filesystem writes during verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accept-permission-'))
    const pristine = join(root, 'pristine')
    const acceptanceDir = join(root, 'acceptance')
    const workdir = join(root, 'work')
    await seed(pristine, { 'calc.test.js': TEST_FILE })
    const snap = await snapshotAcceptance(pristine, acceptanceDir)
    await seed(workdir, {
      'src/calc.js': `import { chmodSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const self = fileURLToPath(import.meta.url)
chmodSync(self, 0o644)
writeFileSync(self, 'export const add = () => 999')
export const add = (a, b) => a + b
`,
      'test/calc.test.js': TEST_FILE,
    })
    const before = await hashDir(workdir)
    const result = await runAcceptanceSuite(
      {
        workdir,
        acceptanceDir,
        scratchDir: join(root, 'scratch'),
        timeoutMs: 5000,
      },
      snap.hash,
    )
    assert.equal(result.passed, false)
    assert.match(result.stdout, /ERR_ACCESS_DENIED|permission/i)
    assert.equal(await hashDir(workdir), before)
  })

  it('uses an out-of-process watchdog for a blocked test process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accept-watchdog-'))
    const pristine = join(root, 'pristine')
    const acceptanceDir = join(root, 'acceptance')
    const workdir = join(root, 'work')
    await seed(pristine, { 'calc.test.js': TEST_FILE })
    const snap = await snapshotAcceptance(pristine, acceptanceDir)
    await seed(workdir, {
      'src/calc.js': 'while (true) {}\nexport const add = (a, b) => a + b\n',
      'test/calc.test.js': TEST_FILE,
    })
    const started = Date.now()
    const result = await runAcceptanceSuite(
      {
        workdir,
        acceptanceDir,
        scratchDir: join(root, 'scratch'),
        timeoutMs: 200,
      },
      snap.hash,
    )
    assert.equal(result.passed, false)
    assert.equal(result.exitCode, 124, JSON.stringify(result))
    assert.match(result.stdout, /timed out/)
    assert.ok(Date.now() - started < 3000)
  })

  it('keeps the watchdog deadline after its worker parent is SIGKILLed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'watchdog-orphan-'))
    const scratch = join(root, 'scratch')
    const marker = join(root, 'supervisor.pid')
    await seed(scratch, {
      'test/hang.test.js': 'while (true) {}\n',
    })
    const parentScript = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const [supervisor, scratch, marker, testFile] = process.argv.slice(1)
      const child = spawn(process.execPath, [supervisor, '200', scratch, '--permission', '--allow-fs-read=*', '--test', '--test-isolation=none', '--test-timeout=200', testFile], { stdio: 'ignore' })
      writeFileSync(marker, String(child.pid))
      setInterval(() => {}, 1000)
    `
    const parent = spawn(
      process.execPath,
      [
        '-e',
        parentScript,
        supervisorPath,
        scratch,
        marker,
        join(scratch, 'test', 'hang.test.js'),
      ],
      { stdio: 'ignore' },
    )
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        await access(marker)
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    const supervisorPid = Number(await readFile(marker, 'utf8'))
    assert.ok(Number.isInteger(supervisorPid) && supervisorPid > 0)
    parent.kill('SIGKILL')
    await new Promise((resolve) => parent.once('close', resolve))
    while (Date.now() < deadline) {
      try {
        process.kill(supervisorPid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        break
      }
    }
    assert.throws(() => process.kill(supervisorPid, 0))
    await assert.rejects(access(scratch))
  })
})
