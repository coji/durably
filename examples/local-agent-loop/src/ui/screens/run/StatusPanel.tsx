import { Commands } from '../../components/Commands'
import { CopyAnnouncer, CopyButton, useCopy } from '../../components/copy'
import { Field } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import { LiveProgress } from '../../components/LiveProgress'
import { LogWriteError, PathValue } from '../../components/PathValue'
import { COPY, DETAIL } from '../../glossary'
import {
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

function FailureFields({ failure }: { failure: Failure }) {
  const { copied, copy } = useCopy()
  return (
    <>
      <dl className="mb-3 flex flex-col gap-2">
        {detailRows(failure.details).map(({ line, key }) => {
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
 * What the run came to and what a person does next, then its time and cost.
 * A stop's check comes first; its recorded details stay closed.
 */
export function StatusPanel({ data }: { data: RunDetailResponse }) {
  const failure = data.diagnosis.failure
  const next = data.diagnosis.next
  const delivery = data.report.delivery
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
        {failure ? (
          <dl className="flex flex-col gap-2">
            <Field label={DETAIL.humanCheck}>
              <span className="font-ui">
                {humanCheckText(failure.kind, failure)}
              </span>
            </Field>
            <Field label={DETAIL.retry}>
              <span className="font-ui">{retryLabel(failure.retryable)}</span>
            </Field>
          </dl>
        ) : null}
        {next.length > 0 ? (
          <Commands lines={next} />
        ) : (
          <p className="text-fg-2 text-sm">{DETAIL.noNext}</p>
        )}
        {failure && failure.details.length > 0 ? (
          <details className="text-sm">
            <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center text-xs">
              {DETAIL.stopRecord}
            </summary>
            <div className="mt-2">
              <FailureFields failure={failure} />
            </div>
          </details>
        ) : null}
        {data.diagnosis.cleanup ? (
          <div>
            <p className="text-fg-2 mb-2 text-xs">{COPY.cleanupNote}</p>
            <Commands lines={[data.diagnosis.cleanup]} />
          </div>
        ) : null}
        <div className="border-line border-t pt-3">
          <SummaryPanel report={data.report} />
        </div>
      </div>
    </Panel>
  )
}
