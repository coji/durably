import type { Act } from '../components/ActionNotice'
import { EmptyState } from '../components/EmptyState'
import { Section } from '../components/Layout'
import { LIST } from '../glossary'
import type { RunsResponse } from '../server'
import { DoneTasks } from './list/DoneTasks'
import { Overview, SECTION_ID } from './list/Overview'
import { Tasks } from './list/Tasks'

/**
 * A count of each place first, then the tasks a person decides on, the
 * ones a worker has, the ones that stopped, and the finished ones, in the
 * order the engine gave them. A first run and its repairs are one row.
 * Decisions and running tasks open, since they change and ask to be
 * watched; stopped ones stay closed, each with why on its row, unless
 * another run of the task is still open or asks for a person. Archived
 * tasks are among the finished ones.
 */
export function RunsScreen({ data, act }: { data: RunsResponse; act: Act }) {
  if (!data.exists)
    return (
      <EmptyState>
        {LIST.noDbBefore} <span className="font-code">{data.db}</span>{' '}
        {LIST.noDbAfter}
      </EmptyState>
    )
  const rows = new Map(data.runs.map((r) => [r.id, r]))
  const decision = data.tasks.filter((t) => t.attention === 'decision')
  const stop = data.tasks.filter((t) => t.attention === 'stop')
  const active = data.tasks.filter((t) => t.attention === 'active')
  const done = data.tasks.filter((t) => t.attention === 'done')
  // Any run of the task, not only the one that shows it: an older repair
  // can be running while a newer one waits its turn.
  const running = active.filter((t) =>
    t.runs.some((r) => r.kind === 'running'),
  ).length
  return (
    <>
      <Overview
        note={
          decision.length === 0 && stop.length === 0
            ? LIST.attentionEmpty
            : undefined
        }
        counts={{
          decision: decision.length,
          active: active.length,
          running,
          stop: stop.length,
          done: done.length,
        }}
      />
      {decision.length > 0 ? (
        <Section
          id={SECTION_ID.decision}
          title={LIST.decision}
          count={decision.length}
        >
          <Tasks tasks={decision} rows={rows} now={data.now} act={act} open />
        </Section>
      ) : null}
      <Section id={SECTION_ID.active} title={LIST.active} count={active.length}>
        <Tasks
          tasks={active}
          rows={rows}
          now={data.now}
          empty={LIST.activeEmpty}
          act={act}
          open
        />
      </Section>
      {stop.length > 0 ? (
        <Section id={SECTION_ID.stop} title={LIST.stopped} count={stop.length}>
          <Tasks tasks={stop} rows={rows} now={data.now} act={act} />
        </Section>
      ) : null}
      <DoneTasks tasks={done} rows={rows} now={data.now} act={act} />
    </>
  )
}
