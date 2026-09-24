/**
 * Japanese names for the stored stage, role, lens and triage identifiers,
 * shared by the server's screen-reader sentences and the page. Unknown
 * identifiers pass through unchanged.
 */

const STAGE_NAME: Record<string, string> = {
  setup: '準備',
  triage: '見立て',
  policy: '判断',
  code: '実装',
  verify: '検証',
  review: 'レビュー',
  approve: '承認',
  finish: '完了',
  stop: '停止',
}

export function stageName(stage: string): string {
  return STAGE_NAME[stage] ?? stage
}

const LENS_NAME: Record<string, string> = {
  correctness: '正しさのレビュー',
  'edge-cases': '境界条件のレビュー',
}

/** A review lens, such as `correctness`, as a review's name. */
export function lensName(lens: string): string {
  return LENS_NAME[lens] ?? lens
}

/** A usage role: `code`, `triage`, or a review lens. */
export function roleName(role: string): string {
  return LENS_NAME[role] ?? STAGE_NAME[role] ?? role
}

const TRIAGE_NAME: Record<string, string> = {
  routine: '定型',
  probe: '試行が必要',
  unknown: '不明',
}

export function triageName(judgment: string): string {
  return TRIAGE_NAME[judgment] ?? judgment
}

const STEP_PART_NAME: Record<string, string> = {
  agent: 'エージェント',
  candidate: '候補の記録',
}

/** The last part of a step name inside a stage, such as `agent`. */
export function stepPartName(part: string): string {
  return STEP_PART_NAME[part] ?? part
}
