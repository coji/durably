import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildClaudeSettings,
  claudeCallUsage,
  COMMAND_MODE_LOCKDOWN,
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
      // Nothing the loaded settings define runs: no hook, no inline shell
      // in a command or skill, no MCP server.
      assert.deepEqual(settings.settings, {
        disableAllHooks: true,
        disableSkillShellExecution: true,
      })
      assert.equal(settings.strictMcpConfig, true)
      assert.deepEqual(settings.mcpServers, {})
      assert.deepEqual(
        {
          settings: settings.settings,
          strictMcpConfig: settings.strictMcpConfig,
          mcpServers: settings.mcpServers,
        },
        COMMAND_MODE_LOCKDOWN,
      )
      assert.equal(settings.permissionMode, 'dontAsk')
      assert.deepEqual(settings.tools, ['Read', 'Grep', 'Glob', 'Agent'])
      assert.deepEqual(settings.allowedTools, COMMAND_MODE_REVIEW_TOOLS)
      // The review's own directory is the cwd, where the settings come
      // from. The candidate's directories are read through the guard and are
      // never additional directories, whose skills, commands and agents
      // Claude Code would load.
      assert.equal(settings.additionalDirectories, undefined)
      assert.equal(settings.cwd, ROOT)
      assert.equal(settings.effort, 'high')
      assert.equal(settings.resume, undefined)
      // Never resumed, so never saved: no project per call piles up.
      assert.equal(settings.persistSession, false)
      assert.equal(typeof settings.canUseTool, 'function')
      const pre = (settings.hooks as Record<string, unknown> | undefined)?.[
        'PreToolUse'
      ]
      assert.ok(Array.isArray(pre) && pre.length > 0)
    }
  })

  it('leaves every other call as it was, and shows a findings-only review Read alone', () => {
    const findingsOnly = buildClaudeSettings(
      ROOT,
      true,
      null,
      null,
      [],
      review({ command: false, context: 'prompt' }),
    )
    for (const settings of [
      buildClaudeSettings(ROOT, true, null),
      findingsOnly,
    ]) {
      assert.deepEqual(settings.settingSources, [])
      assert.equal(settings.permissionMode, 'default')
      assert.deepEqual(settings.allowedTools, ['Read'])
      assert.equal(settings.additionalDirectories, undefined)
      assert.equal(settings.settings, undefined)
      assert.equal(settings.strictMcpConfig, undefined)
      assert.equal(settings.persistSession, undefined)
    }
    assert.equal(buildClaudeSettings(ROOT, true, null).tools, undefined)
    // A refused call makes a configured review incomplete, so a tool it
    // could never use is not offered at all.
    assert.deepEqual(findingsOnly.tools, ['Read'])
  })

  it('refuses a ~ path, whichever tool names it', () => {
    const allow = (tool: string, input: Record<string, unknown>) =>
      decideReviewToolPermission(ROOTS, tool, input).allow
    assert.equal(allow('Read', { file_path: '~/.ssh/id_rsa' }), false)
    assert.equal(allow('Read', { file_path: '~root/.bashrc' }), false)
    assert.equal(allow('Grep', { pattern: 'key', path: '~' }), false)
    assert.equal(allow('Grep', { pattern: 'key', path: '~/.aws' }), false)
    assert.equal(allow('Glob', { pattern: '~/.ssh/*' }), false)
    assert.equal(allow('Glob', { pattern: '*', path: '~' }), false)
  })

  it('resolves symbolic links before it lets a path through', async () => {
    const base = await mkdtemp(join(tmpdir(), 'review-guard-'))
    const work = join(base, 'work')
    const materials = join(base, 'materials')
    const outside = join(base, 'outside')
    await mkdir(join(work, 'src'), { recursive: true })
    await mkdir(join(materials, 'head'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret\n')
    await writeFile(join(work, 'src', 'a.js'), 'a\n')
    // Links a candidate or a snapshot may carry: out of every root, and
    // within one.
    await symlink(outside, join(work, 'escape'))
    await symlink(
      join(outside, 'secret.txt'),
      join(materials, 'head', 'secret'),
    )
    await symlink(join(work, 'src', 'a.js'), join(work, 'inner.js'))
    const roots = [work, materials]
    const allow = (tool: string, input: Record<string, unknown>) =>
      decideReviewToolPermission(roots, tool, input).allow
    assert.equal(allow('Read', { file_path: 'escape/secret.txt' }), false)
    assert.equal(
      allow('Read', { file_path: join(work, 'escape', 'secret.txt') }),
      false,
    )
    assert.equal(
      allow('Read', { file_path: join(materials, 'head', 'secret') }),
      false,
    )
    assert.equal(allow('Grep', { pattern: 'secret', path: 'escape' }), false)
    assert.equal(
      allow('Grep', { pattern: 'secret', path: join(work, 'escape') }),
      false,
    )
    assert.equal(allow('Glob', { pattern: 'escape/*' }), false)
    assert.equal(allow('Glob', { pattern: '*.txt', path: 'escape' }), false)
    assert.equal(
      allow('Glob', { pattern: `${join(work, 'escape')}/**/*` }),
      false,
    )
    // A link that stays inside, a file not yet there, and the roots
    // themselves (a temporary directory is often reached through a link)
    // still pass.
    assert.equal(allow('Read', { file_path: 'inner.js' }), true)
    assert.equal(allow('Read', { file_path: 'src/missing.js' }), true)
    assert.equal(allow('Read', { file_path: join(materials, 'head') }), true)
    assert.equal(allow('Grep', { pattern: 'a', path: 'src' }), true)
    assert.equal(allow('Glob', { pattern: 'src/**/*.js' }), true)
  })

  it('lets a subagent start only in place', () => {
    const allow = (input: Record<string, unknown>) =>
      decideReviewToolPermission(ROOTS, 'Agent', input).allow
    assert.equal(
      allow({ description: 'd', prompt: 'review', subagent_type: 'x' }),
      true,
    )
    for (const isolation of ['worktree', 'remote'])
      assert.equal(allow({ prompt: 'review', isolation }), false, isolation)
    // Defence in depth: a mode that would widen a subagent is refused.
    assert.equal(allow({ prompt: 'review', mode: 'dontAsk' }), true)
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions'])
      assert.equal(allow({ prompt: 'review', mode }), false, mode)
  })

  it('counts subagents through modelUsage in command mode only', () => {
    const mainLoop = {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 50,
      totalTokens: 1_100,
    }
    const modelUsage = {
      'claude-opus-5-5': {
        inputTokens: 150,
        outputTokens: 100,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 50,
      },
      'claude-fable-5-1': {
        inputTokens: 40,
        outputTokens: 30,
        cacheReadInputTokens: 2_000,
        cacheCreationInputTokens: 10,
      },
    }
    // A default call and a findings-only review keep the main loop's usage
    // exactly, whatever the result message carries.
    for (const settings of [
      undefined,
      null,
      review({ command: false, context: 'prompt' }),
    ]) {
      const { usage, usageByModel } = claudeCallUsage(
        settings,
        mainLoop,
        modelUsage,
      )
      assert.deepEqual(usage, {
        inputTokens: 1_000,
        cachedInputTokens: 850,
        cacheReadTokens: 800,
        cacheWriteTokens: 50,
        outputTokens: 100,
        totalTokens: 1_100,
        usageSource: 'provider-final',
      })
      assert.equal(usageByModel, null)
    }
    const counted = claudeCallUsage(review(), mainLoop, modelUsage)
    assert.equal(counted.usage?.outputTokens, 130)
    assert.equal(counted.usage?.inputTokens, 1_000 + 2_050)
    assert.deepEqual(Object.keys(counted.usageByModel ?? {}), [
      'claude-opus-5-5',
      'claude-fable-5-1',
    ])
    assert.equal(counted.usageByModel?.['claude-fable-5-1']?.inputTokens, 2_050)
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
