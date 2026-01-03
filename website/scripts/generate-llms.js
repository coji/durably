/**
 * Generate combined llms.txt from package documentation
 *
 * This script concatenates llms.md from both @coji/durably and @coji/durably-react
 * into a single llms.txt file for the website.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

const coreLlms = readFileSync(
  join(rootDir, '../packages/durably/docs/llms.md'),
  'utf-8',
)
const reactLlms = readFileSync(
  join(rootDir, '../packages/durably-react/docs/llms.md'),
  'utf-8',
)

const combined = `${coreLlms}

---

${reactLlms}
`

writeFileSync(join(rootDir, 'public/llms.txt'), combined)

console.log('Generated public/llms.txt')
