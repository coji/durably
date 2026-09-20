import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const examples = [
  ['fullstack', './app/routes/_index/dashboard.tsx'],
  ['fullstack-vercel-turso', './app/routes/_index/dashboard.tsx'],
  ['spa-react-router', './app/routes/_index/dashboard.tsx'],
  ['spa-vite', './src/components/dashboard.tsx'],
]

for (const [name, entry] of examples) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `await import('${entry}')`,
    ],
    {
      cwd: fileURLToPath(new URL(`../examples/${name}/`, import.meta.url)),
      encoding: 'utf8',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exit(result.status ?? 1)
  }
  process.stdout.write(`${name}: dashboard import ok\n`)
}
