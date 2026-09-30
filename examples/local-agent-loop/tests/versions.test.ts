import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createAPICallError,
  createAuthenticationError,
} from 'ai-sdk-provider-claude-code'

import {
  claudeExecutable,
  claudeRejection,
  isAgentActivity,
} from '../src/engine/providers/claude.js'
import {
  CodexProvider,
  codexExecutable,
  codexRejection,
  codexStartFailure,
  judgeCodexModelList,
  watchActivity,
} from '../src/engine/providers/codex.js'
import { createProvider } from '../src/engine/providers/index.js'
import type { AttemptMeasurement } from '../src/engine/providers/types.js'
import { runAgentCall } from '../src/engine/runner.js'
import type { ResolvedProfile } from '../src/engine/types.js'
import { configVersionOf, resolveVersions } from '../src/engine/versions.js'
import {
  confirmRepairSession,
  EFFORT_RESUME_POLICY,
  repairSessionDecision,
  separateRepairProfile,
} from '../src/factory/types.js'
import { resolveProfiles } from '../src/trigger-input.js'

describe('recorded CLI versions', { timeout: 60000 }, () => {
  it('prefers codex on PATH, then the bundled CLI, and records the one it launches', async () => {
    const saved = process.env['PATH']
    const dir = await mkdtemp(join(tmpdir(), 'codex-on-path-'))
    const stub = join(dir, 'codex')
    await writeFile(stub, '#!/bin/sh\necho "codex-cli 9.9.9"\n')
    await chmod(stub, 0o755)
    try {
      process.env['PATH'] = dir
      assert.deepEqual(codexExecutable(), {
        command: stub,
        args: [],
        path: stub,
      })
      // Without one on PATH, this workspace's bundled `@openai/codex`.
      process.env['PATH'] = ''
      const bundled = codexExecutable()
      assert.equal(bundled.command, 'node')
      assert.match(
        bundled.path ?? '',
        /@openai[/\\]codex[/\\]bin[/\\]codex\.js$/,
      )
      assert.deepEqual(bundled.args, [bundled.path])
    } finally {
      process.env['PATH'] = saved
      await rm(dir, { recursive: true, force: true })
    }
    const exe = codexExecutable()
    const versions = await resolveVersions('codex')
    assert.equal(versions['codexCliPath'], exe.path)
    // Whatever the version is, it came from that file, or it is unknown.
    const version = versions['codexCli']
    assert.ok(version === null || /\d+\.\d+\.\d+/.test(version), version ?? '')
    // No pinned path: the provider keeps that same resolution.
    assert.equal(new CodexProvider().cliPath, null)
    assert.equal(createProvider('codex').cliPath, null)
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

describe('a pinned codexPath', { timeout: 120000 }, () => {
  /** A stand-in Codex CLI that logs every launch and knows only --version. */
  async function stubCodex() {
    const dir = await mkdtemp(join(tmpdir(), 'codex-path-'))
    const log = join(dir, 'launches.log')
    const path = join(dir, 'codex')
    await writeFile(
      path,
      `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = "--version" ]; then echo "codex-cli 9.9.9-pinned"; exit 0; fi\nexit 3\n`,
    )
    await chmod(path, 0o755)
    const launches = async () =>
      existsSync(log)
        ? (await readFile(log, 'utf8')).split('\n').filter(Boolean)
        : []
    return { dir, path, launches }
  }

  it('is the file every preflight, call and version probe launches', async () => {
    const stub = await stubCodex()
    assert.deepEqual(codexExecutable(stub.path), {
      command: stub.path,
      args: [],
      path: stub.path,
    })
    // A script is run through node, as the provider itself runs one.
    assert.deepEqual(codexExecutable('/x/bin/codex.js').command, 'node')

    const versions = await resolveVersions('codex', stub.path)
    assert.equal(versions['codexCliPath'], stub.path)
    assert.equal(versions['codexCli'], 'codex-cli 9.9.9-pinned')

    const provider = createProvider('codex', { codexPath: stub.path })
    assert.equal(provider.cliPath, stub.path)
    // The free check asks the pinned CLI's app server; this one never
    // starts, which the free check already knows to be a refusal.
    const check = await provider.checkAvailability({
      requestedModel: null,
      model: 'gpt-5.6-sol',
      effort: 'low',
    })
    assert.equal(check.verdict, 'unavailable')
    assert.equal(codexStartFailure(new Error(check.detail)), check.detail)
    assert.equal(check.method, 'codex model/list')
    assert.ok((await stub.launches()).some((l) => l.startsWith('app-server')))
    // Roles checked side by side, as one preflight does, share one read of
    // the catalog per CLI file.
    const appServers = async () =>
      (await stub.launches()).filter((l) => l.startsWith('app-server')).length
    const listed = await appServers()
    const side = await Promise.all(
      ['low', 'medium', 'high'].map((effort) =>
        provider.checkAvailability({
          requestedModel: null,
          model: 'gpt-5.6-sol',
          effort,
        }),
      ),
    )
    assert.deepEqual(
      side.map((c) => c.verdict),
      ['unavailable', 'unavailable', 'unavailable'],
    )
    assert.equal((await appServers()) - listed, 1)

    // The real call path launches it too, and records its version.
    const before = (await stub.launches()).length
    const snapshots: AttemptMeasurement[] = []
    const attempt = {
      id: randomUUID(),
      log: { info: () => {} },
      setMetadata: async (m: unknown) => {
        snapshots.push(JSON.parse(JSON.stringify(m)) as AttemptMeasurement)
      },
    }
    // It never starts, so nothing was sent: a settled refusal, not a doubt.
    const refused = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      {
        provider,
        providerName: 'codex',
        prompt: 'Reply with OK.',
        workdir: stub.dir,
        timeoutMs: 30000,
        requestedModel: null,
        requestedEffort: null,
        effectiveModel: 'gpt-5.6-sol',
        effectiveEffort: 'low',
        role: 'preflight',
        stage: 'preflight',
        iteration: 0,
        operationKey: `test/${randomUUID()}`,
        checkpointsDir: join(stub.dir, 'checkpoints'),
        acceptRejection: true,
      },
    )
    assert.match(refused.rejection ?? '', /app-server exited \(code=3/)
    const after = await stub.launches()
    assert.ok(after.slice(before).some((l) => l.startsWith('app-server')))
    assert.equal(snapshots.at(-1)?.versions['codexCliPath'], stub.path)
    assert.equal(
      snapshots.at(-1)?.versions['codexCli'],
      'codex-cli 9.9.9-pinned',
    )
  })
})

describe('preflight verdicts', () => {
  const efforts = (...names: string[]) =>
    names.map((reasoningEffort) => ({ reasoningEffort }))

  it('judges a Codex model and effort against the model list', () => {
    const models = [
      {
        id: 'gpt-a',
        model: 'gpt-a',
        supportedReasoningEfforts: efforts('low', 'high'),
      },
    ]
    assert.equal(
      judgeCodexModelList(models, 'gpt-a', 'low').verdict,
      'available',
    )
    const effort = judgeCodexModelList(models, 'gpt-a', 'max')
    assert.equal(effort.verdict, 'unavailable')
    assert.match(effort.detail, /does not offer effort max/)
    // The list leaves out hidden models, so absence proves nothing and a
    // minimal call decides.
    const missing = judgeCodexModelList(models, 'gpt-b', 'low')
    assert.equal(missing.verdict, 'unknown')
    assert.match(missing.detail, /gpt-b is not in the model list/)
    assert.match(missing.detail, /hidden/)
  })

  it('tells an explicit refusal from any other error', () => {
    const codex400 = new Error(
      JSON.stringify({
        type: 'error',
        status: 400,
        error: {
          type: 'invalid_request_error',
          message: "The 'x' model is not supported",
        },
      }),
    )
    assert.match(
      codexRejection(codex400) ?? '',
      /^400: The 'x' model is not supported/,
    )
    // Every way the app server fails to come up: no thread, no prompt.
    for (const start of [
      'Failed to initialize codex app-server: exited',
      "codex app-server requires codex CLI >= 0.156.0. Run 'codex --version' to check.",
      'codex app-server failed to start: codex executable not found (ENOENT). Check that the codex CLI is installed',
      "codex app-server version '0.100.0' is below required minimum '0.156.0'.",
    ]) {
      assert.equal(codexRejection(new Error(start)), start, start)
      assert.equal(codexStartFailure(new Error(start)), start, start)
    }
    assert.equal(codexStartFailure(new Error('socket hang up')), null)
    // A handshake that only timed out may be a slow start, not a bad setting.
    const slow = new Error(
      "Failed to initialize codex app-server: Request timed out for method 'initialize'",
    )
    assert.equal(codexStartFailure(slow), null)
    assert.equal(codexRejection(slow), null)
    for (const status of [408, 429, 500])
      assert.equal(
        codexRejection(new Error(JSON.stringify({ status, error: {} }))),
        null,
        String(status),
      )
    assert.equal(codexRejection(new Error('socket hang up')), null)

    const claude404 = Object.assign(
      new Error('There is an issue with the selected model'),
      {
        data: { errorKind: 'model_not_found' },
      },
    )
    assert.match(claudeRejection(claude404) ?? '', /^model_not_found: /)
    const overloaded = Object.assign(new Error('overloaded'), {
      data: { errorKind: 'overloaded' },
    })
    assert.equal(claudeRejection(overloaded), null)
    // Recognised from text by the provider, with no structured kind.
    const loggedOut = createAuthenticationError({
      message: 'Invalid API key · Please run /login',
    })
    assert.match(
      claudeRejection(loggedOut) ?? '',
      /^authentication_failed: Invalid API key/,
    )
    const exit401 = createAPICallError({
      message: 'Claude Code process exited with code 1',
      exitCode: 401,
    })
    assert.match(claudeRejection(exit401) ?? '', /^authentication_failed: /)
    const noSuchModel = createAPICallError({
      message:
        "no such model: claude-x. The requested model was not found. Verify the model id passed to the provider (e.g. 'fable', 'opus', 'sonnet', 'haiku', or a full model name) and that your account has access to it.",
      isRetryable: false,
    })
    assert.match(
      claudeRejection(noSuchModel) ?? '',
      /^model_not_found: no such model: claude-x/,
    )
    assert.equal(
      claudeRejection(createAPICallError({ message: 'socket hang up' })),
      null,
    )
  })
})

describe('what counts as agent activity on a real provider', () => {
  it('Claude: an assistant message counts, the CLI error message and set-up do not', () => {
    const assistant = { type: 'assistant', message: {} } as never
    // What the CLI actually sends for an API refusal: a synthetic frame with
    // the error text as content and zero usage.
    const zero = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    const errored = {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Invalid API key' }],
        usage: zero,
      },
      error: 'authentication_failed',
    } as never
    const init = { type: 'system', subtype: 'init' } as never
    assert.equal(isAgentActivity(assistant), true)
    assert.equal(isAgentActivity(errored), false)
    // An error on a real model's frame, or with any usage, comes after work began.
    const erroredFromModel = {
      type: 'assistant',
      message: { model: 'claude-opus-5-5', content: [], usage: zero },
      error: 'authentication_failed',
    } as never
    const erroredWithCacheUsage = {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [],
        usage: { ...zero, cache_read_input_tokens: 1200 },
      },
      error: 'authentication_failed',
    } as never
    assert.equal(isAgentActivity(erroredFromModel), true)
    assert.equal(isAgentActivity(erroredWithCacheUsage), true)
    assert.equal(isAgentActivity(init), false)
  })

  it('Codex: the first part that shows work fires once; set-up and the error do not', async () => {
    const parts = (types: string[]) =>
      new ReadableStream<{ type: string }>({
        start(controller) {
          for (const type of types) controller.enqueue({ type })
          controller.close()
        },
      })
    // Mirrors the app-server model: `doGenerate` reads `this.doStream`.
    const model = (types: string[]) => ({
      doStream: async () => ({ stream: parts(types) }),
      async doGenerate() {
        const { stream } = await this.doStream()
        const reader = stream.getReader()
        while (!(await reader.read()).done);
      },
    })
    let fired = 0
    await watchActivity(
      model(['stream-start', 'response-metadata', 'error', 'raw', 'finish']),
      () => fired++,
    ).doGenerate()
    assert.equal(fired, 0)
    await watchActivity(
      model(['stream-start', 'tool-call', 'text-delta', 'error']),
      () => fired++,
    ).doGenerate()
    assert.equal(fired, 1)
  })

  it('Codex: the app-server model still builds doGenerate from this.doStream', async () => {
    // `watchActivity` relies on this; a provider update that stops it would
    // silently read every mid-turn error as a refusal.
    const entry = fileURLToPath(
      import.meta.resolve('ai-sdk-provider-codex-cli'),
    )
    const source = await readFile(entry, 'utf8')
    const start = source.indexOf('var AppServerLanguageModel = class')
    assert.ok(start >= 0)
    const body = source.slice(start, source.indexOf('\nvar ', start + 1))
    assert.match(
      body,
      /async doGenerate\(options\) \{\s*const \{ stream, request \} = await this\.doStream\(/,
    )
  })
})

describe('a partial repair profile', () => {
  it('fills what it leaves out from the resolved code profile, not the flags', () => {
    const flags = { provider: 'codex', model: 'gpt-flag', effort: 'low' }
    const code = {
      provider: 'codex' as const,
      model: 'gpt-code',
      effort: 'medium',
    }
    const { repair } = resolveProfiles(flags, {
      profiles: { code, repair: { effort: 'high' } },
    } as never)
    assert.equal(repair?.provider, 'codex')
    assert.equal(repair?.requestedModel, 'gpt-code')
    assert.equal(repair?.requestedEffort, 'high')
    // Code that leaves a field to the flags passes the flag's value on.
    const onFlags = resolveProfiles(flags, {
      profiles: { repair: { effort: 'high' } },
    } as never).repair
    assert.equal(onFlags?.requestedModel, 'gpt-flag')
    // On another provider, code's settings do not apply.
    const other = resolveProfiles(flags, {
      profiles: { code, repair: { provider: 'claude' } },
    } as never).repair
    assert.equal(other?.provider, 'claude')
    assert.equal(other?.requestedModel, null)
    assert.equal(other?.requestedEffort, null)
  })
})

describe('the repair profile in the config version', () => {
  const profile = (model: string | null, effort = 'low'): ResolvedProfile => ({
    id: `codex:${model ?? 'default'}:${effort}`,
    provider: 'codex',
    requestedModel: model,
    requestedEffort: effort,
    effectiveModel: model ?? 'gpt-5.6-sol',
    effectiveEffort: effort,
  })
  const base = {
    contextMode: 'reuse',
    instructionsVersion: 'local-factory.v3',
    maxIterations: 2,
    target: 'subject',
    agentTimeoutMs: 300000,
    checkTimeoutMs: 120000,
    code: profile(null),
    correctness: profile(null),
    edgeCases: profile(null),
  }
  /** The version the job computes: repair counts only when it differs. */
  const versionWith = (repair: ResolvedProfile | null) =>
    configVersionOf({
      ...base,
      repair: separateRepairProfile({
        repair,
        profiles: {
          code: base.code,
          correctness: base.correctness,
          'edge-cases': base.edgeCases,
        },
      }),
    })

  it('keeps the version without one, or with one that makes the same call as code', () => {
    const prior = configVersionOf(base)
    assert.equal(versionWith(null), prior)
    // The default model named explicitly is still the same call.
    assert.equal(versionWith(profile('gpt-5.6-sol')), prior)
    assert.equal(versionWith(profile(null)), prior)
  })

  it('changes with a different provider, model or effort', () => {
    const prior = configVersionOf(base)
    const versions = [
      versionWith(profile('gpt-5.6-terra')),
      versionWith(profile(null, 'high')),
      versionWith({ ...profile(null), provider: 'claude' }),
    ]
    for (const version of versions) assert.notEqual(version, prior)
    assert.equal(new Set(versions).size, versions.length)
  })
})

describe('the repair session policy in the config version', () => {
  const claude = (model: string, effort: string): ResolvedProfile => ({
    id: `claude:${model}:${effort}`,
    provider: 'claude',
    requestedModel: model,
    requestedEffort: effort,
    effectiveModel: model,
    effectiveEffort: effort,
  })
  const code = claude('claude-opus-5-5', 'medium')
  const base = {
    contextMode: 'reuse',
    instructionsVersion: 'local-factory.v3',
    maxIterations: 2,
    target: 'subject',
    agentTimeoutMs: 300000,
    checkTimeoutMs: 120000,
    code,
    correctness: code,
    edgeCases: code,
    cli: { claudeCli: '2.1.280 (Claude Code)', claudeCliPath: '/x/claude' },
  }
  /**
   * The version a run takes, as the job gives it: setup's version has no
   * policy, and the policy enters only once preflight confirms the
   * continuation with the models it saw (`observed`, by default each
   * profile's own name, as Claude Code runs a full id).
   */
  const versionWith = (
    repair: ResolvedProfile | null,
    options: {
      code?: ResolvedProfile
      env?: Record<string, string>
      observed?: { code: string | null; repair: string | null }
    } = {},
  ) => {
    const codeProfile = options.code ?? code
    const own = separateRepairProfile({
      repair,
      profiles: {
        code: codeProfile,
        correctness: codeProfile,
        'edge-cases': codeProfile,
      },
    })
    const setup = own
      ? repairSessionDecision({
          contextMode: base.contextMode as 'reuse',
          code: codeProfile,
          repair: own,
          claudeCliVersion: base.cli.claudeCli,
          env: options.env ?? {},
          fakeEffortResume: false,
        })
      : null
    const confirmed = own
      ? confirmRepairSession({
          setup,
          provider: 'claude',
          codeModel: options.observed?.code ?? codeProfile.effectiveModel,
          repairModel: options.observed?.repair ?? own.effectiveModel,
        })
      : null
    return configVersionOf({
      ...base,
      code: codeProfile,
      correctness: codeProfile,
      edgeCases: codeProfile,
      repair: own,
      repairSession: confirmed?.continues ? EFFORT_RESUME_POLICY : null,
    })
  }
  /** The version computed with no repair session field at all. */
  const prePolicy = (codeProfile: ResolvedProfile, repair: ResolvedProfile) =>
    configVersionOf({
      ...base,
      code: codeProfile,
      correctness: codeProfile,
      edgeCases: codeProfile,
      repair,
    })

  it('keeps the versions every other setting had before the policy existed', () => {
    // Pinned from the version this code computed before the policy existed.
    assert.equal(versionWith(null), 'a4a5cc94ce08f505')
    assert.equal(
      versionWith(claude('claude-sonnet-5', 'high')),
      '41ef81d9828ab27e',
    )
    // The effort change the policy would resume, where the environment
    // blocks it, keeps its earlier version too.
    assert.equal(
      versionWith(claude('claude-opus-5-5', 'high'), {
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      }),
      '52239366cb61629f',
    )
  })

  it('keeps the pre-policy version for an unlisted model name', () => {
    const unlistedCode = claude('claude-opus-5-5x', 'medium')
    const unlistedRepair = claude('claude-opus-5-5x', 'high')
    assert.equal(
      versionWith(unlistedRepair, { code: unlistedCode }),
      prePolicy(unlistedCode, unlistedRepair),
    )
  })

  it('keeps the pre-policy version for aliases preflight sees run on an unlisted model', () => {
    // `sonnet` and `sonnet` differ only in effort. Setup cannot tell what
    // they run, so it finds them eligible; preflight sees Sonnet, and the
    // run keeps the version it had before the policy existed.
    const sonnetCode = claude('sonnet', 'medium')
    const sonnetRepair = claude('sonnet', 'high')
    assert.equal(
      repairSessionDecision({
        contextMode: 'reuse',
        code: sonnetCode,
        repair: sonnetRepair,
        claudeCliVersion: base.cli.claudeCli,
        env: {},
        fakeEffortResume: false,
      }).eligible,
      true,
    )
    assert.equal(
      versionWith(sonnetRepair, {
        code: sonnetCode,
        observed: { code: 'claude-sonnet-5', repair: 'claude-sonnet-5' },
      }),
      prePolicy(sonnetCode, sonnetRepair),
    )
  })

  it('changes for a repair preflight confirms continues across an effort change', () => {
    const resumed = versionWith(claude('claude-opus-5-5', 'high'))
    assert.notEqual(resumed, '52239366cb61629f')
    assert.notEqual(resumed, versionWith(null))
    // `opus` and `opus`, confirmed on Opus 5.5: the policy is in the
    // version.
    const opusCode = claude('opus', 'medium')
    const opusRepair = claude('opus', 'high')
    const confirmed = versionWith(opusRepair, {
      code: opusCode,
      observed: { code: 'claude-opus-5-5', repair: 'claude-opus-5-5' },
    })
    assert.notEqual(confirmed, prePolicy(opusCode, opusRepair))
    assert.equal(
      confirmed,
      configVersionOf({
        ...base,
        code: opusCode,
        correctness: opusCode,
        edgeCases: opusCode,
        repair: opusRepair,
        repairSession: EFFORT_RESUME_POLICY,
      }),
    )
  })
})

describe('commit settings in the config version', () => {
  const profile: ResolvedProfile = {
    id: 'fake:fake-model:provider-default:code',
    provider: 'fake',
    requestedModel: null,
    requestedEffort: null,
    effectiveModel: 'fake-model',
    effectiveEffort: null,
  }
  const base = {
    contextMode: 'reuse',
    instructionsVersion: 'local-factory.v3',
    maxIterations: 2,
    target: 'repo:node --test',
    agentTimeoutMs: 1800000,
    checkTimeoutMs: 900000,
    code: profile,
    correctness: profile,
    edgeCases: profile,
  }
  const none = {
    authorName: null,
    authorEmail: null,
    messageTemplate: null,
  }
  // The version such a run had before commit settings existed.
  const PRIOR = '12ea50a6cf90735b'

  it('keeps the prior version when the author and template are left out', () => {
    assert.equal(configVersionOf(base), PRIOR)
    assert.equal(configVersionOf({ ...base, commit: null }), PRIOR)
    assert.equal(configVersionOf({ ...base, commit: none }), PRIOR)
    // Which branch --publish pushes does not change what runs.
    assert.equal(
      configVersionOf({
        ...base,
        commit: { ...none, publishSquashed: true } as typeof none,
      }),
      PRIOR,
    )
  })

  it('changes with each author field and the message template', () => {
    const versions = [
      configVersionOf({ ...base, commit: { ...none, authorName: 'Bot' } }),
      configVersionOf({
        ...base,
        commit: { ...none, authorEmail: 'bot@example.com' },
      }),
      configVersionOf({
        ...base,
        commit: { ...none, messageTemplate: 'fix: {task}' },
      }),
      configVersionOf({
        ...base,
        commit: { ...none, messageTemplate: 'feat: {task}' },
      }),
    ]
    for (const version of versions) assert.notEqual(version, PRIOR)
    assert.equal(new Set(versions).size, versions.length)
  })
})

describe('reviewer invocations in the config version', () => {
  const profile: ResolvedProfile = {
    id: 'fake:fake-model:provider-default:code',
    provider: 'fake',
    requestedModel: null,
    requestedEffort: null,
    effectiveModel: 'fake-model',
    effectiveEffort: null,
  }
  const base = {
    contextMode: 'reuse',
    instructionsVersion: 'local-factory.v3',
    maxIterations: 2,
    target: 'repo:node --test',
    agentTimeoutMs: 1800000,
    checkTimeoutMs: 900000,
    code: profile,
    correctness: profile,
    edgeCases: profile,
  }
  // The same run's version from before reviewer invocations existed.
  const PRIOR = '12ea50a6cf90735b'
  const invocation = {
    command: '/code-review {base}..{head}',
    context: 'local-instructions',
    output: 'findings-json',
  }

  it('keeps the prior version when no reviewer names a command, context or output', () => {
    assert.equal(configVersionOf({ ...base, review: null }), PRIOR)
    assert.equal(configVersionOf({ ...base, review: {} }), PRIOR)
    // A config that leaves every new field out fixes nothing for a lens.
    const fixed = resolveProfiles({ provider: 'fake' }, {
      profiles: {
        review: { correctness: { model: 'm' }, 'edge-cases': {} },
      },
    } as Parameters<typeof resolveProfiles>[1])
    assert.deepEqual(fixed.review, {})
    assert.equal(configVersionOf({ ...base, review: fixed.review }), PRIOR)
  })

  it('changes with each fixed field of each configured lens', () => {
    const versions = [
      configVersionOf({ ...base, review: { correctness: invocation } }),
      configVersionOf({ ...base, review: { 'edge-cases': invocation } }),
      configVersionOf({
        ...base,
        review: { correctness: { ...invocation, command: null } },
      }),
      configVersionOf({
        ...base,
        review: { correctness: { ...invocation, context: 'prompt' } },
      }),
      configVersionOf({
        ...base,
        review: { correctness: { ...invocation, output: 'verdict' } },
      }),
      // Naming the defaults is still naming them.
      configVersionOf({
        ...base,
        review: {
          correctness: { command: null, context: 'prompt', output: 'verdict' },
        },
      }),
    ]
    for (const version of versions) assert.notEqual(version, PRIOR)
    assert.equal(new Set(versions).size, versions.length)
  })
})

describe('spec stages in the config version', () => {
  const profile: ResolvedProfile = {
    id: 'fake:fake-model:provider-default:code',
    provider: 'fake',
    requestedModel: null,
    requestedEffort: null,
    effectiveModel: 'fake-model',
    effectiveEffort: null,
  }
  const base = {
    contextMode: 'reuse',
    instructionsVersion: 'local-factory.v3',
    maxIterations: 2,
    target: 'repo:node --test',
    agentTimeoutMs: 1800000,
    checkTimeoutMs: 900000,
    code: profile,
    correctness: profile,
    edgeCases: profile,
  }
  // The same run's version from before spec stages existed.
  const PRIOR = '12ea50a6cf90735b'
  const spec = {
    author: profile,
    fix: profile,
    reviewers: [
      { name: 'product', profile, invocation: null },
      {
        name: 'tech',
        profile,
        invocation: {
          command: '/spec-review {base}',
          context: 'prompt',
          output: 'findings-json',
        },
      },
    ],
    maxRounds: 3,
    template: '# Template\n',
    reviewTemplate: 'Review it.\n',
  }

  it('keeps the prior version without spec stages, a spec given at trigger included', () => {
    assert.equal(configVersionOf({ ...base, spec: null }), PRIOR)
    assert.equal(configVersionOf({ ...base, spec: undefined }), PRIOR)
    // A check chosen from the spec is part of what the run is pointed at.
    assert.notEqual(
      configVersionOf({ ...base, target: 'repo:from-spec:node x.mjs' }),
      PRIOR,
    )
  })

  it('changes with each role, invocation, round limit and template content', () => {
    const other = {
      ...profile,
      requestedEffort: 'high',
      effectiveEffort: 'high',
    }
    const versions = [
      configVersionOf({ ...base, spec }),
      configVersionOf({ ...base, spec: { ...spec, author: other } }),
      configVersionOf({ ...base, spec: { ...spec, fix: other } }),
      configVersionOf({
        ...base,
        spec: { ...spec, reviewers: spec.reviewers.slice(0, 1) },
      }),
      configVersionOf({
        ...base,
        spec: {
          ...spec,
          reviewers: [
            { name: 'ops', profile, invocation: null },
            ...spec.reviewers.slice(1),
          ],
        },
      }),
      configVersionOf({
        ...base,
        spec: {
          ...spec,
          reviewers: [
            spec.reviewers[0] as (typeof spec.reviewers)[number],
            {
              name: 'tech',
              profile,
              invocation: {
                command: '/spec-review {base}',
                context: 'prompt',
                output: 'verdict',
              },
            },
          ],
        },
      }),
      configVersionOf({ ...base, spec: { ...spec, maxRounds: 4 } }),
      configVersionOf({ ...base, spec: { ...spec, template: '# Other\n' } }),
      configVersionOf({ ...base, spec: { ...spec, reviewTemplate: null } }),
    ]
    for (const version of versions) assert.notEqual(version, PRIOR)
    assert.equal(new Set(versions).size, versions.length)
    // The same settings give the same version: nothing is read again.
    assert.equal(configVersionOf({ ...base, spec }), versions[0])
  })
})
