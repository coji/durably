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
  isSpecWait,
  signalApproval,
  signalSpecDecision,
  type ApprovalDecision,
} from './approval.js'
import type { AgentLoopDurably } from './durably.js'
import { classifyRun } from './engine/failure-reasons.js'
import { TERMINAL_STATUSES } from './engine/terminal.js'
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
 * content the CLI reads from its notes file. Refused unless the run waits
 * on its own pending blocked-spec wait, and for blank notes.
 */
export async function reviseSpec(
  durably: AgentLoopDurably,
  runId: string,
  notes: string,
  log?: Log,
) {
  const run = await stored(durably, runId)
  const wait = (await durably.getWaits(runId)).find(
    (w) =>
      w.id === run.waitingOnWaitId &&
      w.status === 'pending' &&
      isSpecWait(w.metadata),
  )
  if (!wait)
    throw new Error(
      `run ${runId} is not waiting for a decision on a blocked spec`,
    )
  return signalSpecDecision(durably, runId, wait.id, 'revise', notes, log)
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

/** A run that has stopped for good; only such a run is archived. */
async function stoppedRun(
  durably: AgentLoopDurably,
  runId: string,
  verb: string,
) {
  const run = await stored(durably, runId)
  if (!TERMINAL_STATUSES.includes(run.status))
    throw new Error(
      `refusing to ${verb} ${runId}: it is ${run.status}, not stopped${run.status === 'waiting' ? '; decide it with approve, reject or spec-revise instead' : ''}`,
    )
  return run
}

/**
 * `demo archive`: take a stopped run out of the runs that need a person.
 * Only a marker file under the state root is written; the run, its steps
 * and its waits stay as they are. `changed` is false when it already was.
 */
export async function archiveRun(durably: AgentLoopDurably, runId: string) {
  await stoppedRun(durably, runId, 'archive')
  const marker = archiveMarkerOf(durably.stateRoot, runId)
  if (existsSync(marker)) return { changed: false }
  await mkdir(archiveDirOf(durably.stateRoot), { recursive: true })
  await writeFile(
    marker,
    `${JSON.stringify({ archivedAt: new Date().toISOString() })}\n`,
  )
  return { changed: true }
}

/** `demo unarchive`: remove the marker, so the run reads as before. */
export async function unarchiveRun(durably: AgentLoopDurably, runId: string) {
  await stoppedRun(durably, runId, 'unarchive')
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
