import type { Comparison } from '../../../engine/compare'
import {
  formatCost,
  formatCount,
  formatDuration,
  formatTokens,
} from '../../../engine/format'
import { DataTable, Td, Th } from '../../components/DataTable'
import { Panel } from '../../components/Layout'
import { conclusionStatus } from '../../components/status'
import {
  CALIBRATION_KEYS,
  CALIBRATION_NAME,
  COLUMN,
  COMMON,
  COMPARE,
} from '../../glossary'
import { runKindName, stageName, stopName, triageName } from '../../labels'
import { CalibrationStat, STAT_HEAD, StatRow, statRange } from './StatTable'

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
    COMPARE.runs(g.runs),
    COMPARE.successes(g.successes),
    COMPARE.successRate((g.successRate * 100).toFixed(0)),
    ...Object.entries(g.conclusions).map(
      ([c, n]) => `${conclusionStatus(c).label} ${n}`,
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
          <Td num>{st.workMs.unknown}</Td>
          <Td num>{st.costUsd.unknown}</Td>
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
            <Td num>{t.runs}</Td>
            <Td num>{t.approved}</Td>
            <Td num>{t.verificationFailed}</Td>
            <Td num>{t.reviewCapReached}</Td>
            <Td num>{formatCount(t.repairs.median)}</Td>
            <Td num>{formatCost(t.costUsd.median)}</Td>
            <Td num>{t.judgment === 'routine' ? t.routineNeedingMore : '–'}</Td>
            <Td>
              {Object.entries(t.stops)
                .map(([kind, n]) => `${stopName(kind)} ${n}`)
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
                <CalibrationStat stat={t.calibration[key]} f={formatCount} />
              </Td>
            ))}
          </tr>
        ))}
      </DataTable>
    </>
  )
}

/** One config group: its outcome line, its statistics, its stages, triage. */
export function GroupPanel({ group: g }: { group: Group }) {
  return (
    <Panel title={groupTitle(g)}>
      <p className="mb-3 text-sm">{groupLine(g)}</p>
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
    </Panel>
  )
}
