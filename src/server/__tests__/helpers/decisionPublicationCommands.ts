import type { PlanDecisionCardView } from '../../../shared/planDecisions'
import type { TaskHandoff } from '../../../shared/taskHandoffs'
import type { ClientMessage } from '../../../shared/types'
import type { publicationRuntime } from './decisionPublicationRuntime'
import { PREPARED, QUESTION } from './decisionPublicationBench'

export type PublicationRuntime = Awaited<ReturnType<typeof publicationRuntime>>
export type ApprovalCommand = Extract<ClientMessage, { type: 'team-plan-approve-publication' }>
export type OwnerAnswer = Extract<ClientMessage, { type: 'team-plan-decide' }>
export type BindingAnswer = {
  card_id: string
  addressed_to: 'owner' | 'lead'
  replayed: boolean
  publication: { handoff_id: string; task_id: string; base_revision: number; payload_hash: string }
}

function gate() {
  let open!: () => void
  const waiting = new Promise<void>(resolve => { open = resolve })
  return { open, waiting }
}

// Hold the selected approval after fresh eligibility and before the prepared writer.
export async function beginAfterCheck(runtime: PublicationRuntime, command: ApprovalCommand) {
  const entered = gate()
  const resume = gate()
  const handoffs = runtime.manager.tasks.handoffs
  const publish = handoffs.publish.bind(handoffs)
  handoffs.publish = async (...args) => {
    if (args[3]) {
      handoffs.publish = publish
      entered.open()
      await resume.waiting
    }
    return publish(...args)
  }
  const result = runtime.routed('team-plan-result', command)
  await Promise.race([entered.waiting, result.then(() => { throw new Error('Approval returned before reaching the prepared writer') })])
  return { result, resume: () => { handoffs.publish = publish; resume.open() } }
}

export async function beginIndependent<T>(runtime: PublicationRuntime, kind: 'answer' | 'publish', run: () => Promise<T>) {
  const entered = gate()
  const resume = gate()
  let restore: () => void
  if (kind === 'answer') {
    const decisions = runtime.manager.decisions!
    const answer = decisions.answer.bind(decisions)
    restore = () => { decisions.answer = answer }
    decisions.answer = async (...args) => {
      restore()
      entered.open()
      await resume.waiting
      return answer(...args)
    }
  } else {
    const tasks = runtime.manager.tasks
    const publish = tasks.publish.bind(tasks)
    restore = () => { tasks.publish = publish }
    tasks.publish = async (...args) => {
      if (!args[3]?.approval) {
        restore()
        entered.open()
        await resume.waiting
      }
      return publish(...args)
    }
  }
  const result = run()
  await Promise.race([entered.waiting, result.then(() => { throw new Error('Independent command returned before reaching the writer') })])
  return { result, resume: () => { restore(); resume.open() } }
}

export async function prepare(runtime: PublicationRuntime, taskId = runtime.task.id, baseRevision = 1, key = PREPARED.requestKey, contract?: string) {
  const { handoff } = await runtime.leadTool<{ handoff: TaskHandoff }>('task_request_publication', {
    task_id: taskId, base_revision: baseRevision, request_key: key, direction: PREPARED.direction,
    acceptance: PREPARED.acceptance, rationale: PREPARED.rationale, evidence_refs: ['fixture-review'], ...(contract ? { contract } : {}),
  })
  return handoff
}

export function askInput(handoff: TaskHandoff) {
  return { ...QUESTION, publication_handoff_id: handoff.id }
}

export async function bind(runtime: PublicationRuntime, handoff: TaskHandoff, planId = runtime.plan.planId) {
  const ask = askInput(handoff)
  const asked = await runtime.leadTool<BindingAnswer>('decision_ask', ask)
  const request = { teamPath: runtime.teamPath, planId, cardId: asked.card_id }
  const read = async () => {
    const { decisions } = await runtime.leadTool<{ decisions: PlanDecisionCardView[] }>('plan_get', { plan_id: planId })
    return decisions.find(view => view.card.id === asked.card_id)!
  }
  const reviewed = await runtime.routed('team-plan-result', {
    ...request, type: 'team-plan-publication-review', requestId: 'read-bound-review',
  })
  if (!reviewed.publicationReview) throw new Error(reviewed.error ?? 'Missing publication review')
  const review = reviewed.publicationReview
  const approve: ApprovalCommand = {
    ...request, type: 'team-plan-approve-publication', requestId: 'approve-first',
    expectedHandoffId: handoff.id, expectedBindingHash: review.link.bindingHash, commandId: 'combined-publication',
  }
  const answer: OwnerAnswer = {
    ...request, type: 'team-plan-decide', requestId: 'answer-first', commandId: 'answer-only', choice: 'Approve and publish',
  }
  return { ask, asked, approve, answer, review, read }
}

export function ordinary(runtime: PublicationRuntime, taskId = runtime.task.id, baseRevision = 1) {
  return {
    type: 'team-task-publish' as const, requestId: `ordinary-${baseRevision}`, requestKey: `ordinary-${baseRevision}`,
    teamPath: runtime.teamPath, taskId, baseRevision, direction: 'Independent direction', rationale: 'Independent publication', notify: false,
  }
}

export function prepared(runtime: PublicationRuntime, handoff: TaskHandoff) {
  return {
    type: 'team-task-handoff-publish' as const, requestId: 'standalone-prepared', requestKey: 'standalone-prepared',
    teamPath: runtime.teamPath, taskId: handoff.taskId, handoffId: handoff.id,
  }
}

export async function linkedDraft(runtime: PublicationRuntime, handoff: TaskHandoff) {
  const { teamPath, routed } = runtime
  const loaded = await routed('team-task-result', { type: 'team-task-handoff-load-draft', requestId: 'load', teamPath,
    taskId: handoff.taskId, handoffId: handoff.id, replace: false })
  if (loaded.error) throw new Error(loaded.error)
  const draft = runtime.manager.tasks.store.drafts.get(handoff.taskId)
  if (!draft?.lineageId) throw new Error('Missing linked draft lineage')
  return {
    ...ordinary(runtime, handoff.taskId, handoff.baseRevision), requestId: 'linked-draft', requestKey: 'linked-draft',
    direction: 'Edited linked draft', fromDraft: true, observedDraft: draft.lineageId,
  }
}
