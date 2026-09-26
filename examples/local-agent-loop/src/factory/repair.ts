/**
 * What a repair run changes about how a run is triggered and executed. The
 * worker, the trigger paths and the reports all read these, so the rules live
 * here rather than in any one of them.
 */

/**
 * The triage profile a run really calls, from the one it records. A repair
 * run records its parent's profile, so its settings and config version stay
 * the parent's, but it never runs triage: its answer is null. Setup's CLI
 * probe, the preflight, the triage step and the report's profile rows all
 * read this, so none of them has to remember the exception.
 */
export function triageThatRuns<T>(
  run: { repairOf?: unknown } | null | undefined,
  triage: T | null | undefined,
): T | null {
  return run?.repairOf ? null : (triage ?? null)
}

/**
 * The label every repair run carries, naming the run it repairs. A single
 * report finds its children through Durably's run labels, and the UI groups
 * the runs it has already read by it.
 */
export const REPAIR_OF_LABEL = 'repairOf'

/**
 * The labels to trigger a run input with: a repair run names its parent.
 * Every path that triggers a repair run (`demo repair`, `demo retrigger` and
 * the seed) passes these, so the parent can find it.
 */
export function repairLabels(input: unknown): Record<string, string> {
  const parent = (input as { repairOf?: { runId?: string } } | null)?.repairOf
    ?.runId
  return parent ? { [REPAIR_OF_LABEL]: parent } : {}
}
