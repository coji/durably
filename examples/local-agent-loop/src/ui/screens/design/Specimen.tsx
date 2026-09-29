import type { ReactNode } from 'react'

import { DESIGN } from '../../glossary'

/**
 * One component on the design page: its name and rule, then the same
 * states drawn twice, once in each color scheme. Each pane sets its own
 * `color-scheme`, which the `light-dark()` tokens follow.
 */
export function Specimen({
  id,
  name,
  about,
  wide,
  children,
}: {
  id: string
  name: string
  about: string
  /** Stack the two panes, for a component that needs the page's width. */
  wide?: boolean
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex scroll-mt-16 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold">
          {name}
        </h2>
        <p className="text-fg-2 text-sm">{about}</p>
      </div>
      <div className={`grid gap-3 ${wide ? '' : 'xl:grid-cols-2'}`}>
        <Pane scheme="light">{children}</Pane>
        <Pane scheme="dark">{children}</Pane>
      </div>
    </section>
  )
}

function Pane({
  scheme,
  children,
}: {
  scheme: 'light' | 'dark'
  children: ReactNode
}) {
  return (
    <div
      className={`${scheme === 'light' ? 'scheme-light' : 'scheme-dark'} bg-canvas text-fg border-line flex min-w-0 flex-col gap-4 rounded-lg border p-4`}
    >
      <p className="text-fg-3 text-xs">
        {scheme === 'light' ? DESIGN.light : DESIGN.dark}
      </p>
      {children}
    </div>
  )
}

/** One state of a component, named above it. */
export function State({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-fg-2 text-xs">{label}</p>
      {children}
    </div>
  )
}
