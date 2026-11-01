import { LIST, REPO } from '../glossary'

/**
 * The word beside a stopped run a person archived, with why on hover. The
 * list, the detail header and the task's runs all use it.
 */
export function ArchivedMark() {
  return (
    <span title={LIST.archivedTitle} className="text-fg-2 text-xs">
      {LIST.archived}
    </span>
  )
}

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

/**
 * The repository a run worked on, beside its name, with its path on hover
 * when it has one. The list, the detail header and the task's runs all use
 * it.
 */
export function RepoMark({ name, path }: { name: string; path?: string }) {
  return (
    <span title={path} className="font-code text-fg-2 text-xs">
      <span className="sr-only">{REPO.label} </span>
      {name}
    </span>
  )
}

/**
 * The word beside a finished task whose first run used the fake provider,
 * with why on hover: a rehearsal, still listed but left out of the trend.
 */
export function FakeMark() {
  return (
    <span title={LIST.fakeTitle} className="text-fg-2 text-xs">
      {LIST.fake}
    </span>
  )
}
