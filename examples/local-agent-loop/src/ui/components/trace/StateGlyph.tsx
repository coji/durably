import type { TraceState } from '../../server'

const BOX = 'size-3 shrink-0'

/** A 12px glyph per state; the state's word always sits beside it. */
export function StateGlyph({ state }: { state: TraceState }) {
  switch (state) {
    case 'running':
      return (
        <span
          aria-hidden
          className={`${BOX} text-running grid place-items-center`}
        >
          <span className="dot-live size-2 rounded-full bg-current" />
        </span>
      )
    case 'waiting':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${BOX} text-waiting`}>
          <rect
            x="3"
            y="2.5"
            width="2"
            height="7"
            rx="0.5"
            fill="currentColor"
          />
          <rect
            x="7"
            y="2.5"
            width="2"
            height="7"
            rx="0.5"
            fill="currentColor"
          />
        </svg>
      )
    case 'failed':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${BOX} text-failed`}>
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'done':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${BOX} text-fg-3`}>
          <path
            d="M2.5 6.25l2.25 2.25L9.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'interrupted':
    case 'lost':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${BOX} text-fg-3`}>
          <path
            d="M3 6h6"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'idle':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${BOX} text-fg-3`}>
          <circle
            cx="6"
            cy="6"
            r="3.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          />
        </svg>
      )
  }
}
