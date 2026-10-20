// The promotion parts as the production composition builds them once
// (integration-candidates D9, D10, X6; review I1): the slot holder kind
// `promotion` registered on the execution store (live while the promotion
// runs with no recorded merge; labelled by its promotion branch), the
// PromotionService the human commands go through, and the runner the
// executor ticks. `repoOf` reads origin's owner/repo from the team's main
// checkout once per team, as the executor does.
import { runGit } from '../../../git/gitCommand'
import type { TeamIdentity } from '../../../team/teamIdentity'
import type { PlanExecutionSettings } from '../../../team/teamCaps'
import type { ExecutionStore } from '../../execution/executionStore'
import type { InspectorReads } from '../../execution/effectInspectors'
import { startupReads } from '../../execution/startupReads'
import type { PlanService } from '../../PlanService'
import type { PlanStore } from '../../planStore'
import type { GhCommandOptions } from '../ghCommand'
import { githubRepoOf, type probeLanding } from '../landingProbe'
import type { IntegrationStore } from './integrationStore'
import type { PromotionAdapters } from './promotionEffects'
import { PROMOTION_HOLDER_KIND, type PromotionCore } from './promotionFinish'
import { PromotionRunner } from './promotionRunner'
import { PromotionService, type PromotionReads } from './PromotionService'

export interface PromotionCompositionOptions {
  integration: IntegrationStore
  executions: ExecutionStore
  plans: PlanService
  plansStore: PlanStore
  settings: { planExecution: (teamId: string) => Promise<PlanExecutionSettings> }
  identityOf: (teamId: string) => TeamIdentity
  /** Wakes the team's executor after a committed Promote or Cancel. */
  wake: (teamId: string) => void
  ghOptions?: GhCommandOptions
  probe?: typeof probeLanding
  reads?: PromotionReads
  adapters?: PromotionAdapters
  /** Test seam: the D14 inspection reads (default: strict gh/git startup reads). */
  inspectorReads?: InspectorReads
  /** Test seam: origin as owner/repo (a bench's origin is a local path). */
  repoOf?: (teamId: string) => string
  /** Test seam: the runner's clock (effect backoffs, CI windows). */
  now?: () => Date
}

export function composePromotions(options: PromotionCompositionOptions): { service: PromotionService; runner: PromotionRunner } {
  const { integration, executions } = options
  executions.registerHolderKind(
    PROMOTION_HOLDER_KIND,
    holderId => {
      const promotion = integration.promotion(holderId)
      return promotion !== null && promotion.state === 'running' && promotion.mergeSha === null
    },
    holderId => integration.promotion(holderId)?.promotionBranch ?? holderId,
  )
  const repos = new Map<string, string>()
  const repoOf = (teamId: string): string => {
    const cached = repos.get(teamId)
    if (cached !== undefined) return cached
    const remote = runGit(['config', '--get', 'remote.origin.url'], { cwd: options.identityOf(teamId).groupsRoot })
    const repo = remote.ok ? githubRepoOf(remote.stdout) ?? '' : ''
    repos.set(teamId, repo)
    return repo
  }
  const core: PromotionCore = { integration, executions, plans: options.plans, repoOf: options.repoOf ?? repoOf }
  const gh = options.ghOptions ? { ghOptions: options.ghOptions } : {}
  const service = new PromotionService({
    ...core, plansStore: options.plansStore, settings: options.settings, wake: options.wake, ...gh,
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.reads ? { reads: options.reads } : {}),
  })
  const runner = new PromotionRunner({
    ...core, teamOf: teamId => options.identityOf(teamId), inspectorReads: options.inspectorReads ?? startupReads(options.ghOptions), ...gh,
    ...(options.adapters ? { adapters: options.adapters } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  return { service, runner }
}
