// review-p0 alerts (review-findings-ledger D10): when a round's counted
// review accepts a P0 finding, the plan's Lead role gets one message per
// finding, tagged `review-p0`, through the stop-alert path: the mail and
// its `plan_stall_alerts` row (kind `review-p0`, episode key
// `<roundId>:<findingId>`) commit together, so a replayed tick finds the
// row and sends nothing. Without a Lead role the row is kept and a plan
// event the owner sees records it instead. The alert never changes the
// round or the fix attempt.
import type { Database } from 'bun:sqlite'
import type { LedgerItem } from '../../../shared/findingsLedger'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { ExecutionStore } from '../execution/executionStore'
import type { PlanStore } from '../planStore'
import { REVIEW_P0_KIND, StallAlertStore } from './stallAlertStore'
import { planLead } from './stallAlerts'

export const REVIEW_P0_TAG = 'review-p0'

export interface ReviewAlertDeps {
  db: Database
  mail: Pick<MailboxStore, 'enqueue'>
  plans: Pick<PlanStore, 'forTeam' | 'revision' | 'insertEvent'>
  executions: Pick<ExecutionStore, 'execution'>
}

const cut = (text: string | null, max = 1_000) => (text === null ? '(none)' : text.length > max ? `${text.slice(0, max)}…` : text)

/** The accepted P0 findings a submission's items raise (an unsupported P0 never alerts). */
export function acceptedP0(items: readonly LedgerItem[]): LedgerItem[] {
  return items.filter(item => item.itemKind === 'finding' && item.level === 'P0' && item.class === 'accepted')
}

/** Raise one alert per accepted P0 of the round's counted review; returns how many were raised now. */
export function raiseReviewP0Alerts(deps: ReviewAlertDeps, team: TeamIdentity, change: { executionId: string; change: string; taskId: string },
  round: { id: string; number: number }, items: readonly LedgerItem[]): number {
  const p0 = acceptedP0(items)
  if (p0.length === 0) return 0
  const execution = deps.executions.execution(change.executionId)
  if (execution === null) return 0
  const plan = deps.plans.forTeam(team.teamId, execution.planId)
  if (plan === null) return 0
  const { lead, role } = planLead(deps.plans.revision(execution.planId, execution.revision)?.content)
  const alerts = new StallAlertStore(deps.db)
  let raised = 0
  for (const item of p0) {
    const episodeKey = `${round.id}:${item.findingId}`
    if (alerts.episode(team.teamId, change.executionId, change.change, REVIEW_P0_KIND, episodeKey) !== null) continue
    const body = [
      `Kawai: the review of change ${change.change} of plan "${plan.title}" (${plan.id}) accepted ${item.findingId} at P0 (round ${round.number}, task ${change.taskId}).`,
      `Clause: ${item.clause ?? '(none)'}`,
      `Evidence: ${cut(item.evidence)}`,
      ...(item.reproduction ? [`Reproduction: ${cut(item.reproduction)}`] : []),
      '',
      'The round failed and the fix attempt goes out as usual; this alert changes neither. Read the finding with task_get. Replies to this message are refused: act instead.',
    ].join('\n')
    deps.db.transaction(() => {
      const message = lead === null ? null : deps.mail.enqueue({
        teamId: team.teamId, toKind: 'group', toId: lead, fromKind: 'system', fromSession: null, fromGroup: null, originPath: team.groupsRoot,
        tags: [REVIEW_P0_TAG], body, taskId: null, actor: 'system',
        ...(role?.profiles.length ? { allowedProfiles: role.profiles } : {}),
      })
      const outcome = alerts.insert({
        teamId: team.teamId, planId: execution.planId, executionId: change.executionId, change: change.change, kind: REVIEW_P0_KIND, episodeKey,
        detail: { roundId: round.id, findingId: item.findingId, clause: item.clause, evidence: cut(item.evidence) }, messageId: message?.id ?? null,
      })
      // Another writer recorded it first: roll this mail back.
      if (!outcome.inserted) throw new Error(`Alert ${episodeKey} was recorded meanwhile.`)
      if (lead === null) {
        deps.plans.insertEvent(execution.planId, {
          kind: 'review-p0', revision: execution.revision, actor: { kind: 'system', sessionId: null }, reason: body,
          payload: { change: change.change, roundId: round.id, findingId: item.findingId, clause: item.clause, evidence: cut(item.evidence) },
        })
      }
    })()
    raised++
  }
  return raised
}
