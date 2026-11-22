// Publication handoffs (owner-publication-handoff D2, D3, D10): the request
// (Table H-REQ) and the prepared publish (Table H-PUB). Rights come before
// replay in both, so a request key or a prepared key is never authority.
//
// The prepared publish takes no caller key: it builds `handoff:<id>` and
// publishes through TaskService's one publication routine, whose `within`
// re-reads the handoff (still `open`), writes the revision's association,
// moves the handoff to `published` and writes its wakeup — all in the
// revision's transaction. Fulfillment is only that association (D3): a
// revision under the prepared key without it is an orphan and is refused.
import { liveRecord } from './taskHandoffFacts'
import type { ChatSessionRecord } from '../db'
import type { TaskRevision, TeamTask } from '../../shared/teamTasks'
import { preparedKey, type HandoffActor, type TaskHandoff } from '../../shared/taskHandoffs'
import type { TaskCaller, TaskService } from './TaskService'
import type { PublishOutcome } from './taskStore'
import { taskOwner } from './taskStatusRights'
import { handoffPayloadHash, TaskHandoffStore } from './taskHandoffStore'
import { firstDifference, normalizeHandoffRequest, validateHandoffRequest, type HandoffRequestFields, type NormalizedHandoffRequest } from './taskHandoffValidation'
import { writeHandoffWakeup } from './taskHandoffWakeups'
import { handoffHooks, reconcileHandoffs, type HandoffHookContext } from './taskHandoffHooks'

export interface HandoffRequestInput extends HandoffRequestFields {
  baseRevision: number
  requestKey: string
}

/** The prepared fields a publish may not override (H35); the transport's addressing and command key are not payload. */
export const PREPARED_PAYLOAD_FIELDS = ['direction', 'acceptance', 'contract', 'rationale', 'notify'] as const

export interface HandoffRequestOutcome {
  handoff: TaskHandoff
  /** True when the requester side's key already recorded this payload (H10): nothing was written. */
  replay: boolean
  /** The pending handoff this one superseded (H8), if any. */
  superseded: string | null
}

/** The prepared entry's publication (D3): its `handoff:` key and in-transaction writes, passed to TaskService.publish. */
export interface PublicationLink {
  requestKey: string
  /** Exempts this handoff from the store's stale hook (D4). */
  handoffId: string
  within: (revision: TaskRevision, current: TeamTask) => void
}

export const RESERVED_KEY_REFUSAL = 'Request keys starting with "handoff:" are reserved for prepared publications; nothing was published. Publish a prepared revision with its handoff id.'

const nowIso = () => new Date().toISOString()

export class TaskHandoffService {
  readonly store: TaskHandoffStore

  /** The hooks' and the sweep's context (D4, D6, D7). */
  readonly hookContext: HandoffHookContext

  constructor(private readonly tasks: TaskService, private readonly getSession: (id: string) => ChatSessionRecord | null | undefined) {
    this.store = new TaskHandoffStore(tasks.store.db)
    this.hookContext = {
      db: tasks.store.db, mail: tasks.store.mail, handoffs: this.store, live: this.live,
      originOf: (handoff, task) => this.getSession(handoff.requesterSession)?.projectPath ?? task.worktree ?? handoff.teamId,
    }
    // Every publication and close path runs through the store (D4).
    tasks.store.handoffHooks = handoffHooks(this.hookContext)
  }

  /** D7's startup sweep; SessionMailbox.start() calls it before the first dispatch. */
  reconcile(now = nowIso()): string[] {
    const moved = reconcileHandoffs(this.hookContext, id => this.tasks.store.get(id), now)
    for (const taskId of new Set(moved.map(id => this.store.get(id)!.taskId))) this.tasks.store.touch(taskId)
    return moved
  }

  /** Live: the record present, neither archived nor context-exhausted (D6). */
  live = (sessionId: string): boolean => liveRecord(this.getSession(sessionId))

  /** `task_request_publication` (H-REQ): team/id, right, key, status, base, payload, pending. */
  async request(caller: TaskCaller, taskId: string, input: HandoffRequestInput): Promise<HandoffRequestOutcome> {
    if (caller.kind !== 'agent') throw new Error('Only agents request a publication; the human publishes directly')
    const { team, actor, canCreate } = await this.tasks.context(caller)
    const task = this.tasks.sameTeamTask(team, taskId)
    const sessionId = actor.sessionId!
    if (taskOwner(task) === sessionId) throw new Error("You own this task: publish its revision yourself with task_amend.")
    if (!canCreate) {
      throw new Error('Your group cannot author task directions (its group file does not set canCreateTasks: true). Add a journal note with task_note, or message the task\'s owner instead.')
    }
    const group = this.getSession(sessionId)?.groupId ?? null
    const requestKey = input.requestKey.trim()
    if (!requestKey) throw new Error('A publication request needs a request_key; nothing was recorded')
    const request = normalizeHandoffRequest(input)
    const keyed = this.store.byKey(taskId, requestKey)
    if (keyed) {
      if (!this.requesterSide(keyed, sessionId, group)) {
        throw new Error(`Request key ${requestKey} of this task was used by a different requester; nothing was recorded. Choose another request_key.`)
      }
      const diff = firstDifference(storedRequest(keyed), { ...request, baseRevision: input.baseRevision })
      if (diff) throw new Error(`Request key already used with a different ${diff}; nothing was recorded`)
      return { handoff: keyed, replay: true, superseded: null }
    }
    if (task.status === 'done' || task.status === 'cancelled') throw new Error(`The task is ${task.status}; nothing was recorded`)
    if (input.baseRevision !== task.revision) {
      throw new Error(`Stale: the task's current revision is ${task.revision}, not ${input.baseRevision}; nothing was recorded. Prepare it on revision ${task.revision}.`)
    }
    validateHandoffRequest(request, [...(task.worktree ? [task.worktree] : []), team.groupsRoot])
    const now = nowIso()
    const outcome = this.tasks.store.atomically(() => {
      const fresh = this.tasks.store.get(taskId)!
      if (fresh.revision !== input.baseRevision) throw new Error(`Stale: the task's current revision is ${fresh.revision}; nothing was recorded`)
      const pending = this.store.pendingOf(taskId)
      if (pending && !this.requesterSide(pending, sessionId, group)) {
        throw new Error(`Task already has a pending publication handoff ${pending.id} (${pending.state}) requested by ${pending.requesterSession}${pending.requesterGroup ? ` of group ${pending.requesterGroup}` : ''}; nothing was recorded`)
      }
      const actorOf: HandoffActor = { kind: 'agent', sessionId }
      if (pending) this.store.transition(pending.id, 'superseded', { actor: actorOf, reason: 'superseded by a newer request' }, now)
      const handoff = this.store.insert({
        teamId: task.teamId, taskId, baseRevision: input.baseRevision, baseContractHash: fresh.contractHash ?? null,
        direction: request.direction, acceptance: request.acceptance, contract: request.contract, rationale: request.rationale,
        notify: request.notify, baseCommit: request.baseCommit, evidenceRefs: request.evidenceRefs,
        requesterSession: sessionId, requesterGroup: group, requestKey,
      }, now)
      if (pending) this.tasks.store.db.prepare('UPDATE team_task_handoffs SET superseded_by = ? WHERE id = ?').run(handoff.id, pending.id)
      return { handoff, replay: false, superseded: pending?.id ?? null }
    })
    // Nothing on the task changed; its views (detail, attention) re-read the handoff.
    this.tasks.store.touch(taskId)
    return outcome
  }

  /**
   * Publish prepared revision (H-PUB): human `team-task-handoff-publish` or
   * owner `task_amend { handoff_id }`. `extras` names prepared-payload fields
   * the caller sent beside the handoff id (H35).
   */
  async publish(caller: TaskCaller, taskId: string, handoffId: string, extras: readonly string[]): Promise<PublishOutcome & { handoff: TaskHandoff }> {
    const { team, actor } = await this.tasks.context(caller)
    const task = this.tasks.sameTeamTask(team, taskId)
    const found = this.store.get(handoffId)
    if (!found || found.taskId !== task.id || found.teamId !== team.teamId) throw new Error(`Publication handoff not found for this task: ${handoffId}`)
    if (actor.kind === 'system') throw new Error('Kawai never publishes a task revision; only the owner or the human does.')
    if (actor.kind === 'agent' && taskOwner(task) !== actor.sessionId) {
      throw new Error("Only the task's owner or the human can publish a prepared revision; nothing was published.")
    }
    if (extras.length) {
      throw new Error(`A prepared publish takes only the task and handoff ids; ${extras.join(', ')} cannot override the prepared revision. Nothing was published.`)
    }
    const replay = this.replayOrRefuse(task, found)
    if (replay) return replay
    const key = preparedKey(found.id)
    const now = nowIso()
    const outcome = await this.tasks.publish(caller, taskId, {
      ...(found.direction !== null ? { direction: found.direction } : {}),
      ...(found.acceptance !== null ? { acceptance: found.acceptance } : {}),
      ...(found.contract !== null ? { contract: found.contract } : {}),
      rationale: found.rationale, notify: found.notify, baseRevision: found.baseRevision,
    }, {
      requestKey: key,
      handoffId: found.id,
      within: (revision: TaskRevision, current: TeamTask) => this.fulfill(found.id, actor, team.groupsRoot, revision, current, handoffPayloadHash(found), now),
    })
    // A concurrent duplicate resolved through the store's catch path: it is
    // this handoff's revision only when the association says so (R2).
    if (outcome.replay && this.store.associatedRevision(taskId, found.id) !== outcome.revision.revision) {
      throw new Error(`Revision ${outcome.revision.revision} holds this handoff's key without its association; it is not this handoff's publication`)
    }
    return { ...outcome, handoff: this.store.get(found.id)! }
  }

  /**
   * D3's in-transaction fulfillment, shared by the prepared entry and the
   * linked-draft publish: the handoff still `open`, the revision's
   * association, the `published` transition with the published payload's
   * hash, and its wakeup — committed or rolled back with the revision.
   */
  fulfill(handoffId: string, actor: HandoffActor, originPath: string, revision: TaskRevision, current: TeamTask, publishedPayloadHash: string, now: string): void {
    const fresh = this.store.get(handoffId)
    if (fresh?.state !== 'open') throw new Error(`The publication handoff is ${fresh?.state ?? 'gone'}; nothing was published`)
    this.store.associate(current.id, revision.revision, handoffId)
    this.store.transition(handoffId, 'published', {
      actor: { kind: actor.kind, sessionId: actor.sessionId }, revision: revision.revision, publishedPayloadHash,
    }, now)
    writeHandoffWakeup(this.tasks.store.db, this.tasks.store.mail, this.store.get(handoffId)!, 'published', {
      taskTitle: current.title, revision: revision.revision, originPath, live: this.live,
    }, now)
  }

  /**
   * Decline (human or the task's owner) or withdraw (the requester side),
   * Table H-SETTLE in its order: team/id, right, reason, state. A decline
   * wakes the requester side (D6); a withdrawal is its own act and wakes nobody.
   */
  async settle(caller: TaskCaller, handoffId: string, action: 'decline' | 'withdraw', reason: string, taskId?: string): Promise<TaskHandoff> {
    const { team, actor } = await this.tasks.context(caller)
    const found = this.store.get(handoffId)
    if (!found || found.teamId !== team.teamId || (taskId !== undefined && found.taskId !== taskId)) throw new Error(`Publication handoff not found in this team: ${handoffId}`)
    const task = this.tasks.sameTeamTask(team, found.taskId)
    if (action === 'decline') {
      if (actor.kind === 'system') throw new Error('Kawai never declines a publication handoff; only the owner or the human does.')
      if (actor.kind === 'agent' && taskOwner(task) !== actor.sessionId) {
        throw new Error("Only the task's owner or the human can decline a publication handoff; nothing was changed. Withdraw your own request instead.")
      }
    } else if (actor.kind !== 'agent' || !this.requesterSide(found, actor.sessionId!, this.getSession(actor.sessionId!)?.groupId ?? null)) {
      throw new Error('Only the requester or a session of its group can withdraw a publication handoff; nothing was changed.')
    }
    const why = reason?.trim()
    if (!why) throw new Error(`A ${action} needs a reason; nothing was changed`)
    if (found.state !== 'open' && found.state !== 'stale') throw new Error(`The publication handoff is ${found.state}; nothing was changed.`)
    const now = nowIso()
    const settled = this.tasks.store.atomically(() => {
      const to = action === 'decline' ? 'declined' : 'withdrawn'
      if (!this.store.transition(found.id, to, { actor: { kind: actor.kind, sessionId: actor.sessionId }, reason: why }, now)) {
        throw new Error(`The publication handoff is ${this.store.get(found.id)?.state ?? 'gone'}; nothing was changed.`)
      }
      const handoff = this.store.get(found.id)!
      if (action === 'decline') {
        writeHandoffWakeup(this.tasks.store.db, this.tasks.store.mail, handoff, 'declined', {
          taskTitle: task.title, revision: null, originPath: team.groupsRoot, live: this.live,
        }, now)
      }
      return handoff
    })
    this.tasks.store.touch(task.id)
    return settled
  }

  /** H14 (R2 `published`), the orphan refusal (R1, R4), H16b (R3) and H15; null for R0 `open`. */
  private replayOrRefuse(task: TeamTask, handoff: TaskHandoff): (PublishOutcome & { handoff: TaskHandoff }) | null {
    const keyRow = this.store.preparedKeyRevision(task.id, handoff.id)
    if (keyRow && keyRow.handoffId !== handoff.id) {
      throw new Error(`Revision ${keyRow.revision} holds this handoff's key without its association; it is not this handoff's publication. Nothing was published.`)
    }
    if (keyRow) {
      const revision = this.tasks.store.revisions(task.id).find(entry => entry.revision === keyRow.revision)!
      return { replay: true, task, revision, handoff }
    }
    if (handoff.state === 'published') {
      const linked = this.store.associatedRevision(task.id, handoff.id)
      throw new Error(`The publication handoff is published${linked !== null ? ` as revision ${linked} through its linked draft` : ''}; nothing was published.`)
    }
    if (handoff.state !== 'open') throw new Error(`The publication handoff is ${handoff.state}; nothing was published.`)
    return null
  }

  /** The requester session, or any session of the handoff's recorded group. */
  private requesterSide(handoff: TaskHandoff, sessionId: string, group: string | null): boolean {
    return handoff.requesterSession === sessionId || (handoff.requesterGroup !== null && handoff.requesterGroup === group)
  }
}

function storedRequest(handoff: TaskHandoff): NormalizedHandoffRequest & { baseRevision: number } {
  return {
    direction: handoff.direction, acceptance: handoff.acceptance, contract: handoff.contract, rationale: handoff.rationale,
    notify: handoff.notify, baseCommit: handoff.baseCommit, evidenceRefs: handoff.evidenceRefs, baseRevision: handoff.baseRevision,
  }
}
