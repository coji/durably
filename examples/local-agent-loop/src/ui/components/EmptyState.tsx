import type { ReactNode } from 'react'

export type EmptyKind = 'empty' | 'loading' | 'error'

const KIND_CLASS: Record<EmptyKind, string> = {
  empty: 'border-line-strong text-fg-2 border border-dashed',
  loading: 'text-fg-2',
  error: 'border-failed/40 text-fg border border-dashed',
}

/**
 * What a place shows when it has nothing to show: nothing yet, still
 * loading, or could not load.
 */
export function EmptyState({
  kind = 'empty',
  children,
}: {
  kind?: EmptyKind
  children: ReactNode
}) {
  if (kind === 'loading')
    return <p className={`text-sm ${KIND_CLASS.loading}`}>{children}</p>
  return (
    <p className={`rounded-lg px-4 py-3 text-sm ${KIND_CLASS[kind]}`}>
      {children}
    </p>
  )
}
