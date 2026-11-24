// Store-level handoff hooks (owner-publication-handoff D4) and the startup
// sweep (D7). TaskStore calls the hooks inside its own transactions, so
// every publication path — the human form, `task_amend`, a prepared
// publish, the pause resolution's Adapt under its `pause:` key — and every
// close — `setStatus`, `prepareStatus().commit`, the override's
// cancellation — moves a pending handoff in the transaction that caused it,
// with its wakeup (D6). A throw anywhere rolls the revision or the status
// change back together with the handoff, the wakeup row and its mail.
//
// The sweep reconciles only facts an authorized path already persisted, in
// D7's order: the association (DF1), the task closed (DF2), the base behind
// (DF3). A revision that merely holds `handoff:<id>` is never fulfillment
// (DF4); a `stale` handoff whose base reads current is a tolerated no-op.
import type { Database } from 'bun:sqlite'
import type { ActingParty } from '../../shared/team'
import type { TeamTask } from '../../shared/teamTasks'
import type { TaskHandoff } from '../../shared/taskHandoffs'
import type { MailboxStore } from './mailboxStore'
import { handoffPayloadHash, type TaskHandoffStore } from './taskHandoffStore'
import { writeHandoffWakeup } from './taskHandoffWakeups'

/** TaskStore's hook seam; TaskHandoffService installs it in its constructor. */
export interface TaskHandoffHooks {
  /** In `TaskStore.publish`'s transaction after revision N's row: every pending handoff but `handoffId`'s turns stale. */
  published(task: TeamTask, revision: number, handoffId: string | undefined, author: ActingParty, now: string): void
  /** In `TaskStore.setStatus`'s transaction when the task enters `done` or `cancelled`. */
  closed(task: TeamTask, actor: ActingParty, now: string): void
}

export interface HandoffHookContext {
  db: Database
  mail: MailboxStore | undefined
  handoffs: TaskHandoffStore
  /** D6's liveness: the record present, neither archived nor context-exhausted. */
  live: (sessionId: string) => boolean
  /** The mail's origin path, a path inside the team (it locates the group catalog). */
  originOf: (handoff: TaskHandoff, task: TeamTask) => string
}

const actorOf = (party: ActingParty) => ({ kind: party.kind, sessionId: party.sessionId })

function stale(ctx: HandoffHookContext, handoff: TaskHandoff, task: TeamTask, revision: number, actor: ActingParty, now: string): boolean {
  if (handoff.state !== 'open') return false
  if (!ctx.handoffs.transition(handoff.id, 'stale', { actor: actorOf(actor), revision, reason: `revision ${revision} was published` }, now)) return false
  writeHandoffWakeup(ctx.db, ctx.mail, ctx.handoffs.get(handoff.id)!, 'stale', { taskTitle: task.title, revision, originPath: ctx.originOf(handoff, task), live: ctx.live }, now)
  return true
}

function close(ctx: HandoffHookContext, handoff: TaskHandoff, task: TeamTask, actor: ActingParty, now: string): boolean {
  if (!ctx.handoffs.transition(handoff.id, 'closed', { actor: actorOf(actor), reason: `the task is ${task.status}` }, now)) return false
  writeHandoffWakeup(ctx.db, ctx.mail, ctx.handoffs.get(handoff.id)!, 'closed', { taskTitle: task.title, revision: null, originPath: ctx.originOf(handoff, task), live: ctx.live }, now)
  return true
}

export function handoffHooks(ctx: HandoffHookContext): TaskHandoffHooks {
  return {
    published(task, revision, handoffId, author, now) {
      const pending = ctx.handoffs.pendingOf(task.id)
      if (pending && pending.id !== handoffId) stale(ctx, pending, task, revision, author, now)
    },
    closed(task, actor, now) {
      const pending = ctx.handoffs.pendingOf(task.id)
      if (pending) close(ctx, pending, task, actor, now)
    },
  }
}

const SWEEP_ACTOR: ActingParty = { kind: 'system', sessionId: null }

/**
 * D7's idempotent startup sweep over every pending handoff, each in its own
 * transaction. Returns the handoffs it moved; a healthy database moves none.
 */
export function reconcileHandoffs(ctx: HandoffHookContext, taskOf: (id: string) => TeamTask | null, now: string): string[] {
  const pending = ctx.db.prepare("SELECT id FROM team_task_handoffs WHERE state IN ('open', 'stale') ORDER BY created_at, id").all() as Array<{ id: string }>
  const moved: string[] = []
  for (const { id } of pending) {
    const repaired = ctx.db.transaction((): boolean => {
      const handoff = ctx.handoffs.get(id)
      const task = handoff ? taskOf(handoff.taskId) : null
      if (!handoff || !task || (handoff.state !== 'open' && handoff.state !== 'stale')) return false
      const associated = ctx.handoffs.associatedRevision(task.id, handoff.id)
      if (associated !== null) {
        if (!ctx.handoffs.transition(handoff.id, 'published', { actor: actorOf(SWEEP_ACTOR), revision: associated, publishedPayloadHash: handoffPayloadHash(handoff), reason: 'reconciled at startup from its associated revision' }, now)) return false
        writeHandoffWakeup(ctx.db, ctx.mail, ctx.handoffs.get(handoff.id)!, 'published', { taskTitle: task.title, revision: associated, originPath: ctx.originOf(handoff, task), live: ctx.live }, now)
        return true
      }
      if (task.status === 'done' || task.status === 'cancelled') return close(ctx, handoff, task, SWEEP_ACTOR, now)
      if (task.revision > handoff.baseRevision) return stale(ctx, handoff, task, task.revision, SWEEP_ACTOR, now)
      return false
    })()
    if (repaired) moved.push(id)
  }
  return moved
}
