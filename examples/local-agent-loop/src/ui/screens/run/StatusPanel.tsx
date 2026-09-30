import type { Act } from '../../components/ActionNotice'
import { CheckLogs } from '../../components/CheckLogs'
import { CopyAnnouncer, CopyButton, useCopy } from '../../components/copy'
import { Field } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import { LiveProgress } from '../../components/LiveProgress'
import { LogWriteError, PathValue } from '../../components/PathValue'
import { RunActions } from '../../components/RunActions'
import { CleanupCommand, WorktreeNote } from '../../components/WorktreeNote'
import { COPY, DETAIL } from '../../glossary'
import {
  checkNamesLogs,
  detailField,
  diagnosisText,
  humanCheckText,
  INTERRUPTED_CHECK_TEXT,
  isPathDetail,
  retryLabel,
} from '../../labels'
import type { RunDetailResponse } from '../../server'
import { SummaryPanel } from './SummaryPanel'

/**
 * Failure detail lines with a stable key each. An exit code line repeats
 * when several attempts exited the same way, so its occurrence is counted.
 */
function detailRows(lines: string[]): { line: string; key: string }[] {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const n = (seen.get(line) ?? 0) + 1
    seen.set(line, n)
    return { line, key: `${line}#${n}` }
  })
}

type Failure = NonNullable<RunDetailResponse['diagnosis']['failure']>

function FailureFields({
  failure,
  pathsShown,
}: {
  failure: Failure
  /** The log paths are already shown under the check text. */
  pathsShown: boolean
}) {
  const { copied, copy } = useCopy()
  const lines = pathsShown
    ? failure.details.filter((line) => !isPathDetail(line))
    : failure.details
  return (
    <>
      <dl className="mb-3 flex flex-col gap-2">
        {detailRows(lines).map(({ line, key }) => {
          const d = detailField(line)
          return (
            <Field key={key} label={d.label}>
              {isPathDetail(line) ? (
                <PathValue
                  path={d.value}
                  label={COPY.path(d.label)}
                  copied={copied}
                  onCopy={copy}
                />
              ) : d.note ? (
                <LogWriteError error={d.value} />
              ) : (
                <span
                  title={d.title}
                  className={
                    d.value === INTERRUPTED_CHECK_TEXT ? 'font-ui' : undefined
                  }
                >
                  {d.value}
                </span>
              )}
            </Field>
          )
        })}
      </dl>
      <CopyAnnouncer copied={copied} />
    </>
  )
}

/**
 * What the run came to and what a person does next, with the actions it
 * allows and their CLI commands, then its time and cost. A stop's check
 * comes first; its recorded details stay closed.
 */
export function StatusPanel({
  data,
  act,
}: {
  data: RunDetailResponse
  act: Act
}) {
  const failure = data.diagnosis.failure
  const next = data.diagnosis.next
  const delivery = data.report.delivery
  const logsHere = failure ? checkNamesLogs(failure.kind, failure) : false
  const { copied, copy } = useCopy()
  return (
    <Panel title={DETAIL.conclusion}>
      <div className="flex flex-col gap-3">
        {data.diagnosis.kind === 'finished' && delivery?.branch ? (
          // The badge says how it ended; the sentence says where the work is.
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span>{DETAIL.deliveredTo}</span>
            <code className="font-code break-all">{delivery.branch}</code>
            <CopyButton
              text={delivery.branch}
              label={COPY.branch}
              copied={copied}
              onCopy={copy}
            />
            <CopyAnnouncer copied={copied} />
          </div>
        ) : data.diagnosis.kind === 'finished' ? null : (
          <p className="text-sm">
            {diagnosisText(data.diagnosis, data.uncertainCall)}
          </p>
        )}
        {data.diagnosis.kind === 'running' ? (
          <LiveProgress live={data.live} />
        ) : null}
        <WorktreeNote
          worktree={data.report.worktree}
          archived={data.archived}
        />
        {failure ? (
          <dl className="flex flex-col gap-2">
            <Field label={DETAIL.humanCheck}>
              <span className="font-ui">
                {humanCheckText(failure.kind, failure)}
              </span>
            </Field>
            {logsHere ? (
              <div className="flex flex-col gap-1">
                <dt className="text-fg-2 text-xs">{DETAIL.checkLogs}</dt>
                <dd>
                  <CheckLogs logs={data.checkLogs} />
                </dd>
              </div>
            ) : null}
            <Field label={DETAIL.retry}>
              <span className="font-ui">{retryLabel(failure.retryable)}</span>
            </Field>
          </dl>
        ) : null}
        {next.length > 0 || data.archiveCommand ? (
          <RunActions
            run={{
              ...data,
              id: data.report.runId,
              reviewHighlights: data.report.reviewHighlights,
            }}
            act={act}
            lead
          />
        ) : (
          <p className="text-fg-2 text-sm">{DETAIL.noNext}</p>
        )}
        {failure &&
        failure.details.some((line) => !logsHere || !isPathDetail(line)) ? (
          <details className="text-sm">
            <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center text-xs">
              {DETAIL.stopRecord}
            </summary>
            <div className="mt-2">
              <FailureFields failure={failure} pathsShown={logsHere} />
            </div>
          </details>
        ) : null}
        <CleanupCommand cleanup={data.diagnosis.cleanup} />
        <div className="border-line border-t pt-3">
          <SummaryPanel report={data.report} />
        </div>
      </div>
    </Panel>
  )
}
