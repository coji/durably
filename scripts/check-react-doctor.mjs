import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { projects: expectedProjects } = JSON.parse(
  readFileSync(new URL('../doctor.config.json', import.meta.url), 'utf8'),
)

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'react-doctor',
    '--scope',
    'full',
    '--no-cache',
    '--no-supply-chain',
    '--json',
    '--json-compact',
    '--blocking',
    'none',
  ],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
)

if (result.error) throw result.error
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout)
  process.exit(result.status ?? 1)
}

const report = JSON.parse(result.stdout)
const actualNames = report.projects?.map(
  (project) => project.project?.projectName,
)
if (
  !report.ok ||
  !Array.isArray(actualNames) ||
  actualNames.length !== expectedProjects.length ||
  new Set(actualNames).size !== expectedProjects.length ||
  actualNames.some((name) => !expectedProjects.includes(name))
) {
  process.stderr.write('React Doctor scan was incomplete.\n')
  process.exit(1)
}

let failed = false
for (const project of report.projects) {
  const name = project.project.projectName
  const score = project.score?.score
  process.stdout.write(`${name}: ${score ?? 'no score'}/100\n`)
  if (
    !project.complete ||
    project.analyzedFileCount === 0 ||
    score !== 100 ||
    project.diagnostics?.length > 0
  ) {
    failed = true
    for (const diagnostic of project.diagnostics ?? []) {
      process.stdout.write(
        `  ${diagnostic.filePath}:${diagnostic.line} ${diagnostic.plugin}/${diagnostic.rule} ${diagnostic.message}\n`,
      )
    }
  }
}

if (failed) process.exitCode = 1
