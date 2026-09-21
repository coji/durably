/** Codex CLI provider: `codex exec --json` in workdir, one session per call. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveEffort } from '../models.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
  TokenUsage,
} from './types.js'

function parseUsageLine(line: string): TokenUsage | null {
  try {
    const evt = JSON.parse(line) as Record<string, unknown>
    const payload = (evt.payload ?? evt) as Record<string, unknown>
    const usage = (payload.usage ?? payload.tokens) as
      | Record<string, unknown>
      | undefined
    if (!usage || typeof usage !== 'object') return null
    const num = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) ? v : null
    const input =
      num(usage.input_tokens) ?? num(usage.inputTokens) ?? num(usage.input)
    const output =
      num(usage.output_tokens) ?? num(usage.outputTokens) ?? num(usage.output)
    const total =
      num(usage.total_tokens) ?? num(usage.totalTokens) ?? num(usage.total)
    if (input == null && output == null && total == null) return null
    return { inputTokens: input, outputTokens: output, totalTokens: total }
  } catch {
    return null
  }
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const
  readonly fake = false

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    const model =
      options.model ?? process.env.CODEX_MODEL ?? process.env.MODEL ?? null
    // codex exec exposes no effort flag: effort is record-only metadata.
    const effort = resolveEffort(
      options.effort,
      process.env.CODEX_EFFORT,
      model,
    )
    const outFile = join(tmpdir(), `codex-last-${randomUUID()}.md`)
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      options.workdir,
      '-o',
      outFile,
    ]
    if (model) args.push('-m', model)
    // Sandbox: allow the agent to edit only the execution workdir.
    args.push('-s', 'workspace-write')
    args.push(options.prompt)

    const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
        reject(new Error(`codex exec timed out after ${options.timeoutMs}ms`))
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
      throw new Error(`codex exec exited ${code}: ${stderr.slice(-2000)}`)
    }
    let usage: TokenUsage | null = null
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const u = parseUsageLine(line)
      if (u) usage = u
    }
    let text = ''
    try {
      text = await readFile(outFile, 'utf8')
    } catch {
      text = stdout.slice(-8000)
    }
    return { text, model, effort, usage, elapsedMs }
  }
}
