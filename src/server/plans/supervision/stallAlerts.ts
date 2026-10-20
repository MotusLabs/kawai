// Stall alerts (plan-supervision design D11): each stall episode the sweep
// derives is alerted once. One transaction inserts the `plan_stall_alerts`
// row and enqueues Kawai's mail — `from_kind: 'system'`, to the plan's Lead
// role group with that role's `allowed_profiles` and no task, tagged
// `plan-stall` and `stall:<kind>` — naming the plan, change, stage, holder,
// last progress and activity, rounds with their failing checks, and open
// cards, with the suggested actions. Without a Lead role the row is written
// with a null message and no mail is sent (the stall is the owner's item).
// The durable episode key keeps a restart during a stall from sending again;
// replies to the alert meet Kawai's reply guard in `TeamMailbox`.
import type { Database } from 'bun:sqlite'
import { failingChecks, type ChangeSupervision, type SupervisionInput, type SupervisionStall } from '../../../shared/planSupervision'
import type { PlanContent } from '../../../shared/plans'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { PlanStore } from '../planStore'
import type { DerivedPlan } from './SupervisionMonitor'
import type { StallAlertStore } from './stallAlertStore'

export interface StallAlertDeps {
  db: Database
  mail: Pick<MailboxStore, 'enqueue'>
  alerts: Pick<StallAlertStore, 'episode' | 'insert'>
  plans: Pick<PlanStore, 'forTeam' | 'revision'>
}

export const STALL_TAG = 'plan-stall'

const STAGE_LABELS: Record<string, string> = { implement: 'implement attempt', fix: 'fix attempt', update: 'update attempt', review: 'review', kawai: "Kawai's step" }

function stallLine(stall: SupervisionStall): string {
  if (stall.kind === 'no-progress') {
    return `No progress since ${stall.anchorAt}; the deadline passed at ${stall.deadlineAt}${stall.idle ? ' while the holder sat idle' : ''}.`
  }
  return `Two consecutive rounds failed with the same signature: ${stall.signature}.`
}

function roundLines(input: SupervisionInput): string[] {
  const rounds = input.rounds.slice().sort((a, b) => a.number - b.number)
  if (rounds.length === 0) return ['- none yet']
  return rounds.map(round => {
    const failing = failingChecks(round.ci).map(check => check.link ? `${check.name} (${check.link})` : check.name)
    const parts = [`- round ${round.number}: ${round.outcome ?? 'undecided'}`]
    if (failing.length) parts.push(`failing ${failing.join(', ')}`)
    if (round.verdict) parts.push(`review ${round.verdict}`)
    return parts.join('; ')
  })
}

/** D11's body. */
export function stallBody(plan: { id: string; title: string }, change: ChangeSupervision, input: SupervisionInput, stall: SupervisionStall): string {
  const holder = change.holder
  const cards = input.openCards.map(card => `${card.cardId} (addressed to ${card.addressedTo === 'lead' ? card.addressedGroup ?? 'the Lead role' : 'the owner'})`)
  return [
    `Kawai: change ${change.change} of plan "${plan.title}" (${plan.id}) is stalled: ${stall.kind}.`,
    stallLine(stall),
    `Stage: ${change.stage ? STAGE_LABELS[change.stage] ?? change.stage : 'none'}.`,
    `Holder: ${holder ? `${holder.session} (group ${holder.group ?? 'none'}, profile ${holder.profile ?? 'none'})` : 'none'}.`,
    `Last progress: ${change.progress ? `${change.progress.kind} at ${change.progress.at}` : 'none'}.`,
    `Last activity: ${change.activity ? `${change.activity.kind} at ${change.activity.at}` : 'none'}.`,
    'Rounds:',
    ...roundLines(input),
    `Open cards: ${cards.length ? cards.join(', ') : 'none'}.`,
    '',
    'Suggested: message the holder, record a decision with decision_record, or ask the owner with decision_ask. '
      + 'Retry and Stop are the owner\'s, in the Plans view. Replies to this message are refused: act instead.',
  ].join('\n')
}

/** Raise the alert of each new stall episode in the derivation; returns how many were raised. */
export function raiseStallAlerts(deps: StallAlertDeps, team: TeamIdentity, planId: string, derived: DerivedPlan): number {
  const executionId = derived.executionId
  if (executionId === null || derived.revision === null) return 0
  const plan = deps.plans.forTeam(team.teamId, planId)
  if (plan === null) return 0
  const content: PlanContent | undefined = deps.plans.revision(planId, derived.revision)?.content
  const lead = content?.leadGroup ?? null
  const role = lead ? content!.roles.find(entry => entry.group === lead) : undefined
  let raised = 0
  derived.changes.forEach((change, index) => {
    const stall = change.stall
    if (stall === null || change.outcome !== 'stalled') return
    if (deps.alerts.episode(team.teamId, executionId, change.change, stall.kind, stall.episodeKey) !== null) return
    const input = derived.inputs[index]!
    deps.db.transaction(() => {
      const message = lead === null ? null : deps.mail.enqueue({
        teamId: team.teamId, toKind: 'group', toId: lead, fromKind: 'system', fromSession: null, fromGroup: null, originPath: team.groupsRoot,
        tags: [STALL_TAG, `stall:${stall.kind}`], body: stallBody(plan, change, input, stall), taskId: null, actor: 'system',
        ...(role?.profiles.length ? { allowedProfiles: role.profiles } : {}),
      })
      const outcome = deps.alerts.insert({
        teamId: team.teamId, planId, executionId, change: change.change, kind: stall.kind, episodeKey: stall.episodeKey,
        detail: { stage: change.stage, holder: change.holder, progress: change.progress, activity: change.activity, stall }, messageId: message?.id ?? null,
      })
      // Another writer recorded the episode first: roll this mail back.
      if (!outcome.inserted) throw new Error(`Stall episode ${executionId}/${change.change}/${stall.kind} was recorded meanwhile.`)
    })()
    raised++
  })
  return raised
}
