import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildClaudeSettings,
  decideToolPermission,
  preToolUseHook,
} from '../src/providers/claude.js'

const ROOT = '/demo/work'

describe('claude workdir guard (reviewer repro)', () => {
  it('denies dot-dot escapes even when the raw string starts with the root', () => {
    const d = decideToolPermission(ROOT, false, 'Read', {
      file_path: '/demo/work/../outside.txt',
    })
    assert.equal(d.allow, false)
  })

  it('denies absolute paths outside the root and allows inside ones', () => {
    assert.equal(
      decideToolPermission(ROOT, false, 'Write', { file_path: '/etc/passwd' })
        .allow,
      false,
    )
    assert.equal(
      decideToolPermission(ROOT, false, 'Write', {
        file_path: '/demo/work/src/calc.js',
      }).allow,
      true,
    )
    assert.equal(
      decideToolPermission(ROOT, false, 'Edit', {
        file_path: 'src/calc.js',
      }).allow,
      true,
    )
    assert.equal(
      decideToolPermission(ROOT, false, 'Edit', {
        file_path: '../../outside.txt',
      }).allow,
      false,
    )
  })

  it('keeps review roles read-only inside the snapshot', () => {
    assert.equal(
      decideToolPermission(ROOT, true, 'Bash', { command: 'npm test' }).allow,
      false,
    )
    assert.equal(
      decideToolPermission(ROOT, true, 'Read', {
        file_path: '/demo/work/src/calc.js',
      }).allow,
      true,
    )
    assert.equal(
      decideToolPermission(ROOT, true, 'Read', { file_path: '/etc/passwd' })
        .allow,
      false,
    )
  })

  it('vets Bash on the execution path, not just file tools', () => {
    assert.equal(
      decideToolPermission(ROOT, false, 'Bash', { command: 'npm test' }).allow,
      true,
    )
    for (const cmd of [
      'cat /etc/passwd',
      'cat ../outside.txt',
      'node --test /tmp/other',
      'cp src/a.js ~/escape.js',
      'echo $(cat /etc/passwd)',
      'echo `cat /etc/passwd`',
    ]) {
      assert.equal(
        decideToolPermission(ROOT, false, 'Bash', { command: cmd }).allow,
        false,
        cmd,
      )
    }
  })

  it('PreToolUse hook denies with the Agent SDK decision shape', async () => {
    const hook = preToolUseHook(ROOT, false)
    const denied = (await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/demo/work/../outside.txt' },
    })) as {
      hookSpecificOutput: {
        permissionDecision: string
        permissionDecisionReason?: string
      }
    }
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
    assert.ok(
      (denied.hookSpecificOutput.permissionDecisionReason ?? '').length > 0,
    )
    const allowed = (await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    })) as { hookSpecificOutput: { permissionDecision: string } }
    assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow')
  })

  it('wires the same guard through BOTH canUseTool and PreToolUse', () => {
    for (const readOnly of [false, true]) {
      const settings = buildClaudeSettings(ROOT, readOnly, null)
      assert.equal(typeof settings.canUseTool, 'function')
      const pre = (settings.hooks as Record<string, unknown> | undefined)?.[
        'PreToolUse'
      ]
      assert.ok(
        Array.isArray(pre) && pre.length > 0,
        'PreToolUse hook must inspect every call (allowedTools bypasses canUseTool)',
      )
    }
    const impl = buildClaudeSettings(ROOT, false, null)
    assert.deepEqual(impl.allowedTools, ['Read', 'Edit', 'Write', 'Bash'])
    const review = buildClaudeSettings(ROOT, true, null)
    assert.deepEqual(review.allowedTools, ['Read'])
  })
})
