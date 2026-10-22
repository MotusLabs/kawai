// Release worktree and hand off (task-results-handoffs design D7): the human
// frees a task's worktree for review. It composes two landed primitives and
// adds no lifecycle: team-member-release's readiness, archive, and system
// journal entry, and the review handoff (D3) through task-assignment's
// dispatch. The order is fixed — validate the review request; readiness-check
// every live spawned member of the task before archiving any (one not-ready
// member refuses the whole release, naming it and the blocking fact, with
// nothing archived or dispatched); archive each (never kill); then dispatch.
// A dispatch failure after the archive is surfaced with the release already
// done: archive is the human's intent and is never rolled back; Request
// review retries the dispatch alone. A review handoff of the result that
// already stands (queued behind the occupied worktree) is not doubled: the
// release frees the slot it waits for. Release is immediate — it refuses
// rather than defers, unlike the pending release a task close records.
import type { ChatSessionRecord } from '../db'
import { NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'
import type { TaskReleasePreview } from '../../shared/teamTasks'
import { loadGroupCatalog } from './groupCatalog'
import type { MemberRelease } from './memberRelease'
import type { HandoffOutcome, TaskResultService } from './TaskResultService'
import type { TaskCaller } from './TaskService'
import { worktreeRootOf } from './worktreeRoots'

export interface ReleaseRequest {
  /** The reviewer role: a group of the team. */
  target: string
  instructions: string
  expectedResponse?: string | null
  /** The human's client request key: a resend replays the handoff, never a second release. */
  requestKey: string
  /** The review's worker choice (dispatch-worker-choice D7), as on any handoff. */
  worker?: string
}

export interface ReleaseOutcome {
  /** The sessions this call archived (empty on a replay). */
  released: string[]
  handoff: HandoffOutcome
}

const RELEASE_DETAIL = ": worktree released for review at the human's request"

export class TaskRelease {
  constructor(private readonly results: TaskResultService, private readonly options: {
    releases: MemberRelease
    records: () => Iterable<ChatSessionRecord>
    homeDir?: string
    /** What a running execution owns (plan-execution D7); the default owns nothing. */
    ownership?: ExecutionOwnership
  }) {}

  /** The confirmation's data (D7): members to archive with their readiness, and the worktree's other live sessions. */
  preview(taskId: string): TaskReleasePreview {
    const task = this.results.tasks.store.get(taskId)
    const outstanding = this.results.tasks.store.results.outstanding(taskId)
    const members = this.options.releases.membersOf(taskId)
    const memberIds = new Set(members.map(member => member.sessionId))
    const others = task?.worktree
      ? [...this.options.records()].filter(record => record.archivedAt == null && !memberIds.has(record.sessionId) &&
        worktreeRootOf(record.projectPath) === task.worktree)
      : []
    return {
      members: members.map(member => {
        const readiness = this.options.releases.readiness(member.sessionId)
        return { sessionId: member.sessionId, name: member.name, ready: readiness.ready, reason: readiness.ready ? null : readiness.reason }
      }),
      others: others.map(record => ({ sessionId: record.sessionId, name: record.name })),
      outstandingResultId: outstanding?.id ?? null,
      unavailable: !task?.worktree ? 'The task has no worktree.'
        : !outstanding ? 'No result has been submitted yet.'
          : members.length === 0 ? 'No live spawned member holds the worktree; use Request review to dispatch the review.' : null,
    }
  }

  async release(caller: TaskCaller, taskId: string, request: ReleaseRequest): Promise<ReleaseOutcome> {
    if (caller.kind !== 'human') throw new Error("Release worktree and hand off is the human's; agents use release_member and task_handoff")
    const { team } = await this.results.tasks.context(caller)
    // While a running execution owns the change, its worktree is released
    // only through the execution's own landing — the human's release-and-hand-off
    // is refused too (plan-execution D7; the caller check above already keeps
    // agents and Kawai off this human-only path).
    const owner = (this.options.ownership ?? NULL_OWNERSHIP).ownerOfTask(taskId)
    if (owner !== null) {
      throw new Error(`The task is owned by a running execution (${owner.executionId}); close the task or stop the execution instead. Nothing was released.`)
    }
    const task = this.results.tasks.sameTeamTask(team, taskId)
    const outstanding = this.results.tasks.store.results.outstanding(taskId)
    const handoff = {
      kind: 'review' as const, resultId: outstanding?.id ?? '', target: { kind: 'group' as const, id: request.target },
      instructions: request.instructions, expectedResponse: request.expectedResponse ?? null, requestKey: request.requestKey,
      ...(request.worker !== undefined ? { worker: request.worker } : {}),
    }
    // A resend of a release that already dispatched replays its handoff — never a second release.
    const key = request.requestKey.trim()
    if (!key) throw new Error('A release needs a request key')
    if (this.results.tasks.store.assignmentsOf(taskId).some(row => row.requestKey === key)) {
      return { released: [], handoff: await this.results.handoff(caller, taskId, handoff) }
    }
    // 1. Validate the review request before anything is touched.
    if (!task.worktree) throw new Error('This task has no worktree to release.')
    if (!outstanding) throw new Error('No result has been submitted yet: there is nothing to hand to review.')
    const catalog = loadGroupCatalog({ groupsRoot: team.groupsRoot, ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}) })
    if (!catalog.groups.has(request.target)) throw new Error(`Unknown group: ${request.target}`)
    if (!request.instructions.trim()) throw new Error('A review request needs instructions')
    // 2. Readiness for every member first (team-member-release D3).
    const members = this.options.releases.membersOf(taskId)
    // Nobody left to release while a review of this result stands: a resend
    // after the standing-review path below (which records no key of its own)
    // replays that review rather than failing.
    if (members.length === 0 && this.standingReview(taskId, outstanding.id)) return { released: [], handoff: this.standingOutcome(taskId, outstanding.id) }
    if (members.length === 0) throw new Error('No live spawned member holds the worktree; nothing to release. Use Request review to dispatch the review.')
    const blocked = members.flatMap(member => {
      const readiness = this.options.releases.readiness(member.sessionId)
      return readiness.ready ? [] : [`${member.name} (${member.sessionId}): ${readiness.reason}`]
    })
    if (blocked.length > 0) {
      throw new Error(`Cannot release the worktree yet — nothing was archived or dispatched. ${blocked.join('; ')}. Retry once it has settled.`)
    }
    // 3. Archive each (never kill), journaled by kawai with this action's reason.
    const released: string[] = []
    for (const member of members) {
      const archived = this.options.releases.releaseNow(member.sessionId, RELEASE_DETAIL)
      if (!archived.ok) throw new Error(`Released ${released.length} of ${members.length}; ${member.name} (${member.sessionId}) could not be archived: ${archived.error}; no review was dispatched — retry to release the rest and dispatch it`)
      released.push(member.sessionId)
    }
    // 4. Dispatch the review handoff into the freed slot — unless one of this
    // result already stands (Request review queued it behind the occupied
    // worktree): the release frees the slot it waits for, and a second
    // review would double the reviewers.
    if (this.standingReview(taskId, outstanding.id)) return { released, handoff: this.standingOutcome(taskId, outstanding.id) }
    try {
      return { released, handoff: await this.results.handoff(caller, taskId, handoff) }
    } catch (error) {
      throw new Error(`The worktree was released (${released.join(', ')}), but the review dispatch failed: ` +
        `${error instanceof Error ? error.message : String(error)}. Use Request review to dispatch it.`)
    }
  }

  /** A review handoff of this result that still stands (D3's equivalence: not superseded, not failed). */
  private standingReview(taskId: string, resultId: string) {
    return this.results.tasks.store.assignmentsOf(taskId).find(row => row.handoffKind === 'review' &&
      row.resultId === resultId && row.supersededBy === null && row.state !== 'failed') ?? null
  }

  private standingOutcome(taskId: string, resultId: string): HandoffOutcome {
    const standing = this.standingReview(taskId, resultId)!
    return { assignment: standing, duplicate: true,
      notice: `The review handoff already queued for result ${resultId} (${standing.id}) proceeds in the freed worktree; nothing new was dispatched.` }
  }
}
