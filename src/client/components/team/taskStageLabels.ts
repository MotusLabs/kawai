// Display labels for the workflow stage a task row shows (team-workspace D4):
// text beside status, never color alone. The stage is the server's pure
// projection; the client only names it.
import type { TeamTaskStage } from '@shared/teamWorkspace'

const STAGE_LABELS: Record<TeamTaskStage, string> = {
  'in-review': 'In review',
  'ready-for-qa': 'Ready for QA',
  'fixes-requested': 'Fixes requested',
  'awaiting-acceptance': 'Awaiting acceptance',
  implementing: 'Implementing',
  unstarted: 'Unstarted',
}

/** A known stage's label; an unrecognized stage reads as itself. */
export const stageLabel = (stage: string): string => STAGE_LABELS[stage as TeamTaskStage] ?? stage
