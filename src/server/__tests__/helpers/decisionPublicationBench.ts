import type { Database } from 'bun:sqlite'
import type { ServerMessage } from '../../../shared/types'
import { DecisionService } from '../../plans/decisions/DecisionService'
import { handleDecisionCommand, type DecisionClientMessage } from '../../plans/decisions/decisionConnections'
import { ExecutionStore } from '../../plans/execution/executionStore'
import { ExecutionRevisionStore } from '../../plans/revisionControl/executionRevisionStore'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import { createDecisionBench } from '../decisionHarness'
import { createPlanBench, writeGroup, type PlanWorld } from '../planHarness'

export const LEAD = { kind: 'agent', sessionId: 'lead' } as const
export const HUMAN = { kind: 'human', sessionId: null } as const
export const PREPARED = { direction: 'Write headers first', acceptance: 'First row is headers', rationale: 'Prepared evidence', requestKey: 'prepared', baseRevision: 1, notify: true }
export const QUESTION = { question: 'Publish the headers?', options: ['Publish', 'Wait'], context: 'Headers review' }

export function publicationBench(world: PlanWorld) {
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  const bench = createDecisionBench(world, createPlanBench(world, {}, { database: 'template' }))
  const { db } = bench.db
  const decide = new DecisionService({
    ...bench.decide.deps,
    publication: { executions: new ExecutionStore(db), revisions: new ExecutionRevisionStore(db) },
  })
  const connectionManager = {
    decisions: decide,
    teamScopes: {
      resolve: async (path: string) => path === world.repo ? world.team : path === world.other ? world.otherTeam : null,
    },
  } as unknown as ChatSessionManager
  const wire = async (message: DecisionClientMessage) => {
    const messages: ServerMessage[] = []
    await handleDecisionCommand(connectionManager, { send: entry => messages.push(entry) }, message)
    const [reply] = messages
    if (messages.length !== 1 || reply?.type !== 'team-plan-result' || reply.requestId !== message.requestId || reply.teamPath !== message.teamPath) {
      throw new Error(`Expected one result for ${message.type} on ${message.teamPath}`)
    }
    return reply
  }
  return { ...bench, decide, wire }
}
export type PublicationBench = ReturnType<typeof publicationBench>

export async function prepareManual(bench: PublicationBench, input: { leadRole?: boolean; notify?: boolean } = {}) {
  const planId = await bench.approvedPlan(input.leadRole ?? true)
  const task = bench.tasks.create({ teamId: bench.human.team.teamId, title: 'Export', direction: 'Build export', creator: HUMAN, planId, planChange: 'api' })
  const { handoff } = await bench.taskService.handoffs.request(LEAD, task.id, { ...PREPARED, notify: input.notify ?? true })
  return { task, planId, handoff, ask: { ...QUESTION, publication_handoff_id: handoff.id } }
}

export async function bindManual(bench: PublicationBench) {
  const prepared = await prepareManual(bench)
  const outcome = await bench.decide.ask(LEAD, prepared.ask)
  if (!('publication' in outcome)) throw new Error('The typed ask returned an ordinary card')
  const { card, publication: link } = outcome
  return {
    ...prepared, card, link,
    approval: { type: 'team-plan-approve-publication' as const, requestId: 'approve', teamPath: bench.human.team.groupsRoot,
      cardId: card.id, planId: prepared.planId, expectedHandoffId: link.handoffId, expectedBindingHash: link.bindingHash, commandId: 'approve-headers' },
  }
}

/** Durable state for both the winner and the zero-effects controls, independent of public projections. */
export function decisionWriteSnapshot(db: Database): Record<string, unknown[]> {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .filter(({ name }) => /^(team_(task|message)|plan_(decision|fix_task|execution|pause|hold))/.test(name) || name === 'plans' || name === 'plan_revisions' || name === 'plan_events')
  return Object.fromEntries(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
