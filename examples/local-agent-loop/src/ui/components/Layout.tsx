import type { ReactNode } from 'react'

export const PAGE_TITLE_ID = 'page-title'

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

/** A titled part of a page, with how many items it holds. */
export function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold">
        {title}
        {count !== undefined ? <Count n={count} /> : null}
      </h2>
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

/** A chevron that turns when its disclosure opens. */
export function Chevron() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className="text-fg-3 size-3 shrink-0 transition-transform duration-(--duration-fast) ease-out group-open:rotate-90"
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

/** A panel that opens and closes; closed, only its heading shows. */
export function Collapsible({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details
      open={defaultOpen}
      className="group border-line bg-raised rounded-lg border"
    >
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-4 py-3 text-base font-semibold [&::-webkit-details-marker]:hidden">
        <Chevron />
        <h2 className="flex items-baseline gap-2">
          {title}
          {count !== undefined ? <Count n={count} /> : null}
        </h2>
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  )
}
