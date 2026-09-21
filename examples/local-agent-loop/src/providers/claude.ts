/** Claude Code provider: `claude -p --output-format json` in workdir. */
import { spawn } from 'node:child_process'

import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
  TokenUsage,
} from './types.js'

interface ClaudeJson {
  result?: string
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
  total_cost_usd?: number
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const
  readonly fake = false

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    const model =
      options.model ?? process.env.CLAUDE_MODEL ?? process.env.MODEL ?? null
    const effort = options.effort ?? process.env.CLAUDE_EFFORT ?? null
    const args = [
      '-p',
      '--output-format',
      'json',
      '--add-dir',
      options.workdir,
      '--dangerously-skip-permissions',
    ]
    if (model) args.push('--model', model)
    if (effort) args.push('--effort', effort)
    args.push(options.prompt)

    const child = spawn('claude', args, {
      cwd: options.workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const code: number = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`claude timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
      timer.unref()
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (c) => {
        clearTimeout(timer)
        resolve(c ?? 1)
      })
    })
    const elapsedMs = Date.now() - started
    if (code !== 0) {
      throw new Error(`claude exited ${code}: ${stderr.slice(-2000)}`)
    }
    let parsed: ClaudeJson = {}
    try {
      parsed = JSON.parse(stdout) as ClaudeJson
    } catch {
      return {
        text: stdout.slice(-8000),
        model,
        effort,
        usage: null,
        elapsedMs,
      }
    }
    const input = parsed.usage?.input_tokens ?? null
    const output = parsed.usage?.output_tokens ?? null
    const usage: TokenUsage | null =
      input == null && output == null
        ? null
        : {
            inputTokens: input,
            outputTokens: output,
            totalTokens:
              input != null && output != null ? input + output : null,
          }
    return {
      text: parsed.result ?? stdout.slice(-8000),
      model: parsed.model ?? model,
      effort,
      usage,
      elapsedMs,
    }
  }
}
