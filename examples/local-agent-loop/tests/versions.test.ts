import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  createAPICallError,
  createAuthenticationError,
} from 'ai-sdk-provider-claude-code'

import {
  claudeExecutable,
  claudeRejection,
} from '../src/engine/providers/claude.js'
import {
  CodexProvider,
  codexExecutable,
  codexRejection,
  codexStartFailure,
  judgeCodexModelList,
} from '../src/engine/providers/codex.js'
import { createProvider } from '../src/engine/providers/index.js'
import type { AttemptMeasurement } from '../src/engine/providers/types.js'
import { runAgentCall } from '../src/engine/runner.js'
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
