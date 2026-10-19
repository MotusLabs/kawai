// ExecutionService.start for integration plans (integration-candidates 3.2,
// 3.4) over a local bare `origin` behind a github-shaped URL and a stub gh
// whose trees are answered per commit: the integration branch recorded as
// the base with the default branch as target, `landing-mode-supported`, and
// `changes-on-base` read at the integration head (or the default head while
// the branch is missing); `promotion-idle` against the real integration
// store; `landings-on-base` when a plan switches to direct before and after
// its integration landings reached the default branch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { cleanGitEnv } from '../git/gitCommand'
import { normalizePlanContent, type PlanLanding } from '../../shared/plans'
import { PlanStore } from '../plans/planStore'
import { PlanService } from '../plans/PlanService'
import { StrategyStore } from '../strategy/strategyStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ExecutionService } from '../plans/execution/ExecutionService'
import { directMechanism } from '../plans/landing/directMechanism'
import { applyIntegrationSchema } from '../plans/landing/integration/integrationSchema'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { integrationMechanism } from '../plans/landing/integration/integrationMechanism'
import { schemaDb } from './schemaDb'

const GITHUB_URL = 'https://github.com/acme/app.git'
const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
const commitAll = (cwd: string, message: string): string => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
  return git(['rev-parse', 'HEAD'], cwd)
}

let root: string
let main: string
let origin: string
let bin: string
let db: Database
let plansStore: PlanStore
let executions: ExecutionStore
let integration: IntegrationStore
let service: ExecutionService
let deps: ConstructorParameters<typeof ExecutionService>[0]
let team: { teamId: string; groupsRoot: string }
let human: { kind: 'human'; team: typeof team }
let serial = 0

/** The stub gh's tree for a commit: what `git ls-tree` lists there. */
function writeTree(sha: string): void {
  const entries = git(['ls-tree', '-r', sha], main).split('\n').map(line => {
    const [meta, file] = line.split('\t')
    return `{ "path": "${file}", "sha": "${meta!.split(' ')[2]!}", "type": "blob" }`
  })
  fs.writeFileSync(path.join(bin, `tree-${sha}.json`), `{ "tree": [${entries.join(', ')}] }`)
}

const approvedPlan = (changes: string[], landing: PlanLanding): { planId: string; hash: string } => {
  const planId = plansStore.insertPlan({ teamId: team.teamId, title: `P${++serial}`, creator: { kind: 'human', sessionId: null } })
  return { planId, hash: approveRevision(planId, changes, landing) }
}
const approveRevision = (planId: string, changes: string[], landing: PlanLanding): string => {
  const content = normalizePlanContent({
    goal: 'Ship it', successCriteria: ['It ships'], landing,
    changes: changes.map(change => ({ change, group: 'middle-devs', dependsOn: [], acceptance: [], extraChecks: [], guidance: '' })),
    roles: [{ group: 'middle-devs', profiles: [] }],
  })
  const hash = `h${++serial}`
  const revision = plansStore.atomically(() => plansStore.insertRevision(planId, { content, contentHash: hash, pin: null, author: { kind: 'human', sessionId: null } }))
  if (revision > 1) plansStore.setRevisionStatus(planId, revision - 1, 'superseded')
  plansStore.setRevisionStatus(planId, revision, 'approved')
  plansStore.setCurrentApproved(planId, revision)
  return hash
}
const start = (planId: string, hash: string, revision = 1) =>
  service.start(human, { planId, revision, contentHash: hash, commandId: `start-${++serial}` })

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-integration-start-svc-')))
  origin = path.join(root, 'origin.git')
  main = path.join(root, 'main')
  bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, main], root)
  fs.mkdirSync(path.join(main, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(main, '.kawai', 'groups', 'middle-devs.md'), '---\nmax: 2\n---\nBuild.\n')
  for (const change of ['api', 'ui', 'docs', 'web', 'cli', 'lib']) {
    fs.mkdirSync(path.join(main, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(main, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  writeTree(commitAll(main, 'changes'))
  git(['push', '-q', 'origin', 'master'], main)
  git(['remote', 'set-url', 'origin', GITHUB_URL], main)
  git(['config', `url.${origin}.insteadOf`, GITHUB_URL], main)
  // A commit's tree is the commit itself; each tree answers from its file.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"auth status"*) exit 0 ;;
  *"git/trees/"*) sha=$(printf '%s' "$*" | sed -n 's#.*git/trees/\\([0-9a-f]*\\).*#\\1#p'); cat "${bin}/tree-$sha.json" ;;
  *"git/commits/"*) sha=$(printf '%s' "$*" | sed -n 's#.*git/commits/\\([0-9a-f]*\\).*#\\1#p'); printf '{"tree":{"sha":"%s"}}' "$sha" ;;
  *"repos/acme/app"*) printf '%s' '{"default_branch":"master","permissions":{"push":true}}' ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }

  db = schemaDb(path.join(root, 'exec.db'))
  applyIntegrationSchema(db)
  plansStore = new PlanStore(db)
  executions = new ExecutionStore(db)
  integration = new IntegrationStore(db)
  team = { teamId: path.join(main, '.git'), groupsRoot: main }
  human = { kind: 'human' as const, team }
  const mechanisms = new Map([['direct', directMechanism], ['integration-branch', integrationMechanism(integration)]])
  deps = {
    store: executions, plansStore,
    plans: new PlanService(plansStore, { getSession: () => null, strategies: new StrategyStore(db) }),
    validation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-1', inputHash: 'ih-1', readiness: { carriedConditions: [] } } }) as never,
    },
    impact: { gate: () => null },
    settings: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 3, mergeMethod: 'merge' }) },
    getSession: () => null,
    landingModes: () => new Set(mechanisms.keys()),
    mechanisms,
    promotions: { runningPromotion: planId => integration.runningPromotion(planId) },
    identityOf: () => team,
    ghOptions: { env },
  }
  service = new ExecutionService(deps)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const failures = (outcome: Awaited<ReturnType<typeof start>>) => (outcome.ok ? [] : (outcome as { failures?: Array<{ name: string; message: string }> }).failures ?? [])
const masterHead = () => git(['rev-parse', 'origin/master'], main)

describe('Start an integration plan (3.2, D2)', () => {
  test('a missing branch: the integration branch is the base, the default head its commit, create-integration targets the default branch', async () => {
    git(['fetch', '-q', 'origin'], main)
    const { planId, hash } = approvedPlan(['api'], { mode: 'integration-branch', branch: 'wave/one' })
    const started = await start(planId, hash)
    expect(failures(started)).toEqual([])
    expect(started.ok).toBe(true)
    const execution = executions.executionsOf(planId).at(-1)!
    expect(execution).toMatchObject({ landingMode: 'integration-branch', baseBranch: 'wave/one', baseCommit: masterHead() })
    const effects = executions.effectsOf(execution.id)
    expect(effects.map(effect => [effect.kind, effect.change, effect.effectKey])).toEqual([['create-integration', null, `${execution.id}::create-integration:1`]])
    expect(effects[0]!.command).toMatchObject({ branch: 'wave/one', sha: masterHead(), target: 'master', planId })
  })

  test('an existing branch with this plan\'s record: changes-on-base reads the integration head, not the default head', async () => {
    const { planId, hash } = approvedPlan(['web', 'cli'], { mode: 'integration-branch', branch: 'wave/two' })
    // The integration branch lacks cli's artifacts; the default branch has them.
    git(['checkout', '-q', '-b', 'wave/two', 'origin/master'], main)
    fs.rmSync(path.join(main, 'openspec', 'changes', 'cli'), { recursive: true })
    const head = commitAll(main, 'drop cli')
    writeTree(head)
    git(['push', '-q', 'origin', 'wave/two'], main)
    git(['checkout', '-q', 'master'], main)
    git(['reset', '-q', '--hard', 'origin/master'], main)
    integration.recordCreation({ teamId: team.teamId, branch: 'wave/two', planId, targetBranch: 'master', executionId: 'exec-earlier', sha: masterHead() })
    const refused = await start(planId, hash)
    expect(failures(refused).map(failure => failure.name)).toContain('changes-on-base')
    expect(failures(refused).find(failure => failure.name === 'changes-on-base')!.message).toContain('cli')
    expect(failures(refused).map(failure => failure.name)).not.toContain('landing-mode-supported')
    expect(executions.executionsOf(planId)).toEqual([])
  })

  test('landing-mode-supported refuses when the integration mechanism is not registered', async () => {
    const only = new ExecutionService({ ...deps, landingModes: () => new Set(['direct']) })
    const { planId, hash } = approvedPlan(['docs'], { mode: 'integration-branch', branch: 'wave/three' })
    const refused = await only.start(human, { planId, revision: 1, contentHash: hash, commandId: `start-${++serial}` })
    expect(failures(refused).map(failure => failure.name)).toContain('landing-mode-supported')
  })
})

describe('promotion-idle and landings-on-base (3.4, D8)', () => {
  test('a running promotion refuses naming it and its step; a finished one passes', async () => {
    const { planId, hash } = approvedPlan(['lib'], { mode: 'integration-branch', branch: 'wave/four' })
    const promotion = integration.insertPromotion({
      teamId: team.teamId, planId, branch: 'wave/four', commandId: 'promote-1', fromSha: masterHead(), throughSeq: 0,
      targetBranch: 'master', floor: FLOOR,
    })
    integration.patchPromotion(promotion.id, { step: 'ci' })
    const refused = await start(planId, hash)
    const failure = failures(refused).find(entry => entry.name === 'promotion-idle')!
    expect(failure.message).toContain(promotion.id)
    expect(failure.message).toContain('ci')
    integration.finishPromotion(promotion.id, 'cancelled')
    expect(failures(await start(planId, hash)).map(entry => entry.name)).not.toContain('promotion-idle')
  })

  test('switching to direct before promotion refuses naming the change and the integration branch; after promotion it passes', async () => {
    const { planId } = approvedPlan(['ui'], { mode: 'integration-branch', branch: 'wave/five' })
    // An earlier integration execution landed ui on wave/five only.
    git(['checkout', '-q', '-b', 'wave/five', 'origin/master'], main)
    fs.writeFileSync(path.join(main, 'ui.txt'), 'ui\n')
    const landed = commitAll(main, 'ui lands')
    git(['push', '-q', 'origin', 'wave/five'], main)
    git(['checkout', '-q', 'master'], main)
    const earlier = executions.insertExecution({
      teamId: team.teamId, planId, revision: 1, contentHash: 'h-earlier', reportId: 'r', inputHash: 'i',
      landingMode: 'integration-branch', baseBranch: 'wave/five', baseCommit: masterHead(), floor: { version: 1, map: FLOOR },
      maxParallel: 1, mergeMethod: 'merge', changes: [{ change: 'ui', landed: false }],
    })
    executions.insertLanding({ planId, change: 'ui', executionId: earlier.id, teamId: team.teamId, mechanism: 'integration-branch', prNumber: null, prUrl: null, headSha: landed, baseSha: masterHead(), mergeSha: landed, treeVerified: true })
    executions.finishExecution(earlier.id, 'stopped')
    const directHash = approveRevision(planId, ['ui'], { mode: 'direct' })
    const refused = await start(planId, directHash, 2)
    const failure = failures(refused).find(entry => entry.name === 'landings-on-base')!
    expect(failure.message).toContain('ui (landed on wave/five)')
    expect(executions.executionsOf(planId).length).toBe(1)
    // Promotion brought wave/five onto master.
    git(['merge', '-q', '--ff-only', landed], main)
    writeTree(landed)
    git(['push', '-q', 'origin', 'master'], main)
    const passed = await start(planId, directHash, 2)
    expect(failures(passed).map(entry => entry.name)).not.toContain('landings-on-base')
  })
})
