/** Version recording: AI SDK + provider packages + local CLIs. */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'

import { runChild } from './child.js'
import { claudeExecutable } from './providers/claude.js'
import { codexExecutable } from './providers/codex.js'

const require = createRequire(import.meta.url)
const versionCache = new Map<string, Promise<Record<string, string | null>>>()

function packageVersion(name: string): string | null {
  try {
    const pkg = require(`${name}/package.json`) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Probe a CLI's version through `runChild`, like every other subprocess here,
 * so it joins the owned-children registry and its own process group. A bare
 * `execFile` would survive the worker's shutdown path and ignore the step
 * signal.
 */
async function cliVersion(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const res = await runChild(command, args, {
      timeoutMs: 15000,
      maxOutputChars: 2000,
    })
    if (res.code !== 0) return null
    const out =
      `${res.stdout} ${res.stderr}`.trim().split('\n')[0]?.trim() ?? ''
    return out.length > 0 ? out.slice(0, 120) : null
  } catch {
    return null
  }
}

/**
 * Resolve the versions used for one provider call. Only the selected
 * provider's CLI is probed — the unselected CLI is never required to be
 * installed or authenticated.
 *
 * The CLI probed is the file the provider launches (`codexCliPath` /
 * `claudeCliPath`), the run's pinned `codexPath` when it has one; what cannot
 * be found is null, never another install.
 */
export async function resolveVersions(
  provider: 'codex' | 'claude' | 'fake',
  cliPath: string | null = null,
): Promise<Record<string, string | null>> {
  // The launched file and its mtime: a CLI updated in place, such as the
  // owner's PATH `codex`, is probed again by a long-running worker.
  const key = `${provider}:${cliFileStamp(provider, cliPath)}`
  const cached = versionCache.get(key)
  if (cached) return cached
  // Drop a rejected probe from the cache: caching it would make one transient
  // failure permanent for the life of the worker.
  const pending = resolveVersionsUncached(provider, cliPath).catch((error) => {
    versionCache.delete(key)
    throw error
  })
  versionCache.set(key, pending)
  return pending
}

function cliFileStamp(
  provider: 'codex' | 'claude' | 'fake',
  cliPath: string | null,
): string {
  const path =
    provider === 'codex'
      ? codexExecutable(cliPath).path
      : provider === 'claude'
        ? claudeExecutable()
        : null
  if (!path) return ''
  try {
    return `${path}@${statSync(path).mtimeMs}`
  } catch {
    return path
  }
}

async function resolveVersionsUncached(
  provider: 'codex' | 'claude' | 'fake',
  cliPath: string | null,
): Promise<Record<string, string | null>> {
  const base = {
    ai: packageVersion('ai'),
    'ai-sdk-provider-codex-cli': packageVersion('ai-sdk-provider-codex-cli'),
    'ai-sdk-provider-claude-code': packageVersion(
      'ai-sdk-provider-claude-code',
    ),
  }
  if (provider === 'codex') {
    const exe = codexExecutable(cliPath)
    return {
      ...base,
      codexCli: exe.path
        ? await cliVersion(exe.command, [...exe.args, '--version'])
        : null,
      codexCliPath: exe.path,
    }
  }
  if (provider === 'claude') {
    const path = claudeExecutable()
    return {
      ...base,
      claudeCli: path ? await cliVersion(path, ['--version']) : null,
      claudeCliPath: path,
    }
  }
  return base
}

/**
 * The path and version of one provider's CLI, from `resolveVersions`: what
 * a preflight record and the config version name. Null for the fake one.
 */
export function cliIdentityOf(
  provider: 'codex' | 'claude' | 'fake',
  versions: Record<string, string | null>,
): { path: string | null; version: string | null } | null {
  if (provider === 'fake') return null
  return {
    path: versions[`${provider}CliPath`] ?? null,
    version: versions[`${provider}Cli`] ?? null,
  }
}

/** One role's fixed settings, as they enter the config version. */
export interface ConfigVersionProfile {
  provider: string
  requestedModel: string | null
  requestedEffort: string | null
  effectiveModel: string | null
  effectiveEffort: string | null
}

export interface ConfigVersionInput {
  contextMode: string
  instructionsVersion: string
  maxIterations: number
  /** What the run was pointed at; runs against different work are not comparable. */
  target: string
  /**
   * Timeouts decide whether a candidate passes, so two runs with different
   * ones are not one population even when everything else matches.
   */
  agentTimeoutMs: number
  /** The idle limit stops a call the total would let run, so it counts too. */
  agentIdleTimeoutMs: number
  checkTimeoutMs: number
  /** Implementation, and repair unless `repair` is given. */
  code: ConfigVersionProfile
  /**
   * The repair profile, only when it differs from `code`; left out of the
   * hash otherwise, so a run without one keeps the version it had before
   * repair profiles existed.
   */
  repair?: ConfigVersionProfile | null
  /**
   * The repair session policy, only when a repair on its own profile
   * continues the implementation session across an effort change. Left out
   * otherwise, so every other run keeps the version it had before.
   */
  repairSession?: string | null
  correctness: ConfigVersionProfile
  edgeCases: ConfigVersionProfile
  /** Shadow triage; left out of the hash entirely when not configured. */
  triage?: ConfigVersionProfile | null
  /**
   * Path and version of each real CLI the roles launch, from
   * `resolveVersions`. Left out when empty, so a fake run keeps its version.
   */
  cli?: Record<string, string | null> | null
  /**
   * The repository run's commit settings. The author and message template
   * are in every iteration commit the agent's worktree history shows, so
   * they enter the hash; `publishSquashed` only picks which branch is
   * pushed, as `--publish` does, and stays out. Left out entirely when
   * author and template are both the defaults, so such a run keeps its
   * version.
   */
  commit?: {
    authorName: string | null
    authorEmail: string | null
    messageTemplate: string | null
  } | null
  /**
   * The repository run's `selfCheck` commands, which the code and repair
   * prompts list. Left out when absent or empty, so such a run keeps its
   * version.
   */
  selfCheck?: string[][] | null
  /**
   * The fixed command, context and output of each reviewer that named any
   * of them. A lens that named none is left out, and so is the whole field
   * when none did, so such a run keeps its version.
   */
  review?: Partial<
    Record<
      'correctness' | 'edge-cases',
      { command: string | null; context: string; output: string }
    >
  > | null
  /**
   * The spec stages: the author's, fix's and each named reviewer's profile
   * and invocation, the round limit, and the contents of the templates read
   * at trigger. Left out entirely on a run without them, so such a run keeps
   * its version.
   */
  spec?: {
    author: ConfigVersionProfile
    fix: ConfigVersionProfile
    reviewers: {
      name: string
      profile: ConfigVersionProfile
      invocation: {
        command: string | null
        context: string
        output: string
      } | null
    }[]
    maxRounds: number
    template: string | null
    reviewTemplate: string | null
  } | null
}

function canonicalProfile(p: ConfigVersionProfile): ConfigVersionProfile {
  return {
    provider: p.provider,
    requestedModel: p.requestedModel,
    requestedEffort: p.requestedEffort,
    effectiveModel: p.effectiveModel,
    effectiveEffort: p.effectiveEffort,
  }
}

/**
 * Stable hash of the fixed run configuration. Two runs share a config
 * version exactly when every role's provider, models and efforts (a repair
 * profile's only when it differs from code's, and whether that repair
 * continues the implementation session across an effort change), the context
 * mode, iteration budget, instruction set, triage profile (when there is
 * one), the path and version of every real CLI launched, the commit
 * author and message template (when set), the self-check commands (when
 * set), each configured reviewer's
 * command, context and output, and the spec stages with their templates
 * (when configured) are identical —
 * the unit of a fair comparison. Stored on every LLM attempt as
 * `configVersion`.
 */
export function configVersionOf(input: ConfigVersionInput): string {
  const commit = input.commit
  const commitKey =
    commit &&
    (commit.authorName !== null ||
      commit.authorEmail !== null ||
      commit.messageTemplate !== null)
      ? {
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          messageTemplate: commit.messageTemplate,
        }
      : null
  const review = (['correctness', 'edge-cases'] as const).flatMap((lens) => {
    const r = input.review?.[lens]
    return r
      ? [[lens, { command: r.command, context: r.context, output: r.output }]]
      : []
  })
  const canonical = JSON.stringify({
    contextMode: input.contextMode,
    instructionsVersion: input.instructionsVersion,
    maxIterations: input.maxIterations,
    target: input.target,
    agentTimeoutMs: input.agentTimeoutMs,
    agentIdleTimeoutMs: input.agentIdleTimeoutMs,
    checkTimeoutMs: input.checkTimeoutMs,
    code: canonicalProfile(input.code),
    ...(input.repair ? { repair: canonicalProfile(input.repair) } : {}),
    ...(input.repairSession ? { repairSession: input.repairSession } : {}),
    correctness: canonicalProfile(input.correctness),
    edgeCases: canonicalProfile(input.edgeCases),
    // Only present when configured, so a run without triage keeps the version
    // it had before triage existed.
    ...(input.triage ? { triage: canonicalProfile(input.triage) } : {}),
    // Two runs on different CLI builds are not one population.
    ...(input.cli && Object.keys(input.cli).length > 0
      ? {
          cli: Object.fromEntries(
            Object.entries(input.cli).sort(([x], [y]) => x.localeCompare(y)),
          ),
        }
      : {}),
    ...(commitKey ? { commit: commitKey } : {}),
    ...(input.selfCheck && input.selfCheck.length > 0
      ? { selfCheck: input.selfCheck }
      : {}),
    ...(review.length > 0 ? { review: Object.fromEntries(review) } : {}),
    ...(input.spec
      ? {
          spec: {
            author: canonicalProfile(input.spec.author),
            fix: canonicalProfile(input.spec.fix),
            reviewers: input.spec.reviewers.map((r) => ({
              name: r.name,
              profile: canonicalProfile(r.profile),
              invocation: r.invocation
                ? {
                    command: r.invocation.command,
                    context: r.invocation.context,
                    output: r.invocation.output,
                  }
                : null,
            })),
            maxRounds: input.spec.maxRounds,
            template: input.spec.template,
            reviewTemplate: input.spec.reviewTemplate,
          },
        }
      : {}),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
