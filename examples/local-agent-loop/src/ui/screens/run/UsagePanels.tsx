import { formatCost, formatCount, formatTokens } from '../../../engine/format'
import type { LoopReport, UsageTotals } from '../../../engine/report'
import { DataTable, Td, Th } from '../../components/DataTable'
import { EmptyState } from '../../components/EmptyState'
import { PartialTag } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import { COLUMN, COMMON, DETAIL } from '../../glossary'
import { roleName, stageName } from '../../labels'

const TOKEN_KEYS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'totalTokens',
] as const

/** Token counts, marked when only some calls reported usage. */
function UsageCells({ u }: { u: UsageTotals }) {
  return (
    <>
      <Td num>{formatCount(u.invocations)}</Td>
      {TOKEN_KEYS.map((key) => (
        <Td key={key} num>
          {formatTokens(u[key])}
          {u[key] == null || u.complete ? null : (
            <PartialTag title={COMMON.partialUsage} />
          )}
        </Td>
      ))}
      <Td num>{formatCost(u.costUsd)}</Td>
    </>
  )
}

const USAGE_HEAD = (
  <>
    <Th num>{COLUMN.invocations}</Th>
    <Th num>{COLUMN.input}</Th>
    <Th num>{COLUMN.cacheRead}</Th>
    <Th num>{COLUMN.cacheWrite}</Th>
    <Th num>{COLUMN.output}</Th>
    <Th num>{COLUMN.totalTokens}</Th>
    <Th num>{COLUMN.cost}</Th>
  </>
)

export function UsagePanels({ report: r }: { report: LoopReport }) {
  return (
    <>
      <Panel title={DETAIL.stageUsage}>
        {r.stageUsage.length === 0 ? (
          <EmptyState>{DETAIL.stageUsageEmpty}</EmptyState>
        ) : (
          <DataTable
            head={
              <>
                <Th>{COLUMN.stage}</Th>
                {USAGE_HEAD}
              </>
            }
          >
            {r.stageUsage.map((u) => (
              <tr key={u.stage}>
                <Td>{stageName(u.stage)}</Td>
                <UsageCells u={u} />
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>

      <Panel title={DETAIL.roleUsage}>
        <DataTable
          head={
            <>
              <Th>{COLUMN.role}</Th>
              <Th>{COLUMN.roleProfile}</Th>
              {USAGE_HEAD}
            </>
          }
        >
          {r.roleUsage.map((u) => (
            <tr key={u.role}>
              <Td>{roleName(u.role)}</Td>
              <Td>
                <span className="font-code text-xs">
                  {u.provider ?? COMMON.unknown} /{' '}
                  {u.requestedModel ?? COMMON.defaultSetting} /{' '}
                  {u.requestedEffort ?? COMMON.defaultSetting}
                </span>
              </Td>
              <UsageCells u={u} />
            </tr>
          ))}
        </DataTable>
        <p className="text-fg-2 mt-3 text-xs">
          {COMMON.costNote}
          {DETAIL.usageNote}
        </p>
      </Panel>
    </>
  )
}
