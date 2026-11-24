// Apply's per-change writes (plan-revision-apply design D3, oracle table CH),
// called only inside Apply's transaction, after the preconditions passed.
// Each change of the delta gets one publication row with its class and
// choice; then, by class and choice:
// - unchanged, metadata, changed `continue`, changed with no task (`none`):
//   the row only — the execution's advanced revision is what later readers
//   (dependencies, `fixes`, handoffs, the next attempt) see (CH1–CH3, CH6);
// - adapt (CH4): the task's next revision with notify under
//   `apply:<commandId>:<change>`, its notices inside the publication. With
//   an open or passed round, plan-execution D9 supersedes it after commit;
//   with no such round and a newest attempt, the held assignment
//   is superseded through the stop branch (after the notice) and one owed
//   `fix` row naming the new revisions is minted for the owed step — also
//   over an owed newest row, an owed fix keeping its answers;
// - restart (CH5): no task revision; the standing assignment and an open or
//   passed round superseded, the change back to `implementing`, and one owed
//   attempt row of the newest attempt's kind (an update restarts as `fix`);
// - added (CH7, CH8): a row `waiting`, or `landed` without ownership when a
//   landing fact exists; a name this run removed earlier restores its
//   cancelled row as fresh work;
// - removed, unlanded (CH9, CH10): `cancelled`, disowned, its pending
//   effects cancelled, the slot given up by the transition, and the prepared
//   task cancel committed — a task already closed keeps its status; the
//   publication row records the task the row carried, retired from then on.
// Nothing here dispatches: the executor acts on stored state after commit.
import { createHash } from 'node:crypto'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { TaskService } from '../../team/TaskService'
import type { AssignmentStore } from '../../team/assignmentStore'
import type { MailboxStore } from '../../team/mailboxStore'
import type { PreparedTaskStatus } from '../../team/taskStatusPrepared'
import { StaleTaskStatus } from '../../team/taskStatusPrepared'
import type { PlanRevision } from '../../../shared/plans'
import { manifestHashInput, type AttemptKind, type AttemptManifest } from '../../../shared/planExecution'
import type { DeltaChange, RevisionDelta } from '../../../shared/planRevisionControl'
import type { ExecutionStore } from '../execution/executionStore'
import type { ChangeRow, ExecutionRow } from '../execution/executionRows'
import { attemptStatus } from '../execution/attemptStatus'
import { cancelChangeEffects, disownChange, insertAddedChange, ownChange, reorderChanges, type ExecutionRevisionColumns } from '../execution/executionApplyStore'
import { implementTaskText } from '../execution/taskText'
import { PlanRefusal } from '../planCommands'
import type { NewPublicationChange } from './executionRevisionStore'
import type { AdaptHeadFacts } from './pauseResolve'

export interface ApplyWritesDeps {
  store: ExecutionStore
  tasks: TaskService
  assignments: AssignmentStore
  mailbox: MailboxStore
  sessionExists: (sessionId: string) => boolean
}

export interface ApplyWritesInput {
  team: TeamIdentity
  /** The execution as the transaction read it, before its revision advances. */
  execution: ExecutionRow
  target: PlanRevision
  delta: RevisionDelta
  commandId: string
  choices: Record<string, string>
  /** The Adapt text per adapted change: the owner's, else the generated one (D5). */
  adaptations: Record<string, string>
  rationale: string
  /** The revision columns the execution advances to (the new manifests name them). */
  next: ExecutionRevisionColumns
  /** The pre-transaction branch-head reads of the re-issued changes. */
  heads: ReadonlyMap<string, AdaptHeadFacts | null>
  /** The prepared task cancels of the removed changes, by task id. */
  prepared: ReadonlyMap<string, PreparedTaskStatus>
}

/** The request key of one adapted change's task publication (D7). */
export const applyRequestKey = (commandId: string, change: string): string => `apply:${commandId}:${change}`

const closed = (status: string | undefined): boolean => status === 'done' || status === 'cancelled'

/** Every change's writes, in the delta's order; the publication rows to record. */
export function applyWrites(deps: ApplyWritesDeps, input: ApplyWritesInput): NewPublicationChange[] {
  const publications: NewPublicationChange[] = []
  for (const entry of input.delta.changes) {
    const row = { change: entry.change, class: entry.class, fields: entry.fields, choice: null as string | null, taskId: null as string | null, taskRevision: null as number | null }
    if (entry.class === 'changed') {
      row.choice = entry.choice === 'needed' ? input.choices[entry.change]! : 'none'
      if (row.choice === 'adapt') Object.assign(row, adapt(deps, input, entry))
      if (row.choice === 'restart') restart(deps, input, entry)
    }
    if (entry.class === 'added') add(deps, input, entry)
    if (entry.class === 'removed') row.taskId = remove(deps, input, entry)
    publications.push(row)
  }
  reorderChanges(deps.store.db, input.execution.id, input.target.content.changes.map(change => change.change))
  return publications
}

function changeRowOf(deps: ApplyWritesDeps, input: ApplyWritesInput, change: string): ChangeRow {
  const row = deps.store.change(input.execution.id, change)
  if (row === null) throw new PlanRefusal('state', `Change ${change} has no row in execution ${input.execution.id}; nothing was applied.`)
  return row
}

/** CH4: the task's next revision with its notices; then the fix attempt's in-transaction part. */
function adapt(deps: ApplyWritesDeps, input: ApplyWritesInput, entry: DeltaChange): { taskId: string; taskRevision: number } {
  const changeRow = changeRowOf(deps, input, entry.change)
  const taskId = changeRow.taskId!
  const notices = deps.tasks.store.notices
  if (notices === null) throw new PlanRefusal('state', 'Revision notices are not available; the adaptation would leave its developer uninformed. Nothing was applied.')
  const targetEntry = input.target.content.changes.find(candidate => candidate.change === entry.change)!
  const requestKey = applyRequestKey(input.commandId, entry.change)
  const publication = deps.tasks.store.publish(taskId, {
    direction: input.adaptations[entry.change]!,
    acceptance: implementTaskText(targetEntry, input.target.content).acceptance,
    rationale: input.rationale,
    requestKey,
    notify: true,
    within: (next, current) => {
      notices.write(current, next, {
        requestKey,
        sender: { actor: { kind: 'human', sessionId: null }, fromGroup: null, originPath: input.team.groupsRoot },
        sessionExists: deps.sessionExists,
      })
    },
  }, { kind: 'human', sessionId: null })
  if (publication === null) throw new PlanRefusal('state', `The task of change ${entry.change} is missing; nothing was applied.`)
  const taskRevision = publication.revision.revision
  // The fix attempt: an open or passed round is D9's after commit; with no
  // such round, one owed fix row is minted here, after the notice, so a fix
  // follows in every state (review F3) — over the newest attempt, dispatched
  // or still owed, and also before the first attempt exists (the task is
  // attached, its implement dispatch still in flight: that dispatch's
  // transaction then finds a row and yields to the fix). An owed fix keeps
  // the answers it owed.
  const latest = deps.store.rounds(input.execution.id, entry.change).at(-1) ?? null
  const answeredByRound = latest !== null && (latest.outcome === null || latest.outcome === 'pass')
  const newest = deps.store.attempts(input.execution.id, entry.change).at(-1) ?? null
  if (!answeredByRound) {
    supersedeStanding(deps, taskId, `apply:${input.commandId}`)
    const answers = newest !== null && newest.kind === 'fix' && owed(deps, changeRow, newest) ? newest.manifest.answers : undefined
    reissue(deps, input, changeRow, 'fix', { id: taskId, revision: taskRevision }, answers)
  }
  return { taskId, taskRevision }
}

/** CH5: the standing work superseded and one owed attempt minted under the new revision. */
function restart(deps: ApplyWritesDeps, input: ApplyWritesInput, entry: DeltaChange): void {
  const changeRow = changeRowOf(deps, input, entry.change)
  const taskId = changeRow.taskId!
  const task = deps.tasks.store.get(taskId)
  if (task === null || task === undefined) throw new PlanRefusal('state', `The task of change ${entry.change} is missing; nothing was applied.`)
  supersedeStanding(deps, taskId, `apply:${input.commandId}`)
  const latest = deps.store.rounds(input.execution.id, entry.change).at(-1) ?? null
  if (latest !== null && (latest.outcome === null || latest.outcome === 'pass')) {
    deps.store.supersedeRound(latest.id)
    deps.store.cancelLiveRoundEffects(input.execution.id, latest.id)
  }
  const newest = deps.store.attempts(input.execution.id, entry.change).at(-1) ?? null
  const kind: AttemptKind = newest === null || newest.kind === 'update' ? 'fix' : newest.kind
  if (newest !== null) reissue(deps, input, changeRow, kind, { id: taskId, revision: task.revision })
}

/** Whether the attempt row was minted but never dispatched (the owed step's). */
function owed(deps: ApplyWritesDeps, changeRow: ChangeRow, attempt: Parameters<typeof attemptStatus>[0]): boolean {
  const keys = deps.assignments.listByTask(changeRow.taskId!).map(assignment => ({ requestKey: assignment.requestKey }))
  return attemptStatus(attempt, keys, deps.store.rounds(changeRow.executionId, changeRow.change)) === 'owed'
}

/**
 * The stop branch: the task's newest standing assignment supersedes, and its
 * instruction mail cancels while still queued or awaiting a request — a
 * claimed holder keeps its mail and reads the revision notice.
 */
function supersedeStanding(deps: ApplyWritesDeps, taskId: string, by: string): void {
  const standing = deps.assignments.listByTask(taskId).filter(assignment => assignment.supersededBy === null).at(-1)
  if (standing === undefined) return
  if (standing.messageId !== null) {
    const message = deps.mailbox.get(standing.messageId)
    if (message !== null && (message.state === 'queued' || message.state === 'awaiting-request')) {
      deps.mailbox.cancel(standing.messageId, { kind: 'system' }, `the owner's Apply (${by}) replaced the instruction`)
    }
  }
  deps.assignments.supersede(standing.id, by)
}

/**
 * One owed attempt row under the new revisions, moving the change back to
 * `implementing` (a gating or landing change first; the transition gives the
 * slot up). The branch head was read before the transaction; an unreadable
 * head refuses, retryable, with nothing written.
 */
function reissue(deps: ApplyWritesDeps, input: ApplyWritesInput, changeRow: ChangeRow, kind: AttemptKind, task: { id: string; revision: number },
  answers?: AttemptManifest['answers']): void {
  const fresh = deps.store.change(input.execution.id, changeRow.change)!
  if (fresh.state !== 'implementing' || fresh.step !== null) {
    if (!deps.store.transition(input.execution.id, changeRow.change, fresh, { state: 'implementing', step: null })) {
      throw new PlanRefusal('state', `Change ${changeRow.change} moved while Apply ran; nothing was applied.`)
    }
  }
  const facts = input.heads.get(changeRow.change) ?? null
  if (facts !== null && !facts.ok) {
    throw new PlanRefusal('state', `Change ${changeRow.change}'s branch head on origin could not be read; nothing was applied. Apply again once the git read succeeds.`)
  }
  const newest = deps.store.attempts(input.execution.id, changeRow.change).at(-1) ?? null
  const startCommit = facts !== null && facts.ok ? facts.startCommit : newest?.manifest.startCommit ?? changeRow.baselineCommit
  if (startCommit === null) throw new PlanRefusal('state', `Change ${changeRow.change} has no start commit; nothing was applied.`)
  const entry = input.target.content.changes.find(candidate => candidate.change === changeRow.change)!
  const manifest: AttemptManifest = {
    version: 1,
    plan: { id: input.execution.planId, revision: input.next.revision, contentHash: input.next.contentHash },
    execution: input.execution.id,
    task,
    validation: { reportId: input.next.reportId, inputHash: input.next.inputHash },
    baseline: changeRow.baselineCommit ?? '',
    startCommit,
    artifacts: facts !== null && facts.ok ? facts.artifacts : {},
    roleProfiles: input.target.content.roles.find(role => role.group === (changeRow.groupOverride ?? entry.group))?.profiles ?? [],
    ...(answers !== undefined ? { answers } : {}),
  }
  const manifestHash = createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
  deps.store.insertAttempt({ executionId: input.execution.id, change: changeRow.change, kind, assignmentId: null, manifest, manifestHash })
}

const unclaimed = (change: string): PlanRefusal => new PlanRefusal('precondition', `Change ${change} is owned by another running execution; nothing was applied.`,
  [{ name: 'changes-unclaimed', message: `Change ${change} is owned by another running execution.` }])

/**
 * CH7, CH8: the added change's row at its content position. A name an
 * earlier Apply of this run removed still has its cancelled row: it is
 * restored as fresh work — no task, PR, stop, or fix count, its generation
 * bumped — and owned again, the owner index refusing it while another
 * running execution owns the name. Its attempts and rounds stay as history
 * of the retired task (changeIncarnation.ts).
 */
function add(deps: ApplyWritesDeps, input: ApplyWritesInput, entry: DeltaChange): void {
  const landed = deps.store.landings(input.execution.planId).some(landing => landing.change === entry.change)
  const position = input.target.content.changes.findIndex(candidate => candidate.change === entry.change)
  const prior = deps.store.change(input.execution.id, entry.change)
  if (prior !== null && prior.state === 'cancelled') {
    const restored = deps.store.transition(input.execution.id, entry.change, prior, {
      state: landed ? 'landed' : 'waiting', step: null, stopReason: null, stopDetail: null, taskId: null, worktree: null, branch: null,
      baselineCommit: null, prNumber: null, prUrl: null, prOpenedByKawai: null, fixRounds: 0, passedAt: null, groupOverride: null,
    })
    if (restored === null) throw new PlanRefusal('state', `Change ${entry.change} moved while Apply ran; nothing was applied.`)
    if (!landed && !ownChange(deps.store.db, input.execution.id, entry.change)) throw unclaimed(entry.change)
    return
  }
  if (!insertAddedChange(deps.store.db, { executionId: input.execution.id, teamId: input.execution.teamId, change: entry.change, position, landed })) {
    throw unclaimed(entry.change)
  }
}

/** CH9, CH10: the removed, unlanded change cancelled with its open task; the task its row carried, which the publication row records as retired. */
function remove(deps: ApplyWritesDeps, input: ApplyWritesInput, entry: DeltaChange): string | null {
  const row = deps.store.change(input.execution.id, entry.change)
  if (row === null || row.state === 'landed' || row.state === 'cancelled') return null
  const cancel = () => {
    const current = deps.store.change(input.execution.id, entry.change)!
    if (!deps.store.transition(input.execution.id, entry.change, current, { state: 'cancelled', step: null })) {
      throw new PlanRefusal('state', `Change ${entry.change} moved while Apply ran; nothing was applied.`)
    }
    disownChange(deps.store.db, input.execution.id, entry.change)
    cancelChangeEffects(deps.store.db, input.execution.id, entry.change)
  }
  const status = row.taskId === null ? undefined : deps.tasks.store.get(row.taskId)?.status
  if (row.taskId === null || status === undefined || closed(status)) {
    cancel()
    return row.taskId
  }
  const prepared = input.prepared.get(row.taskId)
  // An open task the prepare phase did not prepare: it reopened meanwhile.
  if (prepared === undefined) throw new StaleTaskStatus(row.taskId, status)
  prepared.commit(cancel)
  return row.taskId
}
