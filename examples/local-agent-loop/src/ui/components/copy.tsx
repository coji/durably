import { useCallback, useEffect, useRef, useState } from 'react'

import { COPY } from '../glossary'
import { BUTTON } from './button'

/** Copy through the Clipboard API, or a hidden selection where it is refused. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

export interface Copied {
  text: string
  label: string
}

export type OnCopy = (text: string, label: string) => void

/** What was copied last, for a moment, and the function that copies. */
export function useCopy(): { copied: Copied | null; copy: OnCopy } {
  const [copied, setCopied] = useState<Copied | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback((text: string, label: string) => {
    void writeClipboard(text).then((ok) => {
      setCopied(ok ? { text, label } : null)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(null), 1600)
    })
  }, [])
  return { copied, copy }
}

/** A labelled copy button with a short confirmation beside it. */
export function CopyButton({
  text,
  label,
  title,
  copied,
  onCopy,
}: {
  text: string
  label: string
  /** What the copied text does, on hover. */
  title?: string
  copied: { text: string } | null
  onCopy: OnCopy
}) {
  return (
    <span className="relative">
      <button
        type="button"
        title={title}
        onClick={() => onCopy(text, label)}
        className={BUTTON}
      >
        {label}
      </button>
      {copied?.text === text ? (
        <span
          aria-hidden
          className="bg-raised text-fg absolute top-full left-0 z-(--z-toast) mt-1 rounded-sm px-2 py-1 text-xs whitespace-nowrap shadow-(--shadow-pop)"
        >
          {COPY.copied}
        </span>
      ) : null}
    </span>
  )
}

/** Names what was copied, for screen readers. */
export function CopyAnnouncer({
  copied,
}: {
  copied: { label: string } | null
}) {
  return (
    <p className="sr-only" aria-live="polite">
      {copied ? COPY.announce(copied.label) : ''}
    </p>
  )
}
