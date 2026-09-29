/**
 * The trace tree as rows on screen: which rows show, which one to follow,
 * each row's times against the live clock, and the axis ticks.
 */
import type { TraceNode } from '../../server'

export interface VisibleRow {
  node: TraceNode
  level: number
  parentId: string | null
  posinset: number
  setsize: number
}

/** Iterations and the run start expanded; retried attempts start folded. */
export function expandedByDefault(node: TraceNode): boolean {
  return node.kind !== 'entry'
}

export function flatten(
  node: TraceNode,
  isExpanded: (n: TraceNode) => boolean,
): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (
    n: TraceNode,
    level: number,
    parentId: string | null,
    posinset: number,
    setsize: number,
  ) => {
    out.push({ node: n, level, parentId, posinset, setsize })
    if (n.children.length > 0 && isExpanded(n))
      n.children.forEach((c, i) =>
        walk(c, level + 1, n.id, i + 1, n.children.length),
      )
  }
  walk(node, 1, null, 1, 1)
  return out
}

/** The deepest row still running or waiting, through expanded rows only. */
export function followTarget(
  root: TraceNode,
  isExpanded: (n: TraceNode) => boolean,
): TraceNode | null {
  let at: TraceNode | null = null
  let n: TraceNode | undefined = root
  while (n?.open) {
    at = n
    if (!isExpanded(n)) break
    n = [...n.children].reverse().find((c) => c.open)
  }
  return at === root ? null : at
}

export function findNode(root: TraceNode, id: string): TraceNode | null {
  if (root.id === id) return root
  for (const c of root.children) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

/** A row's times with any open end moved to the live clock. */
export function liveTimes(node: TraceNode, elapsed: number) {
  const end = node.open ? Math.max(node.endMs ?? elapsed, elapsed) : node.endMs
  const duration =
    node.open && node.startMs !== null
      ? Math.max(node.durationMs ?? 0, elapsed - node.startMs)
      : node.durationMs
  return { start: node.startMs, end, duration }
}

/** Round steps from a tenth of a second, the finest a duration is written. */
const TICK_STEPS = [100, 200, 500]
  .concat(
    [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map(
      (s) => s * 1000,
    ),
  )
  .concat([2, 3, 6, 12, 24].map((h) => h * 3_600_000))

/** At most five round ticks from 0 across the span. */
export function ticks(spanMs: number): number[] {
  const step =
    TICK_STEPS.find((t) => spanMs / t <= 5) ?? TICK_STEPS.at(-1) ?? spanMs
  const out: number[] = []
  for (let t = 0; t < spanMs; t += step) out.push(t)
  return out
}

/** The run's own totals, which the whole-run row shows. */
export interface RunTotals {
  leadTimeMs: number | null
  invocations: number
  totalTokens: number | null
  costUsd: number | null
  /** Whether the token total covers every call. */
  complete: boolean
}
