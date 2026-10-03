import type { LoopReport } from '../../../engine/report'
import { EmptyState } from '../../components/EmptyState'
import { Field } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import { COMMON, REVIEW, SPEC } from '../../glossary'
import { ReviewVerdicts } from './ReviewsPanel'

type Spec = NonNullable<LoopReport['spec']>

/** An input spec, or one a round confirmed; otherwise the latest draft. */
function isConfirmed(spec: Spec | null): spec is Spec {
  return spec !== null && (spec.source === 'input' || spec.round !== null)
}

/** How the spec the run went on with was confirmed. */
function specConfirmedLabel(spec: Spec): string {
  return spec.source === 'input' || spec.round === null
    ? SPEC.fromInput
    : SPEC.confirmedAt(spec.round)
}

/** How the spec was confirmed, or that it is not yet. */
function SpecStatus({ spec, rounds }: { spec: Spec | null; rounds: number }) {
  if (isConfirmed(spec))
    return (
      <dl className="flex flex-col gap-2">
        <Field label={SPEC.confirmed}>
          <span className="font-ui">{specConfirmedLabel(spec)}</span>
        </Field>
        {spec.blocked ? (
          <Field label={SPEC.human}>
            <span className="font-ui">{SPEC.humanApproved}</span>
          </Field>
        ) : null}
      </dl>
    )
  return rounds > 0 ? <EmptyState>{SPEC.notConfirmed}</EmptyState> : null
}

/** The advice handed to the implementer; nothing when there is none. */
function SpecAdvice({ advice }: { advice: Spec['advice'] }) {
  if (advice.length === 0) return null
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="font-medium">{SPEC.advice}</p>
      <ul className="text-fg-2 flex list-disc flex-col gap-1 pl-4">
        {advice.map((f, at) => (
          // The stored list never changes order.
          <li key={`${f.severity}:${at}`}>
            {f.severity === 'blocker' ? REVIEW.blockerPrefix : ''}
            {f.title}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The spec text, labelled confirmed or as the latest draft. */
function SpecText({ spec }: { spec: Spec }) {
  if (spec.content === null) return null
  return (
    <details>
      <summary className="cursor-pointer text-sm">
        {isConfirmed(spec) ? SPEC.open : SPEC.openDraft}
      </summary>
      <pre className="bg-sunken font-code mt-2 max-h-96 overflow-auto rounded-md px-3 py-2 text-xs whitespace-pre-wrap">
        {spec.content}
      </pre>
    </details>
  )
}

/**
 * The spec stages: the spec the run went on with, the advice handed to the
 * implementer, the check chosen from the spec, and every spec review round.
 * Shown only on a run that has them.
 */
export function SpecPanel({ report: r }: { report: LoopReport }) {
  const spec = r.spec
  if (!spec && r.specRounds.length === 0) return null
  return (
    <Panel title={SPEC.heading}>
      <div className="flex flex-col gap-4">
        <SpecStatus spec={spec} rounds={r.specRounds.length} />
        {spec?.check ? (
          <dl className="flex flex-col gap-2">
            <Field label={SPEC.check}>{spec.check.command.join(' ')}</Field>
            <Field label={SPEC.checkNotes}>
              <span className="font-ui">{spec.check.notes ?? COMMON.none}</span>
            </Field>
          </dl>
        ) : null}
        {spec ? <SpecAdvice advice={spec.advice} /> : null}
        {spec ? <SpecText spec={spec} /> : null}
        {r.specRounds.length > 0 ? (
          <ol className="flex flex-col gap-6">
            {r.specRounds.map((round) => (
              <li key={round.round} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">
                  {SPEC.round(round.round)}
                </h3>
                <ReviewVerdicts reviews={round.reviews} />
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </Panel>
  )
}
