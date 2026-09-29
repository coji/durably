import type { Comparison } from '../../../engine/compare'
import {
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
} from '../../../engine/format'
import { DataTable, Td, Th } from '../../components/DataTable'
import { Collapsible } from '../../components/Layout'
import { conclusionStatus } from '../../components/status'
import {
  CALIBRATION_KEYS,
  CALIBRATION_NAME,
  COLUMN,
  COMMON,
  COMPARE,
  TREND,
} from '../../glossary'
import { runKindName, stageName, stopName, triageName } from '../../labels'
import { MedianCell, STAT_HEAD, StatRow, statRange } from './StatTable'

type Group = Comparison['groups'][number]

function groupTitle(g: Group): string {
  return [
    g.kind === 'repair' ? runKindName(g.kind) : null,
    g.label,
    COMPARE.config(g.configVersion),
  ]
    .filter(Boolean)
    .join(COMMON.separator)
}

function groupLine(g: Group): string {
  return [
    COMPARE.runs(formatCount(g.runs)),
    COMPARE.successes(formatCount(g.successes)),
    COMPARE.successRate(formatPercent(g.successRate)),
    ...Object.entries(g.conclusions).map(
      ([c, n]) => `${conclusionStatus(c).label} ${formatCount(n)}`,
    ),
  ].join(COMMON.separator)
}

function StageTable({ stages }: { stages: Group['stages'] }) {
  return (
    <DataTable
      head={
        <>
          <Th>{COLUMN.stage}</Th>
          <Th num>{COMPARE.stageWork}</Th>
          <Th num>{COMPARE.stageCost}</Th>
          <Th num>{COMPARE.stageWorkUnknown}</Th>
          <Th num>{COMPARE.stageCostUnknown}</Th>
        </>
      }
    >
      {stages.map((st) => (
        <tr key={st.stage}>
          <Td>{stageName(st.stage)}</Td>
          <Td num>{statRange(st.workMs, formatDuration)}</Td>
          <Td num>{statRange(st.costUsd, formatCost)}</Td>
          <Td num>{formatCount(st.workMs.unknown)}</Td>
          <Td num>{formatCount(st.costUsd.unknown)}</Td>
        </tr>
      ))}
    </DataTable>
  )
}

function TriageTables({ triage }: { triage: Group['triage'] }) {
  return (
    <>
      <p className="text-fg-2 mb-2 text-xs">{COMPARE.triageNote}</p>
      <DataTable
        head={
          <>
            <Th>{COLUMN.judgment}</Th>
            <Th num>{COLUMN.runs}</Th>
            <Th num>{COMPARE.approved}</Th>
            <Th num>{COMPARE.verificationFailed}</Th>
            <Th num>{COMPARE.reviewCapReached}</Th>
            <Th num>{COMPARE.repairsMedian}</Th>
            <Th num>{COMPARE.costMedian}</Th>
            <Th num>{COMPARE.routineNeedingMore}</Th>
            <Th>{COMPARE.stops}</Th>
          </>
        }
      >
        {triage.map((t) => (
          <tr key={t.judgment}>
            <Td>{triageName(t.judgment)}</Td>
            <Td num>{formatCount(t.runs)}</Td>
            <Td num>{formatCount(t.approved)}</Td>
            <Td num>{formatCount(t.verificationFailed)}</Td>
            <Td num>{formatCount(t.reviewCapReached)}</Td>
            <Td num>{formatCount(t.repairs.median)}</Td>
            <Td num>{formatCost(t.costUsd.median)}</Td>
            <Td num>
              {t.judgment === 'routine'
                ? formatCount(t.routineNeedingMore)
                : TREND.noRuns}
            </Td>
            <Td>
              {Object.entries(t.stops)
                .map(([kind, n]) => `${stopName(kind)} ${formatCount(n)}`)
                .join(COMMON.separator) || COMMON.none}
            </Td>
          </tr>
        ))}
      </DataTable>
      <p className="text-fg-2 mt-4 mb-2 text-xs">{COMPARE.calibrationNote}</p>
      <DataTable
        head={
          <>
            <Th>{COLUMN.judgment}</Th>
            {CALIBRATION_KEYS.map((key) => (
              <Th key={key} num>
                {CALIBRATION_NAME[key]}
              </Th>
            ))}
          </>
        }
      >
        {triage.map((t) => (
          <tr key={t.judgment}>
            <Td>{triageName(t.judgment)}</Td>
            {CALIBRATION_KEYS.map((key) => (
              <Td key={key} num>
                <MedianCell stat={t.calibration[key]} f={formatCount} />
              </Td>
            ))}
          </tr>
        ))}
      </DataTable>
    </>
  )
}

/**
 * One config group, closed to its title and outcome line; open, its
 * statistics, its stages and its triage.
 */
export function GroupPanel({ group: g }: { group: Group }) {
  return (
    <Collapsible title={groupTitle(g)} note={groupLine(g)}>
      <DataTable head={STAT_HEAD}>
        <StatRow
          label={COMPARE.leadTime}
          stat={g.leadTimeMs}
          f={formatDuration}
        />
        <StatRow label={COMPARE.workTime} stat={g.workMs} f={formatDuration} />
        <StatRow
          label={COMPARE.humanWait}
          stat={g.humanWaitMs}
          f={formatDuration}
        />
        <StatRow
          label={COMPARE.totalTokens}
          stat={g.totalTokens}
          f={formatTokens}
        />
        <StatRow label={COMPARE.cost} stat={g.costUsd} f={formatCost} />
        <StatRow
          label={COMPARE.costPerSuccess}
          stat={g.costPerSuccessUsd}
          f={formatCost}
        />
        <StatRow label={COMPARE.repairs} stat={g.repairs} f={formatCount} />
      </DataTable>
      {g.stages.length > 0 ? (
        <div className="mt-4">
          <StageTable stages={g.stages} />
        </div>
      ) : null}
      {g.triage.length > 0 ? (
        <div className="mt-4">
          <TriageTables triage={g.triage} />
        </div>
      ) : null}
    </Collapsible>
  )
}
