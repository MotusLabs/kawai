// The composed revision-control stack for the remainder's production-path
// tests (revision-control 9.2–9.3): `composePlanServices` with the team
// services over a plan bench — the construction the server runs — plus a
// ChatConnections over it, so a command reaches the composed services and
// every committed write pushes the subscribed detail. `inFlightTarget`
// stands one change of a running execution in an agent-held stage with a
// live, ready holder, as pauseTickComposition.test.ts does.
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import type { MailboxStore } from '../team/mailboxStore'
import { MemberRelease } from '../team/memberRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { ChatConnections } from '../chat/ChatConnections'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { composeExecutionCore, composePlanServices } from '../plans/planComposition'
import { pauseHolderFacts } from '../plans/revisionControl/pauseTick'
import type { FloorMap } from '../../shared/planExecution'
import type { ServerMessage } from '../../shared/types'
import { LEAD_ROLES } from './decisionHarness'
import { sessionRow, type PlanBench, type PlanWorld } from './planHarness'

export type ComposedStack = ReturnType<typeof composePlanServices> & {
  /** The connections over the composed services; `messages` collects what they send. */
  connections: ChatConnections
  messages: ServerMessage[]
  peer: { send: (message: ServerMessage) => void }
  /** The composition's ImpactService (the manager's `impact`). */
  impact: ImpactService
}

export const inDays = (days: number): string => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

/** The composed stack over the bench: core, team services, the runtime (started), and the connections. */
export async function composeStack(world: PlanWorld, bench: PlanBench, options: { monitor?: Parameters<typeof composePlanServices>[0]['monitor'] } = {}): Promise<ComposedStack> {
  const core = composeExecutionCore(bench.db.db)
  const mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  const tasks = new TaskService(bench.tasks, {
    getSession: id => bench.records.get(id), homeDir: world.home,
    restoreSession: () => undefined, plans: bench.plans, ownership: core.ownership,
  })
  const releases = new MemberRelease(bench.db.db, {
    store: mail, tasks: bench.tasks,
    records: () => bench.records.values(), getRecord: id => bench.records.get(id),
    teamOf: () => world.team,
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: () => undefined,
    hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: () => ({ ok: false as const, error: 'no archive in this test' }),
    notify: () => undefined,
  })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = () => world.team
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership: core.ownership,
  })
  const results = new TaskResultService(tasks, {
    getSession: id => bench.records.get(id), assignments,
    releases, records: () => bench.records.values(), homeDir: world.home,
    ownership: core.ownership, onWrite: taskId => core.wakes.resultWrite(taskId),
  })
  const impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail, getSession: id => bench.records.get(id),
  })
  const teamMailbox = new TeamMailbox(mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
  const composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact,
    getSession: id => bench.records.get(id),
    caps: { planExecution: async () => ({ floorChecks: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionCore: core,
    executionTeam: {
      tasks, assignments, results, taskStore: bench.tasks, mailbox: mail, teamMailbox, releases,
      pendingSpawns: () => [],
      records: () => bench.records.values(),
      identityOf: id => (id === world.team.teamId ? world.team : undefined),
      teamOfSession: teamOf,
      supervision: { holder: () => null, blocker: () => null, live: () => false },
      pauseFacts: pauseHolderFacts({
        getRecord: id => bench.records.get(id),
        pendingRequest: () => false, hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
        parkedResumes: () => [], cooldownUntil: () => null,
      }),
    },
    executionValidation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-1', inputHash: 'ih-1', readiness: { carriedConditions: [] } } }) as never,
    },
    ...(options.monitor ? { monitor: options.monitor } : {}),
  })
  bench.service = composed.plans
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId, world.otherTeam.teamId] })
  const manager = {
    whenRestored: () => Promise.resolve(), teamScopes, plans: composed.plans, executions: composed.executions,
    impact, validation: composed.validation, validationDetail: composed.validationDetail,
  } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager)
  const messages: ServerMessage[] = []
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
  await composed.runtime!.start()
  return { ...composed, connections, messages, peer: { send: message => { messages.push(message) } }, impact }
}

let counter = 0

/** An approved plan whose running execution stands `api` in flight (`attempt`: implementing; `review`: gating/reviewing), held by a live holder. */
export async function inFlightTarget(world: PlanWorld, bench: PlanBench, stack: ComposedStack, holder: string, stage: 'attempt' | 'review'): Promise<{ planId: string; executionId: string; taskId: string }> {
  const store = stack.executionStore
  for (const row of store.ownedChanges(world.team.teamId)) store.finishExecution(row.executionId, 'completed')
  const draft = await bench.draftInReview(LEAD_ROLES)
  const approved = await bench.approve(draft.planId, draft.revision, `approve-rc-stack-${++counter}`)
  if (!approved.ok) throw new Error(approved.message)
  const task = bench.tasks.create({ teamId: world.team.teamId, title: 'api work', direction: 'Build it', creator: { kind: 'human', sessionId: null } })
  const message = bench.mail.enqueue({
    teamId: world.team.teamId, toKind: 'session', toId: holder, fromKind: 'human', fromSession: null, fromGroup: null,
    originPath: world.repo, body: 'Build api.', taskId: task.id, actor: 'human',
  })
  const inserted = bench.assignmentStore.insert({
    teamId: world.team.teamId, taskId: task.id, requestKey: `rk-rc-stack-${counter}`, targetKind: 'session', targetId: holder,
    role: null, instruction: 'Build api.', creator: { kind: 'human', sessionId: null }, messageId: message.id,
  })
  settleReceipt(bench, message.id, holder)
  const execution = store.insertExecution({
    teamId: world.team.teamId, planId: draft.planId, revision: draft.revision, contentHash: 'hash-exec', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
  })
  const manifest = {
    version: 1 as const, plan: { id: 'p', revision: 1, contentHash: 'h' }, execution: 'e', task: { id: 't', revision: 1 },
    validation: { reportId: 'r', inputHash: 'i' }, baseline: 'b', startCommit: 's', artifacts: {}, roleProfiles: [],
  }
  store.insertAttempt({ executionId: execution.id, change: 'api', kind: 'implement', assignmentId: inserted.assignment.id, manifest, manifestHash: 'mh' })
  const row = store.change(execution.id, 'api')!
  const implementing = store.transition(execution.id, 'api', row, { state: 'implementing', worktree: world.repo, branch: 'api-branch', taskId: task.id })
  if (!implementing) throw new Error('the transition to implementing failed')
  if (stage === 'review' && !store.transition(execution.id, 'api', implementing, { state: 'gating', step: 'reviewing' })) {
    throw new Error('the transition to reviewing failed')
  }
  bench.records.set(holder, sessionRow(holder, 'leads', world.feature))
  return { planId: draft.planId, executionId: execution.id, taskId: task.id }
}

/** Settle a message's receipt the transcript would (the push and its acknowledgement). */
export function settleReceipt(bench: PlanBench, messageId: string, holder: string): void {
  bench.mail.claim(messageId, holder)
  bench.mail.markPushed(messageId)
  bench.mail.markDelivered(messageId)
}
