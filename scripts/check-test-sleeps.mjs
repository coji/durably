// Reject a `setTimeout` in a test file unless a `sleep-ok` comment says why
// it cannot make the test flaky.
//
// A sleep used to wait for something to happen is a guess about how long it
// takes, and a loaded CI runner eventually makes the guess wrong. Order work
// with `vi.waitFor`, a deferred gate, or the helpers in
// `packages/durably/tests/helpers/sync.ts` instead. A sleep that cannot cause
// a false failure stays, with a marker on its line or in the comment directly
// above it:
//
//   // sleep-ok(<kind>): <why>
//
// Kinds:
//   negative  waits so that something that must NOT happen has a chance to;
//             a slow machine can only hide a bug, never fail the test
//   work      simulated work whose length nothing depends on
//   guard     a deadline that fails or ends a wait, not one that orders it
//   clock     elapsed time itself is under test, with a wide margin
//   fake      runs under vi.useFakeTimers
//   yield     lets pending callbacks run; nothing depends on how long
//   poll      one tick of a loop that re-checks a condition until it holds
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const kinds = new Set(['negative', 'work', 'guard', 'clock', 'fake', 'yield', 'poll'])
const marker = /sleep-ok\((\w+)\):\s*\S/

function* testFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('__')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* testFiles(path)
    else if (/\.tsx?$/.test(entry.name)) yield path
  }
}

const problems = []
let marked = 0
for (const pkg of readdirSync(join(root, 'packages'))) {
  const tests = join(root, 'packages', pkg, 'tests')
  let files
  try {
    files = [...testFiles(tests)]
  } catch {
    continue
  }
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (!line.includes('setTimeout(')) return
      // The marker sits on this line or in the comment block right above the
      // statement, which may start a few lines up when it wraps.
      let found = line.match(marker)
      let start = index
      while (start > 0 && index - start < 3 && /(\(|=>)\s*$/.test(lines[start - 1]))
        start--
      for (let i = start - 1; !found && i >= 0; i--) {
        const above = lines[i].trim()
        if (!above.startsWith('//')) break
        found = above.match(marker)
      }
      const at = `${relative(root, file)}:${index + 1}`
      if (!found) problems.push(`${at}  setTimeout without a sleep-ok marker`)
      else if (!kinds.has(found[1]))
        problems.push(`${at}  unknown sleep-ok kind "${found[1]}"`)
      else marked++
    })
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  console.error(
    `\n${problems.length} unexplained sleep(s) in tests. Replace a sleep that` +
      ' waits for something with vi.waitFor or a deferred gate; mark one that' +
      ' cannot cause a false failure. See scripts/check-test-sleeps.mjs.',
  )
  process.exit(1)
}
console.log(`test sleeps ok: ${marked} marked`)
