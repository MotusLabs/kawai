// Shared harness for the strategy-revision-impact service, gate, request,
// tool, and connection tests: durable-plans' plan bench with the impact
// service supplying `pinDisposition`, the mailbox store the assessment
// request writes into, and helpers that put a plan into a review.
import { MailboxStore } from '../team/mailboxStore'
import { ImpactStore } from '../strategy/impactStore'
import { ImpactService } from '../strategy/ImpactService'
import { hashStrategyContent } from '../strategy/strategyHash'
import { normalizeStrategyContent } from '../../shared/productStrategy'
import { createPlanBench, writeGroup, type PlanBench, type PlanWorld } from './planHarness'

export interface ImpactBench extends PlanBench {
  impact: ImpactService
  mail: MailboxStore
  /** The current review's id (throws without one). */
  currentReviewId: () => string
  /** Strategy revision 1 approved, a plan approved under it, then revision 2 approved: the plan is affected. */
  affectedPlan: () => Promise<{ planId: string; reviewId: string; strategyId: string }>
  /** Withdraw a strategy revision as the human. */
  withdrawStrategy: (revision: number) => void
  /** Re-submit the lead's draft, pinning the plan to the current strategy; returns the new revision. */
  resubmit: (planId: string) => Promise<number>
  /** Give the other team its own strategy with revision 1 approved and an open review; returns that review's id. */
  approveOtherStrategy: () => string
  /** Row counts of the plan, task, mail, and spawn tables. */
  counts: () => Record<string, number>
}

let commandCounter = 0

export function createImpactBench(world: PlanWorld): ImpactBench {
  writeGroup(world, 'lead', 'Plans and reviews.')
  let impact: ImpactService | null = null
  const bench = createPlanBench(world, { pinDisposition: (planId, revision) => impact!.pinDisposition(planId, revision) })
  const mail = new MailboxStore(bench.db.db)
  impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail, getSession: id => bench.records.get(id), homeDir: world.home,
  })
  const service = impact
  const currentReviewId = () => {
    const id = service.detail(world.team.teamId)?.currentReviewId
    if (!id) throw new Error('no current review')
    return id
  }
  // A table this bench never creates (team_spawns: staffing owns it) counts as empty — nothing here can write it.
  const exists = (table: string) => bench.db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null
  const count = (table: string) => exists(table) ? (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n : 0
  return {
    ...bench, impact: service, mail, currentReviewId,
    affectedPlan: async () => {
      const { strategyId } = bench.approveStrategy()
      const { planId } = await bench.draftInReview()
      const approved = await bench.approve(planId, 1)
      if (!approved.ok) throw new Error(approved.message)
      bench.approveStrategy({ purpose: 'Revised direction' })
      return { planId, reviewId: currentReviewId(), strategyId }
    },
    withdrawStrategy: revision => {
      const strategy = bench.strategies.forTeam(world.team.teamId)!
      const outcome = bench.strategies.withdrawRevision(strategy.id, { revision, commandId: `withdraw-${++commandCounter}`, actor: { kind: 'human', sessionId: null } })
      if (!outcome.ok) throw new Error(outcome.message)
    },
    resubmit: async planId => {
      const submitted = await bench.service.submit(bench.agent('lead'), { plan_id: planId })
      if (!submitted.ok) throw new Error(submitted.message)
      return submitted.revision.revision
    },
    approveOtherStrategy: () => {
      const human = { kind: 'human' as const, sessionId: null }
      const strategy = bench.strategies.create({ productId: 'other', title: 'Other', owner: human, teamId: world.otherTeam.teamId, worktrees: [world.other] })
      const body = { purpose: 'Another product' }
      const submitted = bench.strategies.submitRevision(strategy.id, { author: human, content: body })
      if (!submitted.ok) throw new Error(submitted.message)
      const approved = bench.strategies.approve(strategy.id, {
        revision: submitted.revision.revision, contentHash: hashStrategyContent(normalizeStrategyContent(body)),
        commandId: `other-strategy-${++commandCounter}`, expectedCurrentRevision: null, actor: human,
      })
      if (!approved.ok) throw new Error(approved.message)
      const reviewId = service.detail(world.otherTeam.teamId)?.currentReviewId
      if (!reviewId) throw new Error('no review for the other team')
      return reviewId
    },
    counts: () => Object.fromEntries(['plans', 'plan_revisions', 'plan_events', 'team_tasks', 'team_messages', 'team_spawns'].map(table => [table, count(table)])),
  }
}
