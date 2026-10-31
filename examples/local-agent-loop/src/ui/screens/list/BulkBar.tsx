import { useState } from 'react'

import { DEMO } from '../../../engine/demo-command'
import { formatCount } from '../../../engine/format'
import { ActionButton, type ActionStage } from '../../components/ActionButton'
import type { BulkItem } from '../../components/BulkNotice'
import { BUTTON_QUIET } from '../../components/button'
import { BULK } from '../../glossary'

/** The CLI line that archives the same tasks, one `--series` each. */
export function seriesCommand(items: BulkItem[]): string {
  return `${DEMO} archive ${items.map((i) => `--series ${i.runId}`).join(' ')}`
}

/**
 * What can be done to the chosen tasks, held at the foot of the window
 * while any are chosen: how many, archive them after a question that names
 * every one, and clear the choice.
 */
export function BulkBar({
  items,
  onArchive,
  onClear,
}: {
  items: BulkItem[]
  onArchive: () => Promise<void>
  onClear: () => void
}) {
  const n = formatCount(items.length)
  // While the question is up it takes the bar's width, and clearing waits.
  const [stage, setStage] = useState<ActionStage>('idle')
  return (
    <div className="bulk-bar pointer-events-none fixed inset-x-0 bottom-0 z-(--z-sticky) px-4 pb-4">
      <div
        role="region"
        aria-label={BULK.selected(n)}
        className="border-line-strong bg-raised pointer-events-auto mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-lg border px-4 py-3 shadow-(--shadow-pop)"
      >
        <p className="mr-auto text-sm font-medium tabular-nums">
          {BULK.selected(n)}
        </p>
        <ActionButton
          label={BULK.archive(n)}
          onAction={onArchive}
          onStageChange={setStage}
          confirm={{
            command: seriesCommand(items),
            details: (
              <div className="flex flex-col gap-2">
                <p>{BULK.archiveNote}</p>
                <ul className="text-fg flex max-h-48 list-disc flex-col gap-1 overflow-y-auto pl-5">
                  {items.map((item) => (
                    <li key={item.runId}>{item.name}</li>
                  ))}
                </ul>
              </div>
            ),
          }}
        />
        {stage === 'idle' ? (
          <button type="button" className={BUTTON_QUIET} onClick={onClear}>
            {BULK.clear}
          </button>
        ) : null}
      </div>
    </div>
  )
}
