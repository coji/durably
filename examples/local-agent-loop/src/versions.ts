/** Version recording: AI SDK + provider packages + local CLIs. */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function packageVersion(name: string): string | null {
  try {
    const pkg = require(`${name}/package.json`) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

function cliVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(null)
        return
      }
      const out = `${stdout} ${stderr}`.trim().split('\n')[0]?.trim() ?? ''
      resolve(out.length > 0 ? out.slice(0, 120) : null)
    })
  })
}

/**
 * Resolve the versions used for one provider call. Only the selected
 * provider's CLI is probed — the unselected CLI is never required to be
 * installed or authenticated.
 */
export async function resolveVersions(
  provider: 'codex' | 'claude' | 'fake',
): Promise<Record<string, string | null>> {
  const base = {
    ai: packageVersion('ai'),
    'ai-sdk-provider-codex-cli': packageVersion('ai-sdk-provider-codex-cli'),
    'ai-sdk-provider-claude-code': packageVersion(
      'ai-sdk-provider-claude-code',
    ),
  }
  if (provider === 'codex') {
    return { ...base, codexCli: await cliVersion('codex', ['--version']) }
  }
  if (provider === 'claude') {
    return { ...base, claudeCli: await cliVersion('claude', ['--version']) }
  }
  return base
}
