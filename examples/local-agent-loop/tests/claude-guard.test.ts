import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { claudeCode, type SDKMessage } from 'ai-sdk-provider-claude-code'

import {
  buildClaudeSettings,
  ClaudeProvider,
  EFFORT_RESUME_BLOCKING_ENV,
  EFFORT_RESUME_MODELS_LABEL,
  observedClaudeModel,
  parseCliVersion,
  claudeCallUsage,
  claudePartialUsage,
  claudeSessionId,
  COMMAND_MODE_LOCKDOWN,
  COMMAND_MODE_REVIEW_TOOLS,
  decideReviewToolPermission,
  decideToolPermission,
  keepingGuardReasons,
  permissionDenialsOf,
  preToolUseHook,
  reviewPreToolUseHook,
} from '../src/engine/providers/claude.js'
import type { ReviewCallSettings } from '../src/engine/providers/types.js'
import { fixProfile } from '../src/factory/job.js'
import {
  confirmRepairSession,
  type ConfirmedRepairSession,
  repairSessionDecision,
  sessionHandlingOf,
  type ExecutionProfile,
  type RepairSessionInput,
  type SessionRef,
} from '../src/factory/types.js'

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
  it("names a refused Glob's pattern and path, and records the guard's reason with the provider's denial", async () => {
    const reason = (input: Record<string, unknown>) => {
      const d = decideReviewToolPermission(ROOTS, 'Glob', input)
      return d.allow ? null : d.reason
    }
    assert.equal(
      reason({ pattern: '/etc/*', path: 'src' }),
      "glob outside the review's directories denied: /etc/* (path src)",
    )
    assert.equal(
      reason({ pattern: '../**/*' }),
      "glob outside the review's directories denied: ../**/* (path not given)",
    )
    // The decisions themselves are unchanged.
    // Refused for its path argument rather than its pattern: both named.
    assert.equal(
      reason({ pattern: '**/node_modules/parse5/**', path: '/etc' }),
      "glob outside the review's directories denied: **/node_modules/parse5/** (path /etc)",
    )
    assert.equal(reason({ pattern: 'src/**/*.js', path: ROOT }), null)
    assert.equal(reason({ pattern: `${MATERIALS}/head/**` }), null)

    // A hook's denial reaches the result's list without a reason: the
    // guard's own reason for that tool call is kept and used.
    const reasons = new Map<string, string>()
    const settings = keepingGuardReasons(
      buildClaudeSettings(ROOT, true, null, null, [], review()),
      reasons,
    )
    const hook = settings.hooks?.PreToolUse?.[0]?.hooks[0]
    assert.ok(hook)
    const input = (tool_input: Record<string, unknown>) =>
      ({
        hook_event_name: 'PreToolUse',
        tool_name: 'Glob',
        tool_input,
      }) as unknown as Parameters<typeof hook>[0]
    const signal = new AbortController().signal
    const denied = await hook(
      input({ pattern: '/etc/*', path: 'src' }),
      'tu-1',
      {
        signal,
      },
    )
    assert.equal(
      (denied as { hookSpecificOutput: { permissionDecision: string } })
        .hookSpecificOutput.permissionDecision,
      'deny',
    )
    await hook(input({ pattern: 'src/**/*.js' }), 'tu-2', { signal })
    assert.deepEqual(
      [...reasons],
      [
        [
          'tu-1',
          "glob outside the review's directories denied: /etc/* (path src)",
        ],
      ],
    )
    assert.deepEqual(
      permissionDenialsOf(
        [
          { toolName: 'Glob', toolUseId: 'tu-1' },
          { toolName: 'Read', toolUseId: 'tu-3', reason: 'given' },
          { toolName: 'Grep', toolUseId: 'tu-4' },
        ],
        reasons,
      ),
      [
        "Glob: glob outside the review's directories denied: /etc/* (path src)",
        'Read: given',
        'Grep',
      ],
    )
  })
})

describe('a repair that resumes the implementation session at its own effort', () => {
  it('passes the session as resume and the repair effort as effort to the Agent SDK', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'claude-resume-'))
    const provider = new ClaudeProvider()
    // The runner hands the repair profile's effective model and effort to
    // the call; the provider resolves them to the same values.
    const { model, effort } = provider.resolveExecution({
      requestedModel: 'claude-opus-5-5',
      requestedEffort: 'high',
    })
    assert.deepEqual([model, effort], ['claude-opus-5-5', 'high'])
    const settings = buildClaudeSettings(workdir, false, effort, 'native-1')
    assert.equal(settings.resume, 'native-1')
    assert.equal(settings.effort, 'high')
    // What the provider package actually sends to the Agent SDK's query.
    const language = claudeCode(model ?? '', {
      ...settings,
      logger: false,
    }) as unknown as {
      getEffectiveResume: (sdk: undefined) => string | undefined
      createQueryOptions: (
        abort: AbortController,
        options: { prompt: unknown[] },
        stderr: undefined,
        sdk: undefined,
        resume: string | undefined,
      ) => { resume?: string; effort?: string; model?: string }
    }
    const resume = language.getEffectiveResume(undefined)
    const query = language.createQueryOptions(
      new AbortController(),
      { prompt: [] },
      undefined,
      undefined,
      resume,
    )
    assert.equal(query.resume, 'native-1')
    assert.equal(query.effort, 'high')
    assert.equal(query.model, 'claude-opus-5-5')
    // A new session names no session to resume.
    assert.equal(buildClaudeSettings(workdir, false, 'high').resume, undefined)
  })
})

describe('whether a repair continues the session across an effort change', () => {
  const claude = (
    effort: string,
    model = 'claude-opus-5-5',
  ): ExecutionProfile => ({
    provider: 'claude',
    requestedModel: model,
    effectiveModel: model,
    effectiveEffort: effort,
  })
  const base: RepairSessionInput = {
    contextMode: 'reuse',
    code: claude('medium'),
    repair: claude('high'),
    claudeCliVersion: '2.1.280 (Claude Code)',
    env: {},
    fakeEffortResume: false,
  }
  const decide = (patch: Partial<RepairSessionInput>) =>
    repairSessionDecision({ ...base, ...patch })

  it('allows it at setup on Opus 5.5 or Fable 5.1 with Claude Code 2.1.260 or later, pending the model preflight sees', () => {
    const allowed = decide({})
    assert.equal(allowed.eligible, true)
    assert.equal(EFFORT_RESUME_MODELS_LABEL, 'Opus 5.5 or Fable 5.1')
    // Setup never confirms a continuation: only preflight does, and the
    // setup step adds the version the run takes once it has.
    assert.equal('continues' in allowed, false)
    assert.equal(allowed.confirmedConfigVersion, undefined)
    assert.equal(
      decide({
        code: claude('low', 'claude-fable-5-1'),
        repair: claude('high', 'claude-fable-5-1'),
      }).eligible,
      true,
    )
    assert.equal(decide({ claudeCliVersion: '2.1.260' }).eligible, true)
    assert.equal(decide({ claudeCliVersion: '2.2.0' }).eligible, true)
    assert.equal(decide({ claudeCliVersion: '3.0.0' }).eligible, true)
  })

  it('allows it with an optional date suffix or the [1m] context suffix', () => {
    assert.equal(
      decide({
        code: claude('low', 'claude-opus-5-5[1m]'),
        repair: claude('high', 'claude-opus-5-5[1m]'),
      }).eligible,
      true,
    )
    assert.equal(
      decide({
        code: claude('low', 'claude-fable-5-1-20260901'),
        repair: claude('high', 'claude-fable-5-1-20260901'),
      }).eligible,
      true,
    )
  })

  it('starts new for fresh context, another provider or full model id, or the same effort', () => {
    assert.match(decide({ contextMode: 'fresh' }).reason, /context is fresh/)
    assert.equal(decide({ contextMode: 'fresh' }).eligible, false)
    const codex = {
      provider: 'codex' as const,
      requestedModel: 'gpt-6-sol',
      effectiveModel: 'gpt-6-sol',
    }
    assert.equal(
      decide({ repair: { ...codex, effectiveEffort: 'high' } }).eligible,
      false,
    )
    const other = decide({ repair: claude('high', 'claude-fable-5-1') })
    assert.equal(other.eligible, false)
    assert.match(other.reason, /another model/)
    const sameEffort = decide({ repair: claude('medium', 'claude-fable-5-1') })
    assert.equal(sameEffort.eligible, false)
    assert.match(sameEffort.reason, /same effort as code/)
    // Codex never changes effort mid-session here.
    const codexRun = decide({
      code: { ...codex, effectiveEffort: 'medium' },
      repair: { ...codex, effectiveEffort: 'high' },
    })
    assert.equal(codexRun.eligible, false)
    assert.match(codexRun.reason, /codex/)
  })

  it('rules out a full model id that is not listed on either side, without waiting for preflight', () => {
    const alias = (effort: string, model: string): ExecutionProfile => ({
      ...claude(effort, model),
      effectiveModel: model,
    })
    for (const [code, repair, unlisted] of [
      [
        alias('medium', 'opus'),
        claude('high', 'claude-sonnet-5'),
        'claude-sonnet-5',
      ],
      [
        claude('medium', 'claude-haiku-4-5'),
        alias('high', 'opus'),
        'claude-haiku-4-5',
      ],
    ] as const) {
      const decision = decide({ code, repair })
      assert.equal(decision.eligible, false, unlisted)
      assert.equal(
        decision.reason,
        `${unlisted} is not ${EFFORT_RESUME_MODELS_LABEL}`,
      )
    }
    // An alias with a listed full id is left to preflight.
    assert.equal(
      decide({ code: alias('medium', 'opus'), repair: claude('high') })
        .eligible,
      true,
    )
  })

  it('says so when the repair differs from code only in how it spells the call', () => {
    // Another spelling of the same effective model and effort is its own
    // profile (`executionKey` compares the requested spelling), but nothing
    // but the spelling differs, and the reason says that.
    const fake = (requestedModel: string | null) => ({
      provider: 'fake' as const,
      requestedModel,
      effectiveModel: 'fake-model',
      effectiveEffort: 'low',
    })
    const spelled = decide({ code: fake('fake'), repair: fake(null) })
    assert.equal(spelled.eligible, false)
    assert.match(spelled.reason, /same model and effort as code/)
    assert.doesNotMatch(spelled.reason, /more than effort/)
  })

  it('starts new on another model family, an unknown or old CLI, or a blocking environment', () => {
    for (const model of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-5-50',
      'claude-opus-5-5x',
      'claude-opus-5-5-foo',
    ])
      assert.equal(
        decide({ code: claude('medium', model), repair: claude('high', model) })
          .eligible,
        false,
        model,
      )
    for (const version of [null, 'unknown', '2.1.259', '2.0.999', '1.9.300'])
      assert.equal(
        decide({ claudeCliVersion: version }).eligible,
        false,
        version ?? 'null',
      )
    for (const name of EFFORT_RESUME_BLOCKING_ENV) {
      const blocked = decide({ env: { [name]: '1' } })
      assert.equal(blocked.eligible, false, name)
      assert.match(blocked.reason, new RegExp(name))
    }
    // An empty value is not set.
    assert.equal(
      decide({ env: { CLAUDE_CODE_USE_BEDROCK: '' } }).eligible,
      true,
    )
  })

  it('lets the fake provider stand in only when the test switch says so', () => {
    const fake = (model: string | null, effort: string) => ({
      provider: 'fake' as const,
      requestedModel: model,
      effectiveModel: model ?? 'fake-model',
      effectiveEffort: effort,
    })
    const input = {
      code: fake(null, 'low'),
      repair: fake(null, 'high'),
      claudeCliVersion: null,
    }
    assert.equal(decide(input).eligible, false)
    assert.equal(decide({ ...input, fakeEffortResume: true }).eligible, true)
  })

  it('reads the version out of the CLI version line', () => {
    assert.deepEqual(parseCliVersion('2.1.280 (Claude Code)'), [2, 1, 280])
    assert.equal(parseCliVersion(null), null)
    assert.equal(parseCliVersion('Claude Code'), null)
  })
})

describe('a Claude alias, resolved by the model Claude Code reports', () => {
  /** A profile as the job fixes it, through the real Claude provider. */
  const fixed = (model: string, effort: string) =>
    fixProfile({ provider: 'claude', model, effort })
  const modelOf = (c: ConfirmedRepairSession) => (c.continues ? c.model : null)
  /** The Agent SDK init message preflight's minimal call would read. */
  const init = (model: string) =>
    ({ type: 'system', subtype: 'init', model }) as unknown as SDKMessage
  /** Setup's decision, confirmed with what a stub preflight observed. */
  const decideAndConfirm = (
    code: ReturnType<typeof fixed>,
    repair: ReturnType<typeof fixed>,
    observed: { code: SDKMessage | null; repair: SDKMessage | null },
  ) => {
    const setup = repairSessionDecision({
      contextMode: 'reuse',
      code,
      repair,
      claudeCliVersion: '2.1.280 (Claude Code)',
      env: {},
      fakeEffortResume: false,
    })
    return {
      setup,
      confirmed: confirmRepairSession({
        setup,
        provider: 'claude',
        codeModel: observed.code ? observedClaudeModel(observed.code) : null,
        repairModel: observed.repair
          ? observedClaudeModel(observed.repair)
          : null,
      }),
    }
  }

  it('keeps the alias as the effective model: only the CLI resolves it', () => {
    const profile = fixed('opus', 'high')
    assert.equal(profile.requestedModel, 'opus')
    assert.equal(profile.effectiveModel, 'opus')
  })

  it('reads the concrete model from the init message, or an assistant message', () => {
    assert.equal(
      observedClaudeModel(init('claude-opus-5-5')),
      'claude-opus-5-5',
    )
    const assistant = (model: string) =>
      ({ type: 'assistant', message: { model } }) as unknown as SDKMessage
    assert.equal(
      observedClaudeModel(assistant('claude-fable-5-1')),
      'claude-fable-5-1',
    )
    // The CLI's own made-up frames and other messages name no model.
    assert.equal(observedClaudeModel(assistant('<synthetic>')), null)
    assert.equal(
      observedClaudeModel({
        type: 'result',
        subtype: 'success',
      } as unknown as SDKMessage),
      null,
    )
  })

  it('continues `opus` and `opus` once preflight saw both run on Opus 5.5', () => {
    const { setup, confirmed } = decideAndConfirm(
      fixed('opus', 'medium'),
      fixed('opus', 'high'),
      { code: init('claude-opus-5-5'), repair: init('claude-opus-5-5') },
    )
    assert.equal(setup.eligible, true)
    assert.equal(confirmed.continues, true)
    assert.equal(modelOf(confirmed), 'claude-opus-5-5')
    // The implementation session recorded that model, so the repair
    // continues it.
    assert.equal(
      sessionHandlingOf({
        recorded: {
          provider: 'claude',
          nativeId: 'n',
          profileId: 'code',
          model: modelOf(confirmed),
          cwd: '/w',
          instructionsVersion: 'v',
        },
        profile: { provider: 'claude', id: 'repair' },
        cwd: '/w',
        instructionsVersion: 'v',
        acrossEffortModel: modelOf(confirmed),
      }).handling,
      'continued-effort-change',
    )
  })

  it('continues `opus` and `claude-opus-5-5` once preflight saw one model', () => {
    const { confirmed } = decideAndConfirm(
      fixed('opus', 'medium'),
      fixed('claude-opus-5-5', 'high'),
      { code: init('claude-opus-5-5'), repair: init('claude-opus-5-5') },
    )
    assert.equal(confirmed.continues, true)
    assert.equal(modelOf(confirmed), 'claude-opus-5-5')
  })

  it('starts new when preflight reported no model, another model, or an unlisted one', () => {
    const unknown = decideAndConfirm(
      fixed('opus', 'medium'),
      fixed('opus', 'high'),
      { code: init('claude-opus-5-5'), repair: null },
    ).confirmed
    assert.equal(unknown.continues, false)
    assert.equal(modelOf(unknown), null)
    assert.match(unknown.reason, /did not report/)
    const split = decideAndConfirm(
      fixed('opus', 'medium'),
      fixed('claude-opus-5-5', 'high'),
      { code: init('claude-opus-5-6'), repair: init('claude-opus-5-5') },
    ).confirmed
    assert.equal(split.continues, false)
    assert.match(split.reason, /code runs on claude-opus-5-6/)
    const sonnet = decideAndConfirm(
      fixed('sonnet', 'medium'),
      fixed('sonnet', 'high'),
      { code: init('claude-sonnet-5'), repair: init('claude-sonnet-5') },
    ).confirmed
    assert.equal(sonnet.continues, false)
    assert.equal(
      sonnet.reason,
      `claude-sonnet-5 is not ${EFFORT_RESUME_MODELS_LABEL}`,
    )
  })

  it("keeps setup's reason when setup already ruled it out, and refuses a run set up before", () => {
    assert.deepEqual(
      confirmRepairSession({
        setup: { eligible: false, reason: 'context is fresh' },
        provider: 'claude',
        codeModel: 'claude-opus-5-5',
        repairModel: 'claude-opus-5-5',
      }),
      { continues: false, reason: 'context is fresh' },
    )
    const before = confirmRepairSession({
      setup: null,
      provider: 'claude',
      codeModel: 'claude-opus-5-5',
      repairModel: 'claude-opus-5-5',
    })
    assert.equal(before.continues, false)
    assert.match(before.reason, /set up before/)
  })
})

describe('how a code stage treats the recorded implementation session', () => {
  const recorded = (patch: Partial<SessionRef> = {}): SessionRef => ({
    provider: 'claude',
    nativeId: 'native-1',
    profileId: 'code',
    model: 'claude-opus-5-5',
    cwd: '/w',
    instructionsVersion: 'v',
    ...patch,
  })
  const handling = (
    session: SessionRef | null,
    patch: {
      id?: string
      acrossEffortModel?: string | null
      cwd?: string
    } = {},
  ) =>
    sessionHandlingOf({
      recorded: session,
      profile: { provider: 'claude', id: patch.id ?? 'repair' },
      cwd: patch.cwd ?? '/w',
      instructionsVersion: 'v',
      acrossEffortModel:
        patch.acrossEffortModel === undefined
          ? 'claude-opus-5-5'
          : patch.acrossEffortModel,
    }).handling

  it('starts new with no session on record', () => {
    assert.equal(handling(null), 'fresh')
  })

  it('continues its own profile, and another one only on the confirmed model', () => {
    assert.equal(
      handling(recorded(), { id: 'code', acrossEffortModel: null }),
      'continued',
    )
    assert.equal(handling(recorded()), 'continued-effort-change')
  })

  it('starts new on a session recorded without a model, missing or null', () => {
    assert.equal(handling(recorded({ model: undefined })), 'fresh')
    assert.equal(handling(recorded({ model: null })), 'fresh')
  })

  it('starts new, and says why, on a session that ran another model than the confirmed one', () => {
    // The CLI resolved the alias to another model between preflight and
    // the implement call.
    const choice = sessionHandlingOf({
      recorded: recorded({ model: 'claude-opus-5-6' }),
      profile: { provider: 'claude', id: 'repair' },
      cwd: '/w',
      instructionsVersion: 'v',
      acrossEffortModel: 'claude-opus-5-5',
    })
    assert.equal(choice.handling, 'fresh')
    assert.match(
      choice.reason,
      /ran on claude-opus-5-6, not the confirmed claude-opus-5-5/,
    )
  })

  it('stops on another provider, cwd, instructions, or a profile it may not continue', () => {
    for (const [name, run] of [
      ['provider', () => handling(recorded({ provider: 'codex' }))],
      ['cwd', () => handling(recorded(), { cwd: '/other' })],
      [
        'instructions',
        () => handling(recorded({ instructionsVersion: 'old' })),
      ],
      ['profile', () => handling(recorded(), { acrossEffortModel: null })],
    ] as const)
      assert.throws(run, /provenance no longer matches/, name)
  })
})

describe('Claude usage before the result message (ADR-0034)', () => {
  const assistant = (
    id: string,
    model: string,
    usage: Record<string, number | null>,
    parent: string | null = null,
  ) =>
    ({
      type: 'assistant',
      message: { id, model, content: [], usage },
      parent_tool_use_id: parent,
      uuid: `uuid-${id}-${Math.random()}`,
      session_id: 'session-1',
    }) as unknown as SDKMessage
  const legs = (input: number, output: number, read = 0, write = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  })
  const COMMAND_REVIEW: ReviewCallSettings = {
    command: true,
    context: 'prompt',
    output: 'findings-json',
    readableDirs: [],
  }

  it('sums each message once at its latest usage, as a running total', () => {
    const read = claudePartialUsage(null)
    const first = read(assistant('m1', 'claude-opus-5-5', legs(10, 5, 100, 20)))
    assert.equal(first?.usage.inputTokens, 130)
    assert.equal(first?.usage.cacheReadTokens, 100)
    assert.equal(first?.usage.cacheWriteTokens, 20)
    assert.equal(first?.usage.outputTokens, 5)
    assert.equal(first?.usage.usageSource, 'provider-partial')
    // The same message again, once per content block: counted once, and
    // nothing new to report when its usage did not change.
    assert.equal(
      read(assistant('m1', 'claude-opus-5-5', legs(10, 5, 100, 20))),
      null,
    )
    const grown = read(
      assistant('m1', 'claude-opus-5-5', legs(10, 40, 100, 20)),
    )
    assert.equal(grown?.usage.outputTokens, 40)
    assert.equal(grown?.usage.inputTokens, 130)
    const next = read(assistant('m2', 'claude-opus-5-5', legs(3, 7, 150, 0)))
    assert.equal(next?.usage.inputTokens, 283)
    assert.equal(next?.usage.outputTokens, 47)
    assert.equal(next?.usage.totalTokens, 330)
    assert.deepEqual(Object.keys(next?.usageByModel ?? {}), ['claude-opus-5-5'])
  })

  it('counts nothing from synthetic frames, frames without tokens or other messages', () => {
    const read = claudePartialUsage(null)
    assert.equal(read(assistant('s', '<synthetic>', legs(0, 0))), null)
    assert.equal(read(assistant('s2', '<synthetic>', legs(5, 5))), null)
    assert.equal(read(assistant('z', 'claude-opus-5-5', legs(0, 0))), null)
    assert.equal(
      read({ type: 'system', subtype: 'init' } as unknown as SDKMessage),
      null,
    )
  })

  it("counts subagents only in a command-mode review, split by model, the final usage's scope", () => {
    const sub = assistant('sub', 'claude-haiku-5-5', legs(50, 10), 'tool-1')
    const main = assistant('main', 'claude-opus-5-5', legs(10, 5))
    const plain = claudePartialUsage(null)
    plain(main)
    assert.equal(plain(sub), null)
    const review = claudePartialUsage(COMMAND_REVIEW)
    review(main)
    const both = review(sub)
    assert.equal(both?.usage.inputTokens, 60)
    assert.equal(both?.usageByModel['claude-haiku-5-5']?.inputTokens, 50)
    assert.equal(both?.usageByModel['claude-opus-5-5']?.outputTokens, 5)
  })

  it('reads the session from any message that carries one', () => {
    assert.equal(
      claudeSessionId({
        type: 'system',
        subtype: 'init',
        session_id: 'abc',
      } as unknown as SDKMessage),
      'abc',
    )
    assert.equal(
      claudeSessionId({ type: 'system' } as unknown as SDKMessage),
      null,
    )
  })
})
