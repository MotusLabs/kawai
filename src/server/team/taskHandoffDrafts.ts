// Edit before publishing (owner-publication-handoff D3, Table H-DRAFT): the
// human loads an `open` handoff into the task's draft, which then carries
// the handoff's id and a fresh server-owned lineage identity (H19), and a
// draft publish (`fromDraft: true`) of that linked draft fulfills the
// handoff through the ordinary entry, with the human's ordinary key.
//
// The linked publish is checked inside the publication transaction, after
// the key replay (H17r, H17m) and before the stale-base check and the draft
// discard: the form's observed identity must be the stored linked draft's
// (H43), and only an `open` handoff is fulfilled (H17); an ended one
// publishes an ordinary revision (H38). An explicit ordinary publication
// (`fromDraft: false`, `task_amend`) never reads the draft (H44).
import { randomUUID } from 'node:crypto'
import type { HandoffActor, HandoffPreparedFields, TaskHandoff } from '../../shared/taskHandoffs'
import type { TaskDraft } from '../../shared/teamTasks'
import type { TaskCaller, TaskPublishInput, TaskService } from './TaskService'
import { handoffPayloadHash } from './taskHandoffStore'
import type { PublishInput } from './taskStore'

const nowIso = () => new Date().toISOString()
const trimmed = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)

/** `team-task-handoff-load-draft` (H36, H37, H18, H19), in the table's order: team/id, caller, state, draft/replace. */
export async function loadHandoffDraft(tasks: TaskService, caller: TaskCaller, taskId: string, handoffId: string, replace: boolean): Promise<TaskDraft> {
  const { team } = await tasks.context(caller)
  const task = tasks.sameTeamTask(team, taskId)
  const found = tasks.handoffs.store.get(handoffId)
  if (!found || found.taskId !== task.id || found.teamId !== team.teamId) throw new Error(`Publication handoff not found for this task: ${handoffId}`)
  if (caller.kind !== 'human') throw new Error("Drafts are the human's; publish a prepared revision with task_amend and its handoff_id")
  const now = nowIso()
  return tasks.store.atomically(() => {
    const fresh = tasks.handoffs.store.get(handoffId)!
    if (fresh.state !== 'open') throw new Error(`The publication handoff is ${fresh.state}; nothing was loaded into the draft.`)
    if (tasks.store.drafts.get(taskId) && !replace) {
      throw new Error('This task already has a draft; confirm replacing it to load the prepared revision. Nothing was changed.')
    }
    const base = tasks.store.revisions(taskId).find(entry => entry.revision === fresh.baseRevision)!
    return tasks.store.drafts.save(taskId, {
      baseRevision: fresh.baseRevision, direction: fresh.direction ?? base.direction, acceptance: fresh.acceptance ?? base.acceptance,
      rationale: fresh.rationale, contractText: fresh.contract,
    }, now, { handoffId: fresh.id, lineageId: randomUUID() })
  })
}

/**
 * The published fields in the handoff's own terms, so an unedited load
 * publishes the request's hash and an edit reads "published as edited": a
 * field the handoff carried over (null) stays null while it equals the base.
 */
function publishedFields(handoff: TaskHandoff, input: TaskPublishInput, base: { direction: string; acceptance: string | null }): HandoffPreparedFields {
  const direction = trimmed(input.direction)
  const acceptance = input.acceptance === undefined ? null : trimmed(input.acceptance)
  return {
    direction: handoff.direction === null && (direction === null || direction === base.direction) ? null : direction,
    acceptance: handoff.acceptance === null && (input.acceptance === undefined || acceptance === base.acceptance) ? null : acceptance,
    contract: input.contract === undefined ? null : input.contract,
    rationale: input.rationale?.trim() ?? '',
    notify: input.notify === true,
  }
}

/** The ordinary entry's linked-draft checks for a human draft publish (H17, H17m, H38, H43), run by the store in its transaction. */
export function linkedDraftPublish(tasks: TaskService, taskId: string, input: TaskPublishInput, actor: HandoffActor, originPath: string): Pick<PublishInput, 'claim' | 'linkedHandoffDiffers'> {
  const drafts = tasks.store.drafts
  const observed = input.observedDraft ?? null
  return {
    linkedHandoffDiffers: revision => {
      const stored = drafts.get(taskId)
      // Only this form's own linked draft is a linked intent; a stale form's resend replays (H17r).
      if (!stored?.lineageId || !stored.handoffId || stored.lineageId !== observed) return false
      const row = tasks.store.db.prepare('SELECT handoff_id FROM team_task_revisions WHERE task_id = ? AND revision = ?').get(taskId, revision) as { handoff_id: string | null } | null
      return (row?.handoff_id ?? null) !== stored.handoffId
    },
    claim: () => {
      const stored = drafts.get(taskId)
      const link = drafts.observedLink(stored, observed)
      if (!link) return null
      if (input.baseRevision !== undefined && input.baseRevision !== stored!.baseRevision) {
        throw new Error(`The stored draft is based on revision ${stored!.baseRevision}, not ${input.baseRevision}; nothing was published. Refresh to see the stored draft.`)
      }
      const handoff = tasks.handoffs.store.get(link.handoffId)
      if (handoff?.state !== 'open') return null
      const base = tasks.store.revisions(taskId).find(entry => entry.revision === handoff.baseRevision)!
      const hash = handoffPayloadHash(publishedFields(handoff, input, base))
      return {
        handoffId: handoff.id,
        within: (revision, current) => tasks.handoffs.fulfill(handoff.id, actor, originPath, revision, current, hash, nowIso()),
      }
    },
  }
}
