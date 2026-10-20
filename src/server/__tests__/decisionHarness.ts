// A bench for the decision tests (plan-supervision §5): the plan bench plus
// the real task, assignment, mailbox, and decision services over one
// database, and helpers that approve a plan with or without a Lead role and
// put a session on a task.
import type { ChatSessionRecord } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import type { MailboxStore } from '../team/mailboxStore'
import { TaskService } from '../team/TaskService'
import { TeamMailbox } from '../team/TeamMailbox'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { DecisionService } from '../plans/decisions/DecisionService'
import { decisionReplyGuard } from '../plans/decisions/decisionReplyGuard'
import { planInput } from '../../shared/__tests__/planFixtures'
import { createPlanBench, type PlanBench, type PlanWorld } from './planHarness'

export const LEAD_ROLES = { roles: [...(planInput().roles as unknown[]), { group: 'leads', profiles: ['opus'] }], leadGroup: 'leads' }

export interface DecisionBench extends PlanBench {
  mail: MailboxStore
  taskService: TaskService
  assignments: AssignmentService
  mailbox: TeamMailbox
  decisions: DecisionStore
  service: PlanBench['service']
  decide: DecisionService
  changes: string[]
  /** Approve a plan (with the Lead role unless `lead` is false) and return its id. */
  approvedPlan: (lead?: boolean) => Promise<string>
  /** Create a task of the plan's change as the human and put `session` on it. */
  onTask: (session: string, planId: string | null, change?: string) => Promise<string>
}

export function createDecisionBench(world: PlanWorld): DecisionBench {
  const bench = createPlanBench(world)
  const mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  const getSession = (id: string) => bench.records.get(id)
  const taskService = new TaskService(bench.tasks, { getSession, homeDir: world.home, plans: bench.plans })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = () => world.team
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees, spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession, records: () => bench.records.values(), teamOf, staffing, caps, worktrees, homeDir: world.home, plans: bench.plans,
  })
  const decisions = new DecisionStore(bench.db.db)
  // The production mailbox carries the decision reply guard (D9).
  const mailbox = new TeamMailbox(mail, { getSession, homeDir: world.home, tasks: bench.tasks, replyGuard: decisionReplyGuard(decisions) })
  const changes: string[] = []
  const decide = new DecisionService({
    db: bench.db.db, decisions, plans: bench.plans, planService: bench.service, tasks: taskService, taskStore: bench.tasks,
    assignments, mailbox, getSession, homeDir: world.home, onChange: planId => changes.push(planId),
  })
  return {
    ...bench, mail, taskService, assignments, mailbox, decisions, decide, changes,
    approvedPlan: async (lead = true) => {
      const { planId, revision } = await bench.draftInReview(lead ? LEAD_ROLES : {})
      const approved = await bench.approve(planId, revision)
      if (!approved.ok) throw new Error(approved.message)
      return planId
    },
    onTask: async (session, planId, change = 'api') => {
      const task = await taskService.create(bench.human, { title: `${change} task`, direction: 'Build', ...(planId ? { plan_id: planId, plan_change: change } : {}) })
      const record = bench.records.get(session) as ChatSessionRecord
      bench.records.set(session, { ...record, taskId: task.id })
      return task.id
    },
  }
}
