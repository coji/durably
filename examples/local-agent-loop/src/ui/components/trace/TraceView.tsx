import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import { TRACE } from '../../glossary'
import type { Trace, TraceNode } from '../../server'
import {
  expandedByDefault,
  findNode,
  flatten,
  followTarget,
  ticks,
  type RunTotals,
  type VisibleRow,
} from './model'
import { TraceAxisHeader, TraceAxisLines } from './TraceAxis'
import { TraceInspector } from './TraceInspector'
import { TraceRow } from './TraceRow'
import { useLiveNow } from './useLiveNow'

/**
 * The run as a span tree beside a waterfall on one time axis from the run's
 * creation, with the selected row's stored details alongside. The tree is a
 * keyboard treegrid that carries every value in text; the waterfall is a
 * drawing of the same values and is hidden from screen readers.
 */
export function TraceView({
  trace,
  totals,
  serverNow,
}: {
  trace: Trace
  totals: RunTotals
  serverNow: string
}) {
  const liveNow = useLiveNow(serverNow, trace.open)
  const origin = Date.parse(trace.startedAt)
  const elapsed = trace.open ? Math.max(0, liveNow - origin) : trace.spanMs
  // An open run keeps a little room right of `now`, so the line is visible.
  const axisMs = Math.max(1, trace.open ? elapsed * 1.06 : trace.spanMs)

  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string>(trace.root.id)
  const [userScrolled, setUserScrolled] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const programmatic = useRef(false)

  const isExpanded = useCallback(
    (n: TraceNode) => overrides[n.id] ?? expandedByDefault(n),
    [overrides],
  )
  const rows = useMemo(
    () => flatten(trace.root, isExpanded),
    [trace.root, isExpanded],
  )
  const follow = useMemo(
    () => followTarget(trace.root, isExpanded),
    [trace.root, isExpanded],
  )
  const selected =
    (selectedId ? findNode(trace.root, selectedId) : null) ??
    follow ??
    trace.root
  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.node.id === focusedId),
  )
  const rovingId = rows[focusIndex]?.node.id ?? trace.root.id

  // Follow the running row until the person scrolls or picks a row.
  const followId = follow?.id ?? null
  useEffect(() => {
    const box = scroller.current
    const row = followId ? rowRefs.current.get(followId) : null
    if (!box || !row || userScrolled || selectedId !== null) return
    const top = row.offsetTop - box.clientHeight / 2
    if (Math.abs(box.scrollTop - top) < 4) return
    programmatic.current = true
    box.scrollTop = Math.max(0, top)
  }, [followId, serverNow, userScrolled, selectedId])

  const focusRow = (id: string) => {
    setFocusedId(id)
    rowRefs.current.get(id)?.focus()
  }
  const setExpanded = (id: string, value: boolean) =>
    setOverrides((o) => ({ ...o, [id]: value }))

  const onKeyDown = (e: KeyboardEvent, row: VisibleRow, i: number) => {
    const n = row.node
    const hasChildren = n.children.length > 0
    const open = hasChildren && isExpanded(n)
    const go = (index: number) => {
      const target = rows[Math.min(rows.length - 1, Math.max(0, index))]
      if (target) focusRow(target.node.id)
    }
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1)
        break
      case 'ArrowUp':
        go(i - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(rows.length - 1)
        break
      case 'ArrowRight':
        if (hasChildren && !open) setExpanded(n.id, true)
        else if (open) go(i + 1)
        break
      case 'ArrowLeft':
        if (open) setExpanded(n.id, false)
        else if (row.parentId) focusRow(row.parentId)
        break
      case 'Enter':
      case ' ':
        setSelectedId(n.id)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const marks = ticks(axisMs)
  const pctOf = (ms: number) => `${(ms / axisMs) * 100}%`

  return (
    <div className="trace-box">
      <div className="trace-layout">
        <div className="border-line min-w-0 overflow-hidden rounded-md border">
          <div
            ref={scroller}
            onScroll={() => {
              if (programmatic.current) programmatic.current = false
              else setUserScrolled(true)
            }}
            className="trace-scroll relative overflow-auto"
          >
            <TraceAxisHeader marks={marks} axisMs={axisMs} pctOf={pctOf} />
            <div className="relative">
              <TraceAxisLines
                marks={marks}
                now={trace.open ? elapsed : null}
                pctOf={pctOf}
              />
              <div
                role="treegrid"
                aria-label={TRACE.label}
                aria-readonly
                className="relative"
              >
                {rows.map((row, i) => {
                  const n = row.node
                  return (
                    <TraceRow
                      key={n.id}
                      row={row}
                      rowRef={(el) => {
                        if (el) rowRefs.current.set(n.id, el)
                        else rowRefs.current.delete(n.id)
                      }}
                      expanded={isExpanded(n)}
                      selected={selected.id === n.id}
                      tabbable={n.id === rovingId}
                      elapsed={elapsed}
                      pctOf={pctOf}
                      onKeyDown={(e) => onKeyDown(e, row, i)}
                      onFocus={() => setFocusedId(n.id)}
                      onSelect={() => {
                        setSelectedId(n.id)
                        setFocusedId(n.id)
                      }}
                      onToggle={() => {
                        setExpanded(n.id, !isExpanded(n))
                        setFocusedId(n.id)
                      }}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        <TraceInspector
          node={selected}
          chosen={selectedId !== null}
          totals={totals}
          elapsed={elapsed}
          origin={trace.startedAt}
        />
      </div>
    </div>
  )
}
