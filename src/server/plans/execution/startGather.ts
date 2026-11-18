// Start's step-1 reads (plan-execution D4), shared with Apply's prepare
// phase (plan-revision-apply D3): the settings snapshot, the group files'
// role facts, the landing probe, the changes-on-base blob comparison, and
// integration-candidates D8's landings-on-base facts. Every read is async
// and writes nothing; the transaction that follows re-reads its own rows.
// `diffChanges` narrows the blob comparison: Start compares every change of
// the revision, Apply only the added, adapted, and restarted ones.
import type { TeamIdentity } from '../../team/teamIdentity'
import { loadGroupCatalog } from '../../team/groupCatalog'
import type { PlanRevision } from '../../../shared/plans'
import type { PlanExecutionSettings } from '../../team/teamCaps'
import type { ExecutionStore } from './executionStore'
import { compareWithOriginTree, probeLanding, validatedFilesOf, type ProbeResult } from '../landing/landingProbe'
import type { LandingMechanisms } from '../landing/landingMechanisms'
import { DIRECT_MECHANISMS, directMechanism } from '../landing/directMechanism'
import { ghTreeEntries } from '../landing/github'
import type { GhCommandOptions } from '../landing/ghCommand'
import type { StartCheckContext, StartRoleFact } from './startPreconditions'
import { readIntegrationStartFacts } from '../landing/integration/integrationStart'

/** What Start, its preview, and Apply read before any write (D4 step 1). */
export interface StartGather {
  probe: ProbeResult
  baseDiffs: Array<{ change: string; files: string[] }>
  roles: StartRoleFact[]
  landed: ReadonlySet<string>
  settings: PlanExecutionSettings
  /** integration-candidates D8: landing facts the base head lacks. */
  offBaseLandings: StartCheckContext['offBaseLandings']
}

export interface StartGatherDeps {
  store: ExecutionStore
  settings: { planExecution: (teamId: string) => Promise<PlanExecutionSettings> }
  /** The landing probe (D13); tests stub it, else the plan's mechanism probes. */
  probe?: typeof probeLanding
  mechanisms?: LandingMechanisms
  startFacts?: typeof readIntegrationStartFacts
  homeDir?: string
  ghOptions?: GhCommandOptions
}

/** The role facts of each change of a revision: its implementing group's file and the plan's role profiles. */
export function roleFacts(team: TeamIdentity, revisionRow: PlanRevision | null, homeDir?: string): StartRoleFact[] {
  const catalog = loadGroupCatalog({ groupsRoot: team.groupsRoot, ...(homeDir ? { homeDir } : {}) })
  return (revisionRow?.content.changes ?? []).map(entry => {
    const found = entry.group === null ? undefined : catalog.groups.get(entry.group)
    const groupProfiles = found ? (found.group.profiles.length > 0 ? found.group.profiles.map(profile => profile.profileId) : ['default']) : []
    const roleProfiles = revisionRow?.content.roles.find(role => role.group === entry.group)?.profiles ?? []
    return {
      change: entry.change,
      group: entry.group,
      groupKnown: found !== undefined,
      worktreeScoped: found?.group.worktreeScoped ?? true,
      sharedProfiles: roleProfiles.length > 0 ? roleProfiles.filter(profile => groupProfiles.includes(profile)) : groupProfiles,
    }
  })
}

/** The D4 step-1 reads: settings, group files, the probe, and the changes-on-base comparison. */
export async function gatherStart(deps: StartGatherDeps, team: TeamIdentity, planId: string, revisionRow: PlanRevision | null,
  diffChanges?: readonly string[]): Promise<StartGather> {
  const names = (revisionRow?.content.changes ?? []).map(entry => entry.change)
  const settings = await deps.settings.planExecution(team.teamId)
  const roles = roleFacts(team, revisionRow, deps.homeDir)
  const landings = deps.store.landings(planId)
  const landed = new Set(landings.map(landing => landing.change))
  const probeInput = { main: team.groupsRoot, floorChecks: settings.floorChecks, changes: names, provisioned: landed }
  const landing = revisionRow?.content.landing ?? { mode: 'direct' as const }
  // An unregistered mode is refused by landing-mode-supported; direct's checks still report the repository.
  const mechanism = (deps.mechanisms ?? DIRECT_MECHANISMS).get(landing.mode) ?? directMechanism
  const probe = deps.probe !== undefined
    ? await deps.probe(probeInput, deps.ghOptions ?? {})
    : await mechanism.probe({ ...probeInput, teamId: team.teamId, planId, landing }, deps.ghOptions ?? {})
  let baseDiffs: Array<{ change: string; files: string[] }> = []
  const compared = diffChanges ?? names
  if (probe.base !== null && probe.repo !== null && compared.length > 0) {
    const tree = await ghTreeEntries(probe.repo, probe.base.tree, deps.ghOptions ?? {})
    if (tree.ok) {
      const originTree = new Map(tree.data.map(entry => [entry.path, entry.sha]))
      const perChange = compared.map(change => ({ change, files: validatedFilesOf(team.groupsRoot, change) }))
      baseDiffs = await compareWithOriginTree(team.groupsRoot, originTree, perChange)
    }
  }
  const facts = await (deps.startFacts ?? readIntegrationStartFacts)({
    main: team.groupsRoot, probe, landings, runningPromotion: null,
    baseBranchOf: executionId => deps.store.execution(executionId)?.baseBranch ?? null,
  })
  const checked = facts.error === undefined ? probe : { ...probe, findings: [...probe.findings, { code: 'base-branch' as const, message: facts.error }] }
  return { probe: checked, baseDiffs, roles, landed, settings, offBaseLandings: facts.offBaseLandings }
}
