import type { ReactNode } from 'react'

import { formatRelative } from '../../engine/format'

/** "3分前" from the response's `now`; the exact time on hover. */
export function Ago({
  iso,
  now,
  prefix,
}: {
  iso: string
  now: string
  prefix?: string
}) {
  return (
    <time dateTime={iso} title={iso}>
      {prefix}
      {formatRelative(iso, now)}
    </time>
  )
}

/** The local time and the stored ISO string, for a hover. */
export function exactTime(iso: string | null): string | undefined {
  return iso ? `${new Date(iso).toLocaleString('ja-JP')}  ${iso}` : undefined
}

export const clockFormat = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** A number or an identifier in the monospace face. */
export function Num({ children }: { children: ReactNode }) {
  return <span className="font-code">{children}</span>
}
