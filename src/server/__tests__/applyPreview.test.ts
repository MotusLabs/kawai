// ApplyService.preview (plan-revision-apply D5, task 2.1) over real plan and
// execution stores, a git main checkout for the blob hashes, and a stub gh
// serving origin's tree: the agent refusal, another team's execution read as
// not found, the delta with its needed choices and generated Adapt texts,
// every precondition's standing, live merges counted only on changed or
// removed changes, the changes-on-base comparison narrowed to the added,
// adapted, and restarted changes, and no row written.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { cleanGitEnv } from '../git/gitCommand'
import { normalizePlanContent, type PlanChange } from '../../shared/plans'
import { PlanStore } from '../plans/planStore'
import { PlanService } from '../plans/PlanService'
import { StrategyStore } from '../strategy/strategyStore'
import { ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import type { ProbeResult } from '../plans/landing/landingProbe'
import { ApplyService } from '../plans/revisionControl/applyService'
import { schemaDb } from './schemaDb'

/** A change's proposal path inside a fixture repository (built, so the @reads guard does not read it as a repository read). */
const proposalOf = (change: string) => ['openspec', 'changes', change, 'proposal.md'].join('/')
const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

let root: string
let main: string
let db: Database
let plansStore: PlanStore
let executions: ExecutionStore
let service: ApplyService
let team: { teamId: string; groupsRoot: string }
let probeCalls: Array<{ main: string; changes: string[] }>
let planSerial = 0

const entry = (change: string, over: Partial<PlanChange> = {}) => ({ change, group: 'middle-devs', dependsOn: [], acceptance: [`${change} works`], extraChecks: [], guidance: '', ...over })
const contentOf = (changes: ReturnType<typeof entry>[], over: Record<string, unknown> = {}) => normalizePlanContent({
  goal: 'Ship it', successCriteria: ['It ships'], changes, roles: [{ group: 'middle-devs', profiles: [] }], landing: { mode: 'direct' },
  acceptanceRules: ['Plan rule'], ...over,
})

/**
 * A plan approved at revision 2 over a running execution of revision 1:
 * api landed, ui provisioned (a task), web waiting; revision 2 rewords ui
 * and web and adds docs.
 */
function runningPlan(): { planId: string; executionId: string } {
  // One team per plan: a change name is owned once per team across running executions.
  team = { teamId: `team-${++planSerial}`, groupsRoot: main }
  const planId = plansStore.insertPlan({ teamId: team.teamId, title: `P${planSerial}`, creator: { kind: 'human', sessionId: null } })
  const author = { kind: 'human' as const, sessionId: null }
  plansStore.atomically(() => plansStore.insertRevision(planId, { content: contentOf([entry('api'), entry('ui'), entry('web')]), contentHash: 'h1', pin: null, author }))
  plansStore.atomically(() => plansStore.insertRevision(planId, {
    content: contentOf([entry('api'), entry('ui', { guidance: 'Say more.' }), entry('web', { guidance: 'Wait.' }), entry('docs')]),
    contentHash: 'h2', pin: null, author,
  }))
  plansStore.setRevisionStatus(planId, 1, 'superseded')
  plansStore.setRevisionStatus(planId, 2, 'approved')
  plansStore.setCurrentApproved(planId, 2)
  const execution = executions.insertExecution({
    teamId: team.teamId, planId, revision: 1, contentHash: 'h1', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: FLOOR },
    maxParallel: 2, mergeMethod: 'merge',
    changes: [{ change: 'api', landed: true }, { change: 'ui', landed: false }, { change: 'web', landed: false }],
  })
  const ui = executions.change(execution.id, 'ui')!
  executions.transition(execution.id, 'ui', ui, { taskId: 'task-ui' })
  return { planId, executionId: execution.id }
}

const human = () => ({ kind: 'human' as const, team })

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-apply-preview-')))
  main = path.join(root, 'main')
  fs.mkdirSync(path.join(main, '.kawai', 'groups'), { recursive: true })
  git(['init', '-q', '-b', 'master', main], root)
  fs.writeFileSync(path.join(main, '.kawai', 'groups', 'middle-devs.md'), '---\nmax: 2\n---\nBuild.\n')
  for (const change of ['ui', 'web', 'docs']) {
    fs.mkdirSync(path.join(main, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(main, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  // origin's tree: web matches; ui and docs differ from the main checkout.
  const sha = (file: string) => git(['hash-object', file], main).trim()
  const tree = [
    { path: proposalOf('web'), sha: sha(proposalOf('web')), type: 'blob' },
    { path: proposalOf('ui'), sha: '0'.repeat(40), type: 'blob' },
  ]
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const treesFile = path.join(bin, 'trees.json')
  fs.writeFileSync(treesFile, JSON.stringify({ tree }))
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  "api repos/acme/app/git/trees/tree-1?recursive=1") cat "${treesFile}" ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })

  db = schemaDb(path.join(root, 'apply.db'))
  plansStore = new PlanStore(db)
  executions = new ExecutionStore(db)
  team = { teamId: path.join(main, '.git'), groupsRoot: main }
  probeCalls = []
  service = new ApplyService({
    store: executions,
    plansStore,
    plans: new PlanService(plansStore, { getSession: () => null, strategies: new StrategyStore(db) }),
    executionRevisions: new ExecutionRevisionStore(db),
    validation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-2', inputHash: 'ih-2', readiness: { carriedConditions: [] } } }),
    },
    impact: { gate: () => null },
    settings: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    probe: async input => {
      probeCalls.push({ main: input.main, changes: [...input.changes] })
      return { findings: [], repo: 'acme/app', base: { branch: 'master', head: 'head-1', tree: 'tree-1' } } satisfies ProbeResult
    },
    startFacts: async input => {
      expect(input.main).toBe(main)
      return { runningPromotion: null, offBaseLandings: [] }
    },
    ghOptions: { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } },
  })
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const counts = () => ({
  events: (db.prepare('SELECT count(*) AS n FROM plan_events').get() as { n: number }).n,
  revisions: (db.prepare('SELECT count(*) AS n FROM plan_execution_revisions').get() as { n: number }).n,
  publications: (db.prepare('SELECT count(*) AS n FROM plan_execution_publication_changes').get() as { n: number }).n,
  effects: (db.prepare('SELECT count(*) AS n FROM plan_execution_effects').get() as { n: number }).n,
})

describe('ApplyService.preview', () => {
  test('an agent caller is refused forbidden before any read', async () => {
    const { executionId } = runningPlan()
    probeCalls = []
    const outcome = await service.preview({ kind: 'agent', sessionId: 'chat-x' }, { executionId, revision: 2 })
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(probeCalls).toEqual([])
  })

  test('another team\'s execution reads as not found', async () => {
    const { executionId } = runningPlan()
    const outcome = await service.preview({ kind: 'human', team: { teamId: 'other-team', groupsRoot: main } }, { executionId, revision: 2 })
    expect(outcome).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('the preview lists each change\'s class and fields, asks a choice only for changed changes with tasks, and writes nothing', async () => {
    const { executionId } = runningPlan()
    const before = counts()
    const outcome = await service.preview(human(), { executionId, revision: 2 })
    if (!outcome.ok) throw new Error(outcome.message)
    const { preview } = outcome
    expect(preview).toMatchObject({ executionId, fromRevision: 1, revision: 2, contentHash: 'h2' })
    expect(preview.delta!.changes.map(change => [change.change, change.class, change.fields, change.choice])).toEqual([
      ['api', 'unchanged', [], null],
      ['ui', 'changed', ['guidance'], 'needed'],
      ['web', 'changed', ['guidance'], 'none'],
      ['docs', 'added', [], null],
    ])
    expect(preview.needed).toEqual(['ui'])
    // The generated Adapt text is the task text under the target revision (D5).
    expect(Object.keys(preview.adaptations)).toEqual(['ui'])
    expect(preview.adaptations.ui).toContain('The OpenSpec change "ui" is the authoritative direction')
    expect(preview.adaptations.ui).toContain('Say more.')
    // Every entry's standing, in list order: with no choices, only choices-complete fails,
    // and docs (added, not on origin) fails changes-on-base.
    expect(preview.standing.map(entry => entry.name)).toHaveLength(15)
    expect(preview.standing.filter(entry => entry.message !== null).map(entry => entry.name)).toEqual(['choices-complete', 'changes-on-base'])
    expect(preview.standing.find(entry => entry.name === 'changes-on-base')!.message).toContain(`docs: ${proposalOf('docs')}`)
    expect(preview.standing.find(entry => entry.name === 'changes-on-base')!.message).not.toContain('ui:')
    expect(counts()).toEqual(before)
  })

  test('changes-on-base reads only the added changes and the changed ones chosen adapt or restart', async () => {
    const { executionId } = runningPlan()
    const onBase = async (choices: Record<string, string>) => {
      const outcome = await service.preview(human(), { executionId, revision: 2, choices })
      if (!outcome.ok) throw new Error(outcome.message)
      return outcome.preview.standing.find(entry => entry.name === 'changes-on-base')!.message
    }
    const kept = await onBase({ ui: 'continue' })
    expect(kept).toContain('docs:')
    expect(kept).not.toContain('ui:')
    for (const choice of ['adapt', 'restart']) {
      const message = await onBase({ ui: choice })
      expect(message).toContain('docs:')
      expect(message).toContain(`ui: ${proposalOf('ui')}`)
    }
  })

  test('merge-quiet counts an in-flight merge on a changed change, never one on an unchanged change', async () => {
    const { executionId } = runningPlan()
    const standingOf = async () => {
      const outcome = await service.preview(human(), { executionId, revision: 2, choices: { ui: 'continue' } })
      if (!outcome.ok) throw new Error(outcome.message)
      return outcome.preview.standing.find(entry => entry.name === 'merge-quiet')!.message
    }
    executions.insertEffect({ executionId, change: 'api', roundId: null, kind: 'merge', effectKey: `k-api-${planSerial}`, command: {} })
    expect(await standingOf()).toBeNull()
    executions.insertEffect({ executionId, change: 'ui', roundId: null, kind: 'fast-forward', effectKey: `k-ui-${planSerial}`, command: {} })
    expect(await standingOf()).toContain('ui')
  })

  test('the probe reads the target revision\'s changes from the team\'s main checkout', async () => {
    const { executionId } = runningPlan()
    probeCalls = []
    await service.preview(human(), { executionId, revision: 2 })
    expect(probeCalls).toEqual([{ main, changes: ['api', 'ui', 'web', 'docs'] }])
  })
})
