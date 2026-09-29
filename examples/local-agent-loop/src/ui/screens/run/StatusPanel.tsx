import { Commands } from '../../components/Commands'
import { CopyAnnouncer, useCopy } from '../../components/copy'
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
        <Field label={DETAIL.retry}>{retryLabel(failure.retryable)}</Field>
        <Field label={DETAIL.humanCheck}>
          <span className="font-ui">
            {humanCheckText(failure.kind, failure)}
          </span>
        </Field>
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

export function StatusPanel({ data }: { data: RunDetailResponse }) {
  return (
    <Panel title={DETAIL.status}>
      <p className="mb-3 text-sm">
        {diagnosisText(data.diagnosis, data.uncertainCall)}
      </p>
      {data.diagnosis.kind === 'running' ? (
        <div className="mb-3">
          <LiveProgress live={data.live} />
        </div>
      ) : null}
      {data.diagnosis.failure ? (
        <FailureFields failure={data.diagnosis.failure} />
      ) : null}
      <Commands lines={data.diagnosis.next} />
      {data.diagnosis.cleanup ? (
        <div className="mt-3">
          <p className="text-fg-2 mb-2 text-xs">{COPY.cleanupNote}</p>
          <Commands lines={[data.diagnosis.cleanup]} />
        </div>
      ) : null}
    </Panel>
  )
}
