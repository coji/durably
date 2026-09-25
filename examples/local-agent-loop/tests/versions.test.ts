import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, it } from 'node:test'

import { claudeExecutable } from '../src/engine/providers/claude.js'
import { codexExecutable } from '../src/engine/providers/codex.js'
import { resolveVersions } from '../src/engine/versions.js'

describe('recorded CLI versions', { timeout: 60000 }, () => {
  it('names the Codex CLI the provider launches, not one on PATH', async () => {
    const exe = codexExecutable()
    // This workspace installs the provider's own `@openai/codex`, which the
    // provider prefers to any `codex` on PATH.
    assert.equal(exe.command, 'node')
    assert.match(exe.path ?? '', /@openai[/\\]codex[/\\]bin[/\\]codex\.js$/)
    assert.deepEqual(exe.args, [exe.path])
    const versions = await resolveVersions('codex')
    assert.equal(versions['codexCliPath'], exe.path)
    // Whatever the version is, it came from that file, or it is unknown.
    const version = versions['codexCli']
    assert.ok(version === null || /\d+\.\d+\.\d+/.test(version), version ?? '')
  })

  it('names the native binary the Claude Agent SDK launches', async () => {
    const path = claudeExecutable()
    const versions = await resolveVersions('claude')
    assert.equal(versions['claudeCliPath'], path)
    if (path === null) {
      // Not installed for this platform: unknown, never a PATH guess.
      assert.equal(versions['claudeCli'], null)
      return
    }
    assert.ok(existsSync(path))
    assert.match(path, /claude-agent-sdk-[^/\\]+[/\\]claude(\.exe)?$/)
  })

  it('probes nothing for the fake provider', async () => {
    const versions = await resolveVersions('fake')
    assert.equal('codexCliPath' in versions, false)
    assert.equal('claudeCliPath' in versions, false)
  })
})
