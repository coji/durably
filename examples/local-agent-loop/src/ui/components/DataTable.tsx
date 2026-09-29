import type { ReactNode } from 'react'

/**
 * A table of runs or numbers. `framed` gives it its own border, for a
 * table that stands alone on the page; inside a panel it has none.
 */
export function DataTable({
  head,
  children,
  framed,
}: {
  head: ReactNode
  children: ReactNode
  framed?: boolean
}) {
  return (
    <div
      className={
        framed
          ? 'border-line bg-raised overflow-x-auto rounded-lg border'
          : 'overflow-x-auto'
      }
    >
      <table className="w-full text-sm">
        <thead className="border-line border-b">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-line divide-y">{children}</tbody>
      </table>
    </div>
  )
}

export function Th({
  children,
  num,
  title,
}: {
  children: ReactNode
  num?: boolean
  title?: string
}) {
  return (
    <th
      scope="col"
      title={title}
      className={`text-fg-2 px-3 py-2 text-xs font-medium ${num ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  )
}

export function Td({ children, num }: { children: ReactNode; num?: boolean }) {
  return (
    <td className={`px-3 py-2 align-top ${num ? 'font-code text-right' : ''}`}>
      {children}
    </td>
  )
}
