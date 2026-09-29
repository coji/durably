/**
 * What a person does to a run, shared by the CLI and the web UI: approve or
 * reject a candidate or a blocked spec, revise a blocked spec with notes,
 * start a stopped run again with its stored input, and archive or unarchive
 * a stopped run. Both callers go through these functions, so a run acted on
 * from the page ends up exactly as one acted on from the terminal. Reading
 * files and reloading factory.json stay with the CLI.
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'

import {
  signalApproval,
  signalSpecDecision,
  type ApprovalDecision,
} from './approval.js'
import type { AgentLoopDurably } from './durably.js'
import { classifyRun } from './engine/failure-reasons.js'
import { archivable, diagnose } from './engine/status.js'
import { archiveDirOf, archiveMarkerOf } from './factory/layout.js'
import { repairLabels } from './factory/repair.js'

type Log = (line: string) => void

async function stored(durably: AgentLoopDurably, runId: string) {
  const run = await durably.getRun(runId)
  if (!run) throw new Error(`no run ${runId}`)
  return run
}

/**
 * `demo approve` / `demo reject`: decide the wait the run is suspended on,
 * bound to the candidate or the spec version its metadata names.
 */
export async function decideRun(
  durably: AgentLoopDurably,
  runId: string,
  waitId: string,
  decision: ApprovalDecision,
  log?: Log,
) {
  return signalApproval(durably, runId, waitId, decision, log)
}

/**
 * `demo spec-revise`: fix the blocked spec once more with `notes`, the
 * content the CLI reads from its notes file, on the wait the run is
 * suspended on. `signalSpecDecision` refuses it unless that is the run's own
 * pending blocked-spec wait, and refuses blank notes.
 */
export async function reviseSpec(
  durably: AgentLoopDurably,
  runId: string,
  notes: string,
  log?: Log,
) {
  const run = await stored(durably, runId)
  if (!run.waitingOnWaitId)
    throw new Error(
      `run ${runId} is not waiting for a decision on a blocked spec`,
    )
  return signalSpecDecision(
    durably,
    runId,
    run.waitingOnWaitId,
    'revise',
    notes,
    log,
  )
}

/**
 * The run, when its stop is one the failure table calls safe to repeat: a
 * fresh run resends every agent call, so an uncertain call or a possible
 * push must be checked by a person first. Both retriggers check this.
 */
export async function retriggerableRun(
  durably: AgentLoopDurably,
  runId: string,
) {
  const run = await stored(durably, runId)
  const failure = await classifyRun(durably, run)
  if (!failure?.retryable)
    throw new Error(
      `refusing to retrigger ${runId}: ${failure ? failure.reason : `it is ${run.status}, not stopped`}`,
    )
  return run
}

/**
 * `demo retrigger` without `--reload-config`: a new run with the stored
 * input. One retry per stopped run: asking again returns the run it already
 * started instead of paying for another, or pushing twice. A repair run's
 * retry names the same parent, and its setup checks the parent's candidate
 * branch again before creating anything.
 */
export async function retriggerRun(durably: AgentLoopDurably, runId: string) {
  const run = await retriggerableRun(durably, runId)
  type Input = Parameters<typeof durably.jobs.agentLoop.trigger>[0]
  const next = await durably.jobs.agentLoop.trigger(run.input as Input, {
    idempotencyKey: `retrigger-of-${runId}`,
    labels: repairLabels(run.input),
  })
  return { runId: next.id, disposition: next.disposition }
}

/**
 * `demo archive`: take a stopped run out of the runs that need a person.
 * Only a marker file under the state root is written; the run, its steps
 * and its waits stay as they are. `changed` is false when it already was.
 * Refused for any run `archivable` refuses: one still open is decided or
 * worked instead, and one that finished needs no one.
 */
export async function archiveRun(durably: AgentLoopDurably, runId: string) {
  const run = await stored(durably, runId)
  const { kind } = await diagnose(durably, run, Date.now())
  if (!archivable(kind))
    throw new Error(
      `refusing to archive ${runId}: ${
        kind === 'finished'
          ? `it finished (${(run.output as { conclusion?: string } | null)?.conclusion ?? run.status}) and needs no one; only a stopped run is archived`
          : `it is ${run.status}, not stopped${kind === 'approval' || kind === 'spec-approval' ? '; decide it with approve, reject or spec-revise instead' : ''}`
      }`,
    )
  const marker = archiveMarkerOf(durably.stateRoot, runId)
  if (existsSync(marker)) return { changed: false }
  await mkdir(archiveDirOf(durably.stateRoot), { recursive: true })
  await writeFile(
    marker,
    `${JSON.stringify({ archivedAt: new Date().toISOString() })}\n`,
  )
  return { changed: true }
}

/**
 * `demo unarchive`: remove the marker, so the run reads as before. Any
 * stored run with a marker can be brought back; looking the run up first
 * keeps an ID that is not a run's out of the marker path.
 */
export async function unarchiveRun(durably: AgentLoopDurably, runId: string) {
  await stored(durably, runId)
  const marker = archiveMarkerOf(durably.stateRoot, runId)
  if (!existsSync(marker)) return { changed: false }
  await rm(marker, { force: true })
  return { changed: true }
}

/** The IDs of every archived run; empty before anything was archived. */
export function archivedRunIds(stateRoot: string): Set<string> {
  try {
    return new Set(readdirSync(archiveDirOf(stateRoot)))
  } catch {
    return new Set()
  }
}
