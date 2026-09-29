import { EmptyState } from '../components/EmptyState'
import { COMPARE } from '../glossary'
import type { CompareResponse } from '../server'
import { GroupPanel } from './compare/GroupPanel'

/** Finished runs by config group, each group's statistics side by side. */
export function CompareScreen({ data }: { data: CompareResponse }) {
  const groups = data.comparison.groups
  if (groups.length === 0) return <EmptyState>{COMPARE.empty}</EmptyState>
  return (
    <div className="flex flex-col gap-6">
      <p className="text-fg-2 text-sm">{COMPARE.intro(data.runIds.length)}</p>
      {groups.map((g) => (
        <GroupPanel key={`${g.kind}|${g.configVersion ?? g.label}`} group={g} />
      ))}
    </div>
  )
}
