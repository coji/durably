import { LIST } from '../glossary'

/**
 * The word beside a run a later approved repair made moot, with why on
 * hover. The list, the detail header and the task's runs all use it.
 */
export function SupersededMark() {
  return (
    <span title={LIST.supersededTitle} className="text-fg-2 text-xs">
      {LIST.superseded}
    </span>
  )
}
