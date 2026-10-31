/**
 * Read a text file a run is given, once, with a size limit checked before
 * and after reading. Shared by trigger's input files and a stage's result,
 * so both are refused for the same reasons in the same words.
 */
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { InputFileRef } from './target.js'

/** Input files are stored in the run and sent in every prompt, so keep them small. */
const MAX_INPUT_FILE_BYTES = 256 * 1024

/**
 * Read one input file once: at trigger, before the run exists, or inside the
 * stage step that settles it. The worker only ever sees the content stored
 * in the run, so editing the file afterwards changes nothing about the run.
 * The content is not parsed. Its SHA-256 is computed from the stored content
 * when the report is built.
 */
export async function readInputFile(
  path: string,
  options: {
    /** How errors name the file, such as `--task-file`. */
    name: string
    /** The directory a relative path is taken from; the current one by default. */
    from?: string
    /** The largest file accepted, in bytes; 256 KiB by default. */
    maxBytes?: number
  },
): Promise<{ content: string; ref: InputFileRef }> {
  const { name, from, maxBytes = MAX_INPUT_FILE_BYTES } = options
  const abs = from ? resolve(from, path) : resolve(path)
  const limit = `the limit is ${maxBytes / 1024} KiB`
  let size: number
  try {
    size = (await stat(abs)).size
  } catch {
    throw new Error(`${name} ${path}: cannot read file`)
  }
  // Check the size before reading, so a huge file is never loaded.
  if (size > maxBytes)
    throw new Error(`${name} ${path}: file is ${size} bytes; ${limit}`)
  let bytes: Buffer
  try {
    bytes = await readFile(abs)
  } catch {
    throw new Error(`${name} ${path}: cannot read file`)
  }
  if (bytes.length > maxBytes)
    throw new Error(`${name} ${path}: file is ${bytes.length} bytes; ${limit}`)
  let content: string
  try {
    // Keep a byte order mark, so the stored text hashes like the file does.
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch {
    throw new Error(`${name} ${path}: not UTF-8 text`)
  }
  if (content.trim().length === 0)
    throw new Error(`${name} ${path}: file is empty`)
  return { content, ref: { path: abs } }
}
