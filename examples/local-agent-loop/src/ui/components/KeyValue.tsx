import type { ReactNode } from 'react'

import { COMMON } from '../glossary'

/** A label above its value; the value is data, set in the monospace face. */
export function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-fg-2 text-xs">{label}</dt>
      <dd className="font-code text-sm break-all">{children}</dd>
    </div>
  )
}

/** A label beside its value, for a narrow column of many facts. */
export function InlineField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="kv-inline gap-2 py-1">
      <dt className="text-fg-2 text-xs leading-5">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

/** Inline fields as one list, a hairline between each. */
export function InlineFields({ children }: { children: ReactNode }) {
  return <dl className="divide-line flex flex-col divide-y">{children}</dl>
}

/** Marks a value that covers only part of what it counts. */
export function PartialTag({ title }: { title: string }) {
  return (
    <span title={title} className="text-fg-3 font-ui ml-1 text-xs">
      {COMMON.partial}
    </span>
  )
}
