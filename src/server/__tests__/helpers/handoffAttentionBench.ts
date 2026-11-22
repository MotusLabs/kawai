// A bench for the handoff attention rows (owner-publication-handoff tasks
// 8.1, 8.4): the real decision bench's stores and services, a group
// assignment whose instruction a session claims, real publications through
// the handoff service, notices written by the real `TaskNotices` and then
// moved to the state a row needs, ordinary task mail delivered with a
// revision, acknowledgements through `TaskService.acknowledge`, and the
// workspace read's own handoff facts and items (`handoffAttentionFacts`).
import fs from 'node:fs'
import type { AttentionItem } from '../../../shared/teamWorkspace'
import type { HandoffNoticeState, TaskHandoff } from '../../../shared/taskHandoffs'
import { handoffAttentionFacts, handoffAttentionItems, handoffFollowUpItems } from '../../team/handoffAttention'
import { createDecisionBench, type DecisionBench } from '../decisionHarness'
import { createPlanWorld, writeGroup, type PlanWorld } from '../planHarness'

export type NoticeMove = HandoffNoticeState

export interface HandoffAttentionBench {
  world: PlanWorld
  bench: DecisionBench
  /** A human-created task; `owner` makes that agent session its owner. */
  task: (owner?: string | null) => Promise<string>
  /** A group assignment of the task whose instruction `session` claimed, was delivered and acknowledged at the current revision. */
  claim: (taskId: string, session?: string) => void
  request: (taskId: string, notify?: boolean, requester?: string) => Promise<TaskHandoff>
  /** Publish the pending handoff as the human; returns the published revision. */
  publish: (taskId: string, handoffId: string) => Promise<number>
  /** One notice from the real `TaskNotices.write` to the claimant for `revision`, moved to `state`. */
  notice: (taskId: string, revision: number, state: NoticeMove) => string
  /** Ordinary task mail to `session` carrying `revision`, delivered or left queued. */
  taskMail: (taskId: string, session: string, revision: number, delivered?: boolean) => string
  acknowledge: (taskId: string, session: string, revision: number) => Promise<void>
  gone: (session: string) => void
  /** Make an archived session live again. */
  revive: (session: string) => void
  /** The workspace read's handoff items (pending and follow-up), optionally with the task owned by an execution. */
  items: (ownedByExecution?: (taskId: string) => boolean) => AttentionItem[]
  close: () => void
}

let serial = 0

export async function createHandoffAttentionBench(prefix = 'kawai-handoff-attention-'): Promise<HandoffAttentionBench> {
  const world = await createPlanWorld(prefix)
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  const bench = createDecisionBench(world)
  const service = bench.taskService
  const store = bench.tasks
  const mail = bench.mail
  const human = bench.human
  const teamId = world.team.teamId
  const deliver = (messageId: string, session: string, revision: number) => {
    mail.claim(messageId, session)
    mail.markPushed(messageId, undefined, revision)
    mail.markDelivered(messageId)
  }
  const move = (messageId: string, state: NoticeMove) => {
    const message = mail.get(messageId)!
    if (state === 'queued') return
    if (state === 'delivered') return deliver(messageId, message.toId!, store.get(message.taskId!)!.revision)
    mail.claim(messageId, message.toId!)
    if (state === 'uncertain') mail.holdUncertain(messageId, 'push outcome unknown')
    else mail.deadLetter(messageId, 'push failed')
  }
  return {
    world, bench,
    task: async owner => {
      const task = await service.create(human, { title: `Task ${++serial}`, direction: 'Build' })
      if (owner) store.db.prepare('UPDATE team_tasks SET owner_session = ? WHERE id = ?').run(owner, task.id)
      return task.id
    },
    claim: (taskId, session = 'dev') => {
      const { assignment } = bench.assignmentStore.insert({
        teamId, taskId, requestKey: `assign-${++serial}`, targetKind: 'group', targetId: 'middle-devs', role: 'middle-devs',
        instruction: 'Build it', creator: { kind: 'human', sessionId: null },
      })
      const instruction = mail.enqueue({ teamId, toKind: 'group', toId: 'middle-devs', fromKind: 'human', fromSession: null, fromGroup: null,
        originPath: world.repo, body: 'Build it', taskId })
      bench.assignmentStore.setMessage(assignment.id, instruction.id)
      deliver(instruction.id, session, store.get(taskId)!.revision)
      // The holder works from the revision it was handed.
      store.acknowledgements.record(taskId, session, store.get(taskId)!.revision, assignment.id)
    },
    request: async (taskId, notify = false, requester = 'lead') => (await service.handoffs.request({ kind: 'agent', sessionId: requester }, taskId, {
      baseRevision: store.get(taskId)!.revision, direction: `Prepared ${++serial}`, rationale: 'why', notify, requestKey: `k${serial}`,
    })).handoff,
    publish: async (taskId, handoffId) => {
      await service.handoffs.publish(human, taskId, handoffId, [])
      return store.get(taskId)!.revision
    },
    notice: (taskId, revision, state) => {
      const task = store.get(taskId)!
      const row = store.revisions(taskId).find(entry => entry.revision === revision)!
      const [sent] = store.notices!.write(task, row, {
        sender: { actor: { kind: 'human', sessionId: null }, fromGroup: null, originPath: world.repo },
        requestKey: `notice-${++serial}`, sessionExists: () => true,
      })
      if (!sent) throw new Error('no claimant to notify')
      move(sent.messageId, state)
      return sent.messageId
    },
    taskMail: (taskId, session, revision, delivered = true) => {
      const message = mail.enqueue({ teamId, toKind: 'session', toId: session, fromKind: 'human', fromSession: null, fromGroup: null,
        originPath: world.repo, body: `Note ${++serial}`, taskId })
      if (delivered) deliver(message.id, session, revision)
      return message.id
    },
    acknowledge: async (taskId, session, revision) => { await service.acknowledge({ kind: 'agent', sessionId: session }, taskId, revision) },
    revive: session => { bench.records.set(session, { ...bench.records.get(session)!, archivedAt: null }) },
    gone: session => { bench.records.set(session, { ...bench.records.get(session)!, archivedAt: new Date().toISOString() }) },
    items: (ownedByExecution = () => false) => {
      const manager = { tasks: service, results: { ownedByExecution } }
      const { handoffs, handoffFollowUps } = handoffAttentionFacts(manager as never, teamId, id => id)
      return [...handoffAttentionItems(handoffs), ...handoffFollowUpItems(handoffFollowUps)]
    },
    close: () => {
      bench.db.close()
      fs.rmSync(world.root, { recursive: true, force: true })
    },
  }
}
