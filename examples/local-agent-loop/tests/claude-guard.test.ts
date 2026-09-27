import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildClaudeSettings,
  COMMAND_MODE_REVIEW_TOOLS,
  decideReviewToolPermission,
  decideToolPermission,
  preToolUseHook,
  reviewPreToolUseHook,
} from '../src/engine/providers/claude.js'
import type { ReviewCallSettings } from '../src/engine/providers/types.js'

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

  it('denies variable expansion the containment check cannot resolve', () => {
    // The tokenizer splits on `$`, so a per-token check would grade
    // `$HOME/.ssh/id_rsa` as the relative path `HOME/.ssh/id_rsa` and allow it.
    for (const cmd of [
      'cat $HOME/.ssh/id_rsa',
      'echo $SECRET',
      'cat ${HOME}/.ssh/id_rsa',
    ]) {
      assert.equal(
        decideToolPermission(ROOT, false, 'Bash', { command: cmd }).allow,
        false,
        cmd,
      )
    }
  })

  it('grades a flag value as a path instead of one opaque token', () => {
    for (const cmd of [
      'node --out=/etc/passwd',
      'node --config=../outside.json',
    ]) {
      assert.equal(
        decideToolPermission(ROOT, false, 'Bash', { command: cmd }).allow,
        false,
        cmd,
      )
    }
    assert.equal(
      decideToolPermission(ROOT, false, 'Bash', {
        command: 'node --out=src/report.json',
      }).allow,
      true,
    )
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

describe('command-mode review guard', () => {
  const MATERIALS = '/runs/r1/candidates/c1'
  const ROOTS = [ROOT, MATERIALS]
  const review = (
    over: Partial<ReviewCallSettings> = {},
  ): ReviewCallSettings => ({
    command: true,
    context: 'prompt',
    output: 'findings-json',
    readableDirs: [MATERIALS],
    ...over,
  })
  type Hook = (input: unknown) => Promise<{
    hookSpecificOutput: { permissionDecision: string }
  }>

  it('runs a command or local instructions with the project and local settings, dontAsk, and four tools', () => {
    for (const settings of [
      buildClaudeSettings(ROOT, true, 'high', null, [], review()),
      buildClaudeSettings(
        ROOT,
        true,
        'high',
        null,
        [],
        review({ command: false, context: 'local-instructions' }),
      ),
    ]) {
      assert.deepEqual(settings.settingSources, ['project', 'local'])
      assert.equal(settings.permissionMode, 'dontAsk')
      assert.deepEqual(settings.tools, ['Read', 'Grep', 'Glob', 'Agent'])
      assert.deepEqual(settings.allowedTools, COMMAND_MODE_REVIEW_TOOLS)
      assert.deepEqual(settings.additionalDirectories, [ROOT, MATERIALS])
      assert.equal(settings.cwd, ROOT)
      assert.equal(settings.effort, 'high')
      assert.equal(settings.resume, undefined)
      assert.equal(typeof settings.canUseTool, 'function')
      const pre = (settings.hooks as Record<string, unknown> | undefined)?.[
        'PreToolUse'
      ]
      assert.ok(Array.isArray(pre) && pre.length > 0)
    }
  })

  it('leaves every other call as it was, a findings-only review included', () => {
    for (const settings of [
      buildClaudeSettings(ROOT, true, null),
      buildClaudeSettings(
        ROOT,
        true,
        null,
        null,
        [],
        review({ command: false, context: 'prompt' }),
      ),
    ]) {
      assert.deepEqual(settings.settingSources, [])
      assert.equal(settings.permissionMode, 'default')
      assert.deepEqual(settings.allowedTools, ['Read'])
      assert.equal(settings.tools, undefined)
      assert.equal(settings.additionalDirectories, undefined)
    }
  })

  it('lets only the read tools and Agent reach only the worktree and the materials', () => {
    const allow = (tool: string, input: Record<string, unknown>) =>
      decideReviewToolPermission(ROOTS, tool, input).allow
    assert.equal(allow('Read', { file_path: 'src/calc.js' }), true)
    assert.equal(
      allow('Read', { file_path: `${MATERIALS}/changes.diff` }),
      true,
    )
    assert.equal(
      allow('Read', { file_path: `${MATERIALS}/head/src/a.js` }),
      true,
    )
    assert.equal(
      allow('Grep', { pattern: 'add', path: `${MATERIALS}/base` }),
      true,
    )
    assert.equal(allow('Grep', { pattern: 'add' }), true)
    assert.equal(allow('Glob', { pattern: 'src/**/*.js' }), true)
    assert.equal(allow('Agent', { prompt: 'review', subagent_type: 'x' }), true)
    assert.equal(allow('Read', { file_path: '/etc/passwd' }), false)
    assert.equal(allow('Read', { file_path: `${MATERIALS}/../other/x` }), false)
    assert.equal(allow('Read', { file_path: '../outside.txt' }), false)
    assert.equal(allow('Grep', { pattern: 'x', path: '/home' }), false)
    assert.equal(allow('Glob', { pattern: '../**/*' }), false)
    assert.equal(allow('Glob', { pattern: '/etc/*' }), false)
    assert.equal(allow('Glob', { pattern: `${MATERIALS}/head/**` }), true)
    for (const tool of [
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'WebFetch',
      'Task',
      'mcp__x__y',
    ])
      assert.equal(
        allow(tool, { file_path: 'src/calc.js', command: 'ls' }),
        false,
        tool,
      )
  })

  it('holds a subagent to the same rules through the PreToolUse hook and canUseTool', async () => {
    const hook = reviewPreToolUseHook(ROOTS) as Hook
    const call = (tool_name: string, tool_input: Record<string, unknown>) =>
      hook({
        hook_event_name: 'PreToolUse',
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
        tool_name,
        tool_input,
      })
    for (const [tool, input] of [
      ['Bash', { command: 'git diff' }],
      ['Write', { file_path: `${ROOT}/src/calc.js`, content: 'x' }],
      ['Edit', { file_path: 'src/calc.js' }],
      ['Read', { file_path: '/etc/passwd' }],
    ] as const)
      assert.equal(
        (await call(tool, input)).hookSpecificOutput.permissionDecision,
        'deny',
        tool,
      )
    assert.equal(
      (await call('Read', { file_path: `${MATERIALS}/base/src/calc.js` }))
        .hookSpecificOutput.permissionDecision,
      'allow',
    )
    const settings = buildClaudeSettings(ROOT, true, null, null, [], review())
    const guard = settings.canUseTool as (
      tool: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string }>
    assert.equal((await guard('Bash', { command: 'ls' })).behavior, 'deny')
    assert.equal(
      (await guard('Read', { file_path: `${MATERIALS}/changes.diff` }))
        .behavior,
      'allow',
    )
  })
})
