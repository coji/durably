import type { CSSProperties, KeyboardEvent, Ref } from 'react'

import { formatDuration } from '../../../engine/format'
import { TRACE } from '../../glossary'
import type { TraceNode } from '../../server'
import { TONE_TEXT, traceStatus } from '../status'
import { liveTimes, type VisibleRow } from './model'
import { StateGlyph } from './StateGlyph'

function barClass(node: TraceNode): string {
  // The run and its iterations are plain spans of what they contain.
  if (node.kind === 'run' || node.kind === 'iteration')
    return node.state === 'failed' ? 'bg-failed/50' : 'bg-fg-3/35'
  if (node.wait)
    return node.open
      ? 'bar-hatch border border-dashed border-waiting'
      : 'bar-hatch-done border border-dashed border-fg-3'
  if (node.state === 'failed') return 'bg-failed'
  if (node.open) return 'bg-running bar-live'
  return 'bg-fg-3/60'
}

const BAR_HEIGHT: Record<TraceNode['kind'], string> = {
  run: 'h-1.5',
  iteration: 'h-1.5',
  entry: 'h-3',
  attempt: 'h-2',
}

/** A tree row's expand toggle: a chevron that turns when open. */
function Toggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <span
      aria-hidden
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className="text-fg-3 hover:text-fg grid size-4 shrink-0 cursor-pointer place-items-center"
    >
      <svg
        viewBox="0 0 12 12"
        className={`size-3 transition-transform duration-(--duration-fast) ${open ? 'rotate-90' : ''}`}
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
    </span>
  )
}

/**
 * One row of the treegrid: the name with its state, the duration, and the
 * bar. The bar is a drawing of the same values and is hidden from readers.
 */
export function TraceRow({
  row,
  rowRef,
  expanded,
  selected,
  tabbable,
  elapsed,
  pctOf,
  onKeyDown,
  onFocus,
  onSelect,
  onToggle,
}: {
  row: VisibleRow
  rowRef: Ref<HTMLDivElement>
  expanded: boolean
  selected: boolean
  tabbable: boolean
  elapsed: number
  pctOf: (ms: number) => string
  onKeyDown: (e: KeyboardEvent) => void
  onFocus: () => void
  onSelect: () => void
  onToggle: () => void
}) {
  const n = row.node
  const t = liveTimes(n, elapsed)
  const state = traceStatus(n.state)
  const hasChildren = n.children.length > 0
  const isOpen = hasChildren && expanded
  return (
    <div
      ref={rowRef}
      role="row"
      aria-level={row.level}
      aria-posinset={row.posinset}
      aria-setsize={row.setsize}
      aria-expanded={hasChildren ? isOpen : undefined}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onClick={onSelect}
      className={`trace-cols h-7 cursor-default items-center text-sm focus-visible:rounded-none focus-visible:-outline-offset-2 ${selected ? 'bg-sunken' : 'hover:bg-sunken/60'}`}
    >
      <span
        role="gridcell"
        className="trace-indent flex min-w-0 items-center gap-1 pr-2"
        style={{ '--level': row.level - 1 } as CSSProperties}
      >
        {hasChildren ? (
          <Toggle open={isOpen} onToggle={onToggle} />
        ) : (
          <span aria-hidden className="size-4 shrink-0" />
        )}
        <StateGlyph state={n.state} />
        <span
          className={`truncate ${n.kind === 'iteration' || n.kind === 'run' ? 'font-medium' : ''} ${n.kind === 'attempt' ? 'text-fg-2' : ''}`}
        >
          {n.label}
        </span>
        {n.state !== 'done' ? (
          <span className={`shrink-0 text-xs ${TONE_TEXT[state.tone]}`}>
            {state.label}
          </span>
        ) : (
          <span className="sr-only">{state.label}</span>
        )}
      </span>
      <span
        role="gridcell"
        className="font-code text-fg-2 px-2 text-right text-xs whitespace-nowrap"
      >
        {formatDuration(t.duration)}
        <span className="sr-only">
          {TRACE.fromStart(formatDuration(t.start))}
        </span>
      </span>
      <span aria-hidden className="relative h-full">
        {t.start === null ? null : t.end === null ? (
          <span
            title={TRACE.noEnd}
            className="border-fg-3 absolute inset-y-2 border-l-2 border-dotted"
            style={{ left: pctOf(t.start) }}
          />
        ) : (
          <span
            className={`absolute top-1/2 min-w-0.5 -translate-y-1/2 rounded-sm ${BAR_HEIGHT[n.kind]} ${barClass(n)}`}
            style={{
              left: pctOf(t.start),
              width: pctOf(Math.max(0, t.end - t.start)),
            }}
          />
        )}
      </span>
    </div>
  )
}
