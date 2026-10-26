// Shared harness for the durable-plans service, tool, and connection tests:
// two git repositories (one with a linked worktree) built with cleanGitEnv,
// a fresh database per test, the task, strategy, and plan stores, and
// helpers that capture and approve strategies and drive a plan to review.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { cleanGitEnv } from '../git/gitCommand'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { AssignmentStore } from '../team/assignmentStore'
import { resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { StrategyStore } from '../strategy/strategyStore'
import { hashStrategyContent } from '../strategy/strategyHash'
import { normalizeStrategyContent } from '../../shared/productStrategy'
import { PlanStore } from '../plans/planStore'
import { PlanService } from '../plans/PlanService'
import { planInput } from '../../shared/__tests__/planFixtures'

export function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

export interface PlanWorld {
  root: string
  repo: string
  feature: string
  other: string
  home: string
  team: TeamIdentity
  otherTeam: TeamIdentity
}

export async function createPlanWorld(prefix: string): Promise<PlanWorld> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const repo = path.join(root, 'repo')
  const feature = path.join(root, 'repo-feature')
  const other = path.join(root, 'other')
  const home = path.join(root, 'home')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  const world = { root, repo, feature, other, home, team: await resolveTeam(repo), otherTeam: await resolveTeam(other) }
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\n---\nLead.')
  writeGroup(world, 'middle-devs', 'Build.')
  return world
}

export function writeGroup(world: PlanWorld, id: string, content: string, repo = world.repo) {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), content)
}

export const sessionRow = (sessionId: string, groupId: string | null, projectPath: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

export interface PlanBench {
  db: SessionDatabase
  tasks: TaskStore
  mail: MailboxStore
  assignmentStore: AssignmentStore
  strategies: StrategyStore
  plans: PlanStore
  service: PlanService
  records: Map<string, ChatSessionRecord>
  human: { kind: 'human'; team: TeamIdentity }
  agent: (sessionId: string) => { kind: 'agent'; sessionId: string }
  /** Create (as `lead`), save the fixture content, and submit; returns the plan id and revision. */
  draftInReview: (overrides?: Record<string, unknown>) => Promise<{ planId: string; revision: number; hash: string }>
  /** Approve the strategy revision with the given content; returns its number and hash. */
  approveStrategy: (content?: Record<string, unknown>) => { strategyId: string; revision: number; hash: string }
  /** Approve a plan revision as the human. */
  approve: (planId: string, revision: number, commandId?: string) => ReturnType<PlanService['approve']>
}

let benchCounter = 0

export function createPlanBench(world: PlanWorld, options: Partial<ConstructorParameters<typeof PlanService>[1]> = {}): PlanBench {
  const db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(world.root, 'db-')), 'plans.db') })
  const mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  const tasks = new TaskStore(db.db, mail, assignmentStore)
  const strategies = new StrategyStore(db.db)
  const plans = new PlanStore(db.db)
  const records = new Map<string, ChatSessionRecord>([
    ['lead', sessionRow('lead', 'leads', world.repo)],
    ['lead2', sessionRow('lead2', 'leads', world.feature)],
    ['dev', sessionRow('dev', 'middle-devs', world.feature)],
    ['stranger', sessionRow('stranger', 'leads', world.other)],
  ])
  const service = new PlanService(plans, { getSession: id => records.get(id), strategies, homeDir: world.home, ...options })
  const human = { kind: 'human' as const, team: world.team }
  const agent = (sessionId: string) => ({ kind: 'agent' as const, sessionId })
  const approve = (planId: string, revision: number, commandId = `approve-${++benchCounter}`) => service.approve(human, {
    planId, revision, contentHash: plans.revision(planId, revision)!.contentHash,
    expectedApprovedRevision: plans.get(planId)!.currentApprovedRevision, commandId,
  })
  return {
    db, tasks, mail, assignmentStore, strategies, plans, service, records, human, agent, approve,
    draftInReview: async (overrides = {}) => {
      const { plan } = await service.create(agent('lead'), { title: 'Wave C', content: planInput(overrides) })
      const submitted = await service.submit(agent('lead'), { plan_id: plan.id })
      if (!submitted.ok) throw new Error(submitted.message)
      return { planId: plan.id, revision: submitted.revision.revision, hash: submitted.revision.contentHash }
    },
    approveStrategy: (content = {}) => {
      const strategy = strategies.forTeam(world.team.teamId)
        ?? strategies.create({ productId: 'kawai', title: 'Kawai', owner: { kind: 'human', sessionId: null }, teamId: world.team.teamId, worktrees: [world.repo, world.feature] })
      const body = { useCases: [{ ref: 'UC1' }], principles: [{ ref: 'P4' }], decisions: [{ ref: 'D1' }], claims: [{ ref: 'C1', text: 'x', kind: 'hypothesis' }], ...content }
      const submitted = strategies.submitRevision(strategy.id, { author: { kind: 'human', sessionId: null }, content: body })
      if (!submitted.ok) throw new Error(submitted.message)
      const revision = submitted.revision.revision
      const hash = hashStrategyContent(normalizeStrategyContent(body))
      const approved = strategies.approve(strategy.id, {
        revision, contentHash: hash, commandId: `strategy-${++benchCounter}`,
        expectedCurrentRevision: strategies.get(strategy.id)!.currentApprovedRevision, actor: { kind: 'human', sessionId: null },
      })
      if (!approved.ok) throw new Error(approved.message)
      return { strategyId: strategy.id, revision, hash }
    },
  }
}
