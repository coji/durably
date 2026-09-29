import { useState } from 'react'

import { ActionButton } from '../../components/ActionButton'
import { CheckLogs } from '../../components/CheckLogs'
import { Commands } from '../../components/Commands'
import { CopyButton, useCopy } from '../../components/copy'
import { EmptyState } from '../../components/EmptyState'
import { LiveProgress } from '../../components/LiveProgress'
import { Notice } from '../../components/Notice'
import { LogWriteError, PathValue } from '../../components/PathValue'
import { ReviewFindingTitles } from '../../components/ReviewFindingTitles'
import { RunLink } from '../../components/RunLink'
import { kindStatus, TONES } from '../../components/status'
import { StatusBadge } from '../../components/StatusBadge'
import { TaskLineage } from '../../components/TaskLineage'
import { Ago } from '../../components/Time'
import { COMMON, COPY, DESIGN, KIND_NAME, REFRESH } from '../../glossary'
import { commandText } from '../../labels'
import { COMMANDS, LINEAGE, NOW, TASKS } from './fixtures'
import { State } from './Specimen'

const KINDS = Object.keys(KIND_NAME) as (keyof typeof KIND_NAME)[]

export function BadgeStates() {
  return (
    <div className="flex flex-wrap gap-2">
      {KINDS.map((kind) => {
        const s = kindStatus(kind)
        return <StatusBadge key={kind} label={s.label} tone={s.tone} />
      })}
    </div>
  )
}

/**
 * Actions that only say they did nothing: the design page never writes. A
 * confirmed action shows its question and command, then the same notice.
 */
export function ActionStates() {
  const [pressed, setPressed] = useState(false)
  const done = () => setPressed(true)
  const approve = commandText(COMMANDS[0] as string)
  const retrigger = commandText(COMMANDS[2] as string)
  return (
    <>
      <State label={DESIGN.state.plain}>
        <div className="flex flex-wrap gap-2">
          <ActionButton label={DESIGN.sample.refresh} onAction={done} />
        </div>
      </State>
      <State label={DESIGN.state.confirm}>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label={DESIGN.sample.approve}
            onAction={done}
            confirm={{ command: approve }}
          />
          <ActionButton
            label={DESIGN.sample.reject}
            onAction={done}
            confirm={{ command: approve.replace(' approve ', ' reject ') }}
          />
        </div>
      </State>
      <State label={DESIGN.state.confirming}>
        <ActionButton
          label={DESIGN.sample.retrigger}
          onAction={done}
          confirm={{ command: retrigger }}
          initialStage="confirming"
        />
      </State>
      <State label={DESIGN.state.busy}>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label={DESIGN.sample.refresh}
            onAction={done}
            initialStage="busy"
          />
        </div>
      </State>
      <State label={DESIGN.state.disabled}>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label={DESIGN.sample.approve}
            onAction={done}
            disabled
          />
        </div>
      </State>
      {pressed ? <Notice title={DESIGN.sample.done} /> : null}
    </>
  )
}

export function CopyStates() {
  const { copied, copy } = useCopy()
  const id = TASKS[0].id
  return (
    <>
      <State label={DESIGN.state.idle}>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            text={id}
            label={COPY.runId}
            copied={copied}
            onCopy={copy}
          />
        </div>
      </State>
      <State label={DESIGN.state.copied}>
        <div className="flex flex-wrap gap-2 pb-8">
          <CopyButton
            text={id}
            label={COPY.runId}
            copied={{ text: id }}
            onCopy={copy}
          />
        </div>
      </State>
      <State label={DESIGN.state.commands}>
        <Commands lines={COMMANDS} />
      </State>
    </>
  )
}

export function EmptyStates() {
  return (
    <>
      <State label={DESIGN.state.empty}>
        <EmptyState>{DESIGN.sample.empty}</EmptyState>
      </State>
      <State label={DESIGN.state.loading}>
        <EmptyState kind="loading">{REFRESH.loading}</EmptyState>
      </State>
      <State label={DESIGN.state.error}>
        <EmptyState kind="error">{REFRESH.loadFailed('HTTP 500')}</EmptyState>
      </State>
    </>
  )
}

export function NoticeStates() {
  return (
    <div className="flex flex-col gap-2">
      {TONES.map((tone) => (
        <Notice
          key={tone}
          tone={tone}
          title={
            tone === 'waiting'
              ? DESIGN.sample.waitingTitle
              : tone === 'failed'
                ? REFRESH.failed
                : tone === 'running'
                  ? DESIGN.sample.runningTitle
                  : DESIGN.sample.doneTitle
          }
        >
          {tone === 'waiting'
            ? DESIGN.sample.waitingBody
            : tone === 'failed'
              ? REFRESH.staleAt('09:24:00')
              : null}
        </Notice>
      ))}
    </div>
  )
}

/** Review findings as a findings review keeps them; data, as stored. */
const FINDINGS = {
  blocker: [
    {
      severity: 'blocker' as const,
      title: 'The cost column still prints six decimals',
      body: '',
    },
  ],
  nonBlocker: [
    {
      severity: 'non-blocker' as const,
      title: 'Name the rounding rule in the README',
      body: '',
    },
  ],
  counts: { blocker: 1, nonBlocker: 3 },
}

const LOG_PATH =
  '/Users/me/.local/state/local-agent-loop/runs/01K6D2Q7XB3M9RKT4WSTOPPD/logs/check.stdout.log'

const minutesAgo = (minutes: number) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString()

/** A run by its name, the runs of its task, and a time from `now`. */
export function LinkStates() {
  const [approval] = TASKS
  return (
    <>
      <State label={DESIGN.state.link}>
        <RunLink id={approval.id} name={approval.name} />
      </State>
      <State label={DESIGN.state.relations}>
        <TaskLineage runs={LINEAGE} current={LINEAGE[2]?.id ?? ''} now={NOW} />
      </State>
      <State label={DESIGN.state.ago}>
        <span className="text-fg-2 text-sm">
          <Ago iso={minutesAgo(3)} now={NOW} prefix={`${COMMON.started} `} />
        </span>
      </State>
    </>
  )
}

/** The running stage and its elapsed time, and the gap between stages. */
export function LiveStates() {
  const live = {
    runMs: 754_000,
    stage: 'code',
    stepName: 'stage:3:code:agent',
    stageMs: 212_000,
  }
  return (
    <>
      <State label={KIND_NAME.running}>
        <LiveProgress live={live} />
      </State>
      <State label={DESIGN.state.between}>
        <LiveProgress
          live={{ ...live, stage: null, stepName: null, stageMs: null }}
        />
      </State>
    </>
  )
}

/** Each kind of finding counted, its kept titles, and the rest counted. */
export function FindingStates() {
  return <ReviewFindingTitles findings={FINDINGS} />
}

/**
 * A path to copy, a log that could not be written, and the check logs under
 * a stop's check text: a file that is gone, and a stop that named none.
 */
export function PathStates() {
  const { copied, copy } = useCopy()
  return (
    <>
      <State label={DESIGN.state.path}>
        <PathValue
          path={LOG_PATH}
          label={COPY.stdoutPath}
          copied={copied}
          onCopy={copy}
        />
      </State>
      <State label={DESIGN.state.writeError}>
        <LogWriteError error="EACCES: permission denied, open 'check.stdout.log'" />
      </State>
      <State label={DESIGN.state.logMissing}>
        <CheckLogs
          logs={[{ kind: 'checkStdout', path: LOG_PATH, exists: false }]}
        />
      </State>
      <State label={DESIGN.state.noLog}>
        <CheckLogs logs={[]} />
      </State>
    </>
  )
}
