// Stop alerts: a change that stops needs the owner's Retry, and the sweep's
// stall alerts never see it, so without this the plan's Lead role learns of a
// stop only by looking. Each stop of a running execution sends one message —
// `from_kind: 'system'`, to the Lead role group with that role's
// `allowed_profiles` and no task, tagged `plan-stop` and `stop:<reason>` — in
// one transaction with its `plan_stall_alerts` row, whose episode key is the
// change's generation: a restart finds the row, and a Retry bumps the
// generation, so stopping again alerts again. A finished execution cannot be
// retried (the owner's Stop finishes it), so its stops raise nothing. Without
// a Lead role the row has a null message and the stop stays the owner's
// attention item. Replies meet Kawai's reply guard in `TeamMailbox`.
import type { Database } from 'bun:sqlite'
import { blockedDependents } from '../../../shared/planReport'
import { stopReasonLabel, type ChangeSupervision, type SupervisionInput } from '../../../shared/planSupervision'
import type { StopDetail } from '../../../shared/planExecution'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { ExecutionStore } from '../execution/executionStore'
import type { PlanStore } from '../planStore'
import type { DerivedPlan } from './SupervisionMonitor'
import { STOP_ALERT_KIND, type StallAlertStore } from './stallAlertStore'
import { planLead, roundLines } from './stallAlerts'

export interface StopAlertDeps {
  db: Database
  mail: Pick<MailboxStore, 'enqueue'>
  alerts: Pick<StallAlertStore, 'episode' | 'insert'>
  plans: Pick<PlanStore, 'forTeam' | 'revision'>
  executions: Pick<ExecutionStore, 'execution' | 'change'>
}

export const STOP_TAG = 'plan-stop'

/** Enough of a command's error to act on; plan detail keeps the whole of it. */
const DETAIL_LIMIT = 2000

function detailLines(detail: StopDetail | null): string[] {
  if (detail === null) return []
  const text = detail.message ?? detail.refusal
  return [
    ...(detail.effect ? [`Step: ${detail.effect}.`] : []),
    ...(text ? [`Detail: ${text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text}`] : []),
    ...(detail.checks?.length ? [`Checks: ${detail.checks.join(', ')}.`] : []),
    ...(detail.names?.length ? [`Names: ${detail.names.join(', ')}.`] : []),
  ]
}

export function stopBody(plan: { id: string; title: string }, change: ChangeSupervision, input: SupervisionInput, reason: string, detail: StopDetail | null, blocked: string[]): string {
  return [
    `Kawai: change ${change.change} of plan "${plan.title}" (${plan.id}) stopped: ${stopReasonLabel(reason)} (${reason}).`,
    ...detailLines(detail),
    'Rounds:',
    ...roundLines(input),
    `Blocked until it lands: ${blocked.length ? blocked.join(', ') : 'none'}.`,
    '',
    'It stays stopped until the owner presses Retry in the Plans view; no agent can. '
      + 'Suggested: read the change with plan_get, and ask the owner with decision_ask once the cause is understood or has passed. '
      + 'Replies to this message are refused: act instead.',
  ].join('\n')
}

/** Raise the alert of each new stop in the derivation; returns how many were raised. */
export function raiseStopAlerts(deps: StopAlertDeps, team: TeamIdentity, planId: string, derived: DerivedPlan): number {
  const executionId = derived.executionId
  if (executionId === null || derived.revision === null) return 0
  if (deps.executions.execution(executionId)?.state !== 'running') return 0
  const plan = deps.plans.forTeam(team.teamId, planId)
  if (plan === null) return 0
  const content = deps.plans.revision(planId, derived.revision)?.content
  const { lead, role } = planLead(content)
  const landed = new Set(derived.changes.filter(change => change.outcome === 'landed').map(change => change.change))
  let raised = 0
  derived.changes.forEach((change, index) => {
    const cause = change.cause
    if (change.outcome !== 'stopped' || cause.kind !== 'stopped') return
    const row = deps.executions.change(executionId, change.change)
    if (row === null || row.state !== 'stopped') return
    const episodeKey = String(row.generation)
    if (deps.alerts.episode(team.teamId, executionId, change.change, STOP_ALERT_KIND, episodeKey) !== null) return
    const blocked = content ? blockedDependents(content, change.change, landed) : []
    const input = derived.inputs[index]!
    deps.db.transaction(() => {
      const message = lead === null ? null : deps.mail.enqueue({
        teamId: team.teamId, toKind: 'group', toId: lead, fromKind: 'system', fromSession: null, fromGroup: null, originPath: team.groupsRoot,
        tags: [STOP_TAG, `stop:${cause.reason}`], body: stopBody(plan, change, input, cause.reason, cause.detail, blocked), taskId: null, actor: 'system',
        ...(role?.profiles.length ? { allowedProfiles: role.profiles } : {}),
      })
      const outcome = deps.alerts.insert({
        teamId: team.teamId, planId, executionId, change: change.change, kind: STOP_ALERT_KIND, episodeKey,
        detail: { reason: cause.reason, detail: cause.detail, blocked }, messageId: message?.id ?? null,
      })
      // Another writer recorded the stop first: roll this mail back.
      if (!outcome.inserted) throw new Error(`Stop ${executionId}/${change.change}/${episodeKey} was recorded meanwhile.`)
    })()
    raised++
  })
  return raised
}
