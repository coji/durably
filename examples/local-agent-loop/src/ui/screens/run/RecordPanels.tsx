import { formatCount } from '../../../engine/format'
import type { LoopReport, ReportCandidateChanges } from '../../../engine/report'
import { CopyAnnouncer, useCopy } from '../../components/copy'
import { EmptyState } from '../../components/EmptyState'
import { Field } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import { PathValue } from '../../components/PathValue'
import { IdSuffix } from '../../components/RunLink'
import { COMMON, INPUT_NAME, RECORD, REVIEW } from '../../glossary'
import { squashedBranchField } from '../../labels'

/** A candidate's size as the report recorded it at sealing. */
function changesText(c: ReportCandidateChanges): string {
  return RECORD.changesText(
    formatCount(c.files),
    formatCount(c.additions),
    formatCount(c.deletions),
  )
}

/** Every sealed candidate with its recorded size, oldest first. */
function CandidateList({ report: r }: { report: LoopReport }) {
  if (r.candidates.length === 0) return null
  return (
    <ol className="border-line mt-3 flex flex-col gap-2 border-t pt-3">
      {r.candidates.map((c) => (
        <li
          key={c.sequence}
          className="flex flex-wrap items-baseline gap-x-2 text-sm"
        >
          <span>{REVIEW.candidateOf(c.iteration)}</span>
          <IdSuffix id={c.id} />
          <span className="text-fg-2 tabular-nums">
            {c.changes ? changesText(c.changes) : RECORD.changesMissing}
          </span>
        </li>
      ))}
    </ol>
  )
}

function CandidatePanel({ report: r }: { report: LoopReport }) {
  return (
    <Panel title={RECORD.candidate}>
      {r.candidate ? (
        <dl className="flex flex-col gap-2">
          <Field label={RECORD.id}>{r.candidate.id}</Field>
          <Field label={RECORD.branch}>
            {r.candidate.branch ?? COMMON.none}
          </Field>
          <Field label={RECORD.commit}>
            {r.candidate.commit ?? COMMON.none}
          </Field>
          {r.candidate.changes ? (
            <Field label={RECORD.changes}>
              {changesText(r.candidate.changes)}
            </Field>
          ) : null}
        </dl>
      ) : (
        <EmptyState>{RECORD.candidateEmpty}</EmptyState>
      )}
      <CandidateList report={r} />
    </Panel>
  )
}

function DeliveryPanel({ report: r }: { report: LoopReport }) {
  const { copied, copy } = useCopy()
  const squashed = squashedBranchField(r.delivery ?? {})
  return (
    <Panel title={RECORD.delivery}>
      <CopyAnnouncer copied={copied} />
      {r.delivery ? (
        <dl className="flex flex-col gap-2">
          <Field label={RECORD.kind}>{r.delivery.kind}</Field>
          <Field label={RECORD.location}>{r.delivery.location}</Field>
          <Field label={RECORD.branch}>
            {r.delivery.branch ?? COMMON.none}
          </Field>
          <Field label={RECORD.commit}>
            {r.delivery.commit ?? COMMON.none}
          </Field>
          <Field label={squashed.label}>
            {squashed.value ? (
              <PathValue
                path={squashed.value}
                label={squashed.copyLabel}
                copied={copied}
                onCopy={copy}
              />
            ) : (
              COMMON.none
            )}
          </Field>
          <Field label={RECORD.summary}>
            <span className="font-ui">{r.delivery.summary}</span>
          </Field>
        </dl>
      ) : (
        <EmptyState>{RECORD.deliveryEmpty}</EmptyState>
      )}
    </Panel>
  )
}

/** The candidate, the delivery, the stored inputs and the report's notes. */
export function RecordPanels({ report: r }: { report: LoopReport }) {
  const inputs = r.inputs.findings
    ? (['task', 'spec', 'dispositions', 'findings'] as const)
    : (['task', 'spec', 'dispositions'] as const)
  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <CandidatePanel report={r} />
        <DeliveryPanel report={r} />
      </div>

      <Panel title={RECORD.inputs}>
        <p className="text-fg-2 mb-3 text-xs">{RECORD.inputsNote}</p>
        <dl className="flex flex-col gap-2">
          {inputs.map((name) => {
            const file = r.inputs[name]
            return (
              <Field key={name} label={INPUT_NAME[name]}>
                {file ? `${file.sha256}  ${file.path}` : RECORD.notGiven}
              </Field>
            )
          })}
        </dl>
      </Panel>

      {r.notes.length > 0 ? (
        <Panel title={RECORD.notes}>
          <ul className="text-fg-2 flex list-disc flex-col gap-1 pl-4 text-sm">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  )
}
