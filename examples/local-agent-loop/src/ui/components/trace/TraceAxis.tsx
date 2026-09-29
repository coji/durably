import { formatTick } from '../../../engine/format'
import { TRACE } from '../../glossary'

/** The sticky header: the two column names and the time axis's ticks. */
export function TraceAxisHeader({
  marks,
  axisMs,
  pctOf,
}: {
  marks: number[]
  axisMs: number
  pctOf: (ms: number) => string
}) {
  return (
    <div
      aria-hidden
      className="trace-cols bg-raised border-line text-fg-2 sticky top-0 z-10 h-7 items-center border-b text-xs"
    >
      <span className="px-2">{TRACE.stage}</span>
      <span className="px-2 text-right">{TRACE.duration}</span>
      <span className="relative h-full tabular-nums">
        {marks.map((m) => (
          <span
            key={m}
            className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap"
            style={{
              left: pctOf(m),
              // The first label starts at 0; one near the edge ends there.
              transform:
                m === 0
                  ? 'translateY(-50%)'
                  : m / axisMs > 0.92
                    ? 'translate(-100%, -50%)'
                    : 'translate(-50%, -50%)',
            }}
          >
            {formatTick(m)}
          </span>
        ))}
      </span>
    </div>
  )
}

/** Tick lines and the `now` line, over the waterfall column only. */
export function TraceAxisLines({
  marks,
  now,
  pctOf,
}: {
  marks: number[]
  /** Where `now` is on the axis, for an open run. */
  now: number | null
  pctOf: (ms: number) => string
}) {
  return (
    <div
      aria-hidden
      className="trace-cols pointer-events-none absolute inset-0"
    >
      <span />
      <span />
      <span className="relative">
        {marks.slice(1).map((m) => (
          <span
            key={m}
            className="bg-line absolute inset-y-0 w-px"
            style={{ left: pctOf(m) }}
          />
        ))}
        {now !== null ? (
          <span
            className="bg-fg-2 absolute inset-y-0 w-px"
            style={{ left: pctOf(now) }}
          />
        ) : null}
      </span>
    </div>
  )
}
