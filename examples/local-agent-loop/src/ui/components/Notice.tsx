import type { ReactNode } from 'react'

import { ACTION } from '../glossary'
import { BUTTON_QUIET } from './button'
import type { Tone } from './status'

const RULE: Record<Tone, string> = {
  waiting: 'border-waiting bg-waiting-bg',
  failed: 'border-failed bg-failed-bg',
  running: 'border-running bg-running-bg',
  done: 'border-line-strong bg-sunken',
}

/**
 * A short message about the page itself, such as a refresh that failed or
 * an action that finished. The rule on its left carries the state's color.
 */
export function Notice({
  tone = 'done',
  title,
  children,
  onDismiss,
}: {
  tone?: Tone
  title?: string
  children?: ReactNode
  /** Offer a close button, for a notice that stays until read. */
  onDismiss?: () => void
}) {
  return (
    <div
      role={tone === 'failed' ? 'alert' : 'status'}
      className={`flex items-start gap-3 rounded-sm border-l-2 px-3 py-2 text-sm ${RULE[tone]}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="text-fg font-medium">{title}</p> : null}
        {children ? <div className="text-fg-2 text-xs">{children}</div> : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className={BUTTON_QUIET}>
          {ACTION.dismiss}
        </button>
      ) : null}
    </div>
  )
}
