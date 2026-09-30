import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { TRACE } from '../../glossary'
import { followLogParts } from '../../poll'
import type { LogFile } from '../../server'

/** How often an unfinished log is read again: the page's own refresh. */
const REFRESH_MS = 3000

/** The most of a log kept on screen, in bytes: the end of a longer one. */
const SHOWN_MAX = 256 * 1024

export type LogState = 'live' | 'done' | 'missing' | 'failed'

/** A log as read so far: its text, and whether more may come. */
export interface LogView {
  /** Plain text: terminal escapes are removed as parts arrive. */
  text: string
  state: LogState
  /** The start was dropped to keep the text within `SHOWN_MAX`. */
  trimmed: boolean
}

/** Terminal escapes: colors, cursor moves and window titles. */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/** An escape at the very end that the next part may still finish. */
const UNFINISHED =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?)?$/

/** An unfinished escape longer than this is text, not held back forever. */
const HELD_MAX = 256

/**
 * `held + chunk` without its terminal escapes. An unfinished escape at the
 * end is returned as `held`, to be read again with the next part; once the
 * log is done it is dropped.
 */
export function plainPart(
  held: string,
  chunk: string,
  done: boolean,
): { text: string; held: string } {
  const raw = held + chunk
  if (done)
    return { text: raw.replace(ANSI, '').replace(UNFINISHED, ''), held: '' }
  const tail = UNFINISHED.exec(raw)?.[0] ?? ''
  const next = tail.length <= HELD_MAX ? tail : ''
  return {
    text: raw.slice(0, raw.length - next.length).replace(ANSI, ''),
    held: next,
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** `text` cut to its last `SHOWN_MAX` bytes, on a character boundary. */
export function logTail(text: string): { text: string; cut: boolean } {
  if (text.length * 3 <= SHOWN_MAX) return { text, cut: false }
  const bytes = encoder.encode(text)
  if (bytes.length <= SHOWN_MAX) return { text, cut: false }
  let start = bytes.length - SHOWN_MAX
  while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  return { text: decoder.decode(bytes.subarray(start)), cut: true }
}

const EMPTY: LogView = { text: '', state: 'live', trimmed: false }

/**
 * Follow the log at `url` from its start until it is done or missing,
 * handing each new view to `onView`. Returns the function that stops it.
 */
export function followLog(
  url: string,
  onView: (view: LogView) => void,
  intervalMs = REFRESH_MS,
): () => void {
  let view = EMPTY
  let held = ''
  const show = (next: LogView) => onView((view = next))
  return followLogParts(url, intervalMs, {
    part: (part) => {
      // Stripped before the tail is cut, so a cut never splits an escape.
      const plain = plainPart(held, part.chunk, part.done)
      held = plain.held
      const next = logTail(view.text + plain.text)
      show({
        text: next.text,
        state: part.done ? 'done' : 'live',
        trimmed: view.trimmed || next.cut,
      })
    },
    missing: () => show({ ...view, state: 'missing' }),
    error: () => show({ ...view, state: 'failed' }),
  })
}

/** Where a log is read from: the run and the attempt that recorded it. */
export interface LogSource {
  runId: string
  attemptId: string
}

export function logUrl(source: LogSource, file: LogFile): string {
  const run = encodeURIComponent(source.runId)
  const attempt = encodeURIComponent(source.attemptId)
  return `/api/runs/${run}/logs/${attempt}?file=${file}`
}

/** Whether the log is still being written, in words and a quiet dot. */
function LogStateMark({ state }: { state: LogState }) {
  if (state === 'live')
    return (
      <span className="text-running inline-flex items-center gap-1 text-xs">
        <span
          aria-hidden
          className="dot-live size-1.5 rounded-full bg-current"
        />
        {TRACE.logLive}
      </span>
    )
  return state === 'done' ? (
    <span className="text-fg-3 text-xs">{TRACE.logDone}</span>
  ) : null
}

/**
 * A log's text as plain characters, never markup. It keeps to the end while the reader is there, and holds
 * still once they scroll up.
 */
export function LogBody({ view }: { view: LogView }) {
  const box = useRef<HTMLPreElement | null>(null)
  const pinned = useRef(true)
  const labelId = useId()
  const text = view.text
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="text-fg-3 text-xs">
          {TRACE.logBody}
        </span>
        <LogStateMark state={view.state} />
      </div>
      {view.state === 'missing' ? (
        <p className="text-fg-2 text-sm">{TRACE.logMissing}</p>
      ) : text === '' ? (
        <p className="text-fg-3 text-xs">
          {view.state === 'done' ? TRACE.logNone : TRACE.logEmpty}
        </p>
      ) : (
        <pre
          ref={box}
          tabIndex={0}
          aria-labelledby={labelId}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 8
          }}
          className="bg-sunken font-code max-h-80 overflow-auto rounded-md px-3 py-2 text-xs leading-5 break-words whitespace-pre-wrap"
        >
          {text}
        </pre>
      )}
      {view.trimmed ? (
        <p className="text-fg-3 text-xs">{TRACE.logTrimmed}</p>
      ) : null}
      {view.state === 'failed' ? (
        <p className="text-fg-2 text-xs">{TRACE.logFailed}</p>
      ) : null}
    </div>
  )
}

/** `followLog` for a component, which is keyed by its URL. */
function FollowedLog({ url }: { url: string }) {
  const [view, setView] = useState<LogView>(EMPTY)
  useEffect(() => followLog(url, setView), [url])
  return <LogBody view={view} />
}

/** A log read live from the server; another URL starts a fresh read. */
export function LiveLog({ url }: { url: string }) {
  return <FollowedLog key={url} url={url} />
}

/** A check's stdout or stderr, one at a time, read live. */
export function CheckLogBody({ source }: { source: LogSource }) {
  const [file, setFile] = useState<'stdout' | 'stderr'>('stdout')
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label={TRACE.logShown} className="flex gap-1">
        {(['stdout', 'stderr'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={file === f}
            onClick={() => setFile(f)}
            className="border-line text-fg-2 aria-pressed:bg-sunken aria-pressed:text-fg rounded-sm border px-2 py-1 text-xs"
          >
            {TRACE[f]}
          </button>
        ))}
      </div>
      <LiveLog url={logUrl(source, file)} />
    </div>
  )
}
