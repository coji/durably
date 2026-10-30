import type { ReactNode } from 'react'

const PAGE_TITLE_ID = 'page-title'

export function focusPageTitle() {
  document.getElementById(PAGE_TITLE_ID)?.focus()
}

/** The page's one h1; focus lands here when the route changes. */
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1
      id={PAGE_TITLE_ID}
      tabIndex={-1}
      className="text-xl font-semibold text-balance focus-visible:outline-none"
    >
      {children}
    </h1>
  )
}

function Count({ n }: { n: number }) {
  return <span className="text-fg-2 text-sm font-normal tabular-nums">{n}</span>
}

/**
 * A titled part of a page, with how many items it holds. `note` is a short
 * line beside the heading; `tools` sit at its far end, such as a filter.
 */
export function Section({
  id,
  title,
  count,
  note,
  tools,
  children,
}: {
  /** Where the page's overview scrolls to. */
  id?: string
  title: string
  count?: number
  note?: string
  tools?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className="scroll-target mb-8"
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-baseline gap-2 text-lg font-semibold">
          {title}
          {count !== undefined ? <Count n={count} /> : null}
        </h2>
        {note ? <span className="text-fg-2 text-xs">{note}</span> : null}
        {tools ? (
          <div className="flex flex-wrap items-center gap-3 md:ml-auto">
            {tools}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** A bordered box of related facts under one heading. */
export function Panel({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="border-line bg-raised rounded-lg border p-4">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/**
 * A chevron that turns when its disclosure opens: inside a `<details>` by
 * itself, beside a toggle button by `open`.
 */
export function Chevron({ open }: { open?: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={`text-fg-3 size-3 shrink-0 transition-transform duration-(--duration-fast) ease-out group-open:rotate-90 ${open ? 'rotate-90' : ''}`}
    >
      <path
        d="M4.5 3l3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A panel that opens and closes; closed, only its heading shows. `bare`
 * drops the box, for a part of the page that holds panels of its own.
 */
export function Collapsible({
  title,
  count,
  note,
  defaultOpen,
  bare,
  children,
}: {
  title: string
  count?: number
  /** A short line beside the heading, such as what opening shows. */
  note?: string
  defaultOpen?: boolean
  bare?: boolean
  children: ReactNode
}) {
  return (
    <details
      open={defaultOpen}
      className={`group ${bare ? '' : 'border-line bg-raised rounded-lg border'}`}
    >
      <summary
        className={`flex min-h-8 cursor-pointer list-none flex-wrap items-center gap-x-2 text-base font-semibold [&::-webkit-details-marker]:hidden ${bare ? 'py-2' : 'px-4 py-3'}`}
      >
        <Chevron />
        <h2 className="flex items-baseline gap-2">
          {title}
          {count !== undefined ? <Count n={count} /> : null}
        </h2>
        {note ? (
          <span className="text-fg-2 text-xs font-normal">{note}</span>
        ) : null}
      </summary>
      <div className={bare ? 'flex flex-col gap-6 pt-3' : 'px-4 pb-4'}>
        {children}
      </div>
    </details>
  )
}
