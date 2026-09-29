import { TONE_FILL, type Tone } from './status'

/** A state name, always in words; color only for the three states. */
export function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-sm px-2 py-1 text-xs leading-4 font-medium whitespace-nowrap ${TONE_FILL[tone]}`}
    >
      {tone === 'running' ? (
        <span aria-hidden className="dot-live size-2 rounded-full bg-current" />
      ) : null}
      {label}
    </span>
  )
}
