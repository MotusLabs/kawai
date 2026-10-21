// ExecutionService.start and preview (plan-execution D4) over a local bare
// `origin` behind a github-shaped remote URL (url.insteadOf), a stub gh, and
// a store-level plan bench: agent refusal, the lost-result replay, a payload
// mismatch named per field, racing Starts leaving one execution, a cross-plan
// owned change, landed changes starting landed, and Start writing no task
// and no mail.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { cleanGitEnv } from '../git/gitCommand'
import { normalizePlanContent } from '../../shared/plans'
import { PlanStore } from '../plans/planStore'
import { PlanService } from '../plans/PlanService'
import { StrategyStore } from '../strategy/strategyStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import { schemaDb } from './schemaDb'
import { ExecutionService } from '../plans/execution/ExecutionService'

const GITHUB_URL = 'https://github.com/acme/app.git'
const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

let root: string
let main: string
let db: Database
let plansStore: PlanStore
let executions: ExecutionStore
let service: ExecutionService
let wakes: string[]
let team: { teamId: string; groupsRoot: string }
let human: { kind: 'human'; team: typeof team }
let planSerial = 0

const contentOf = (changes: string[], group: string | null = 'middle-devs') => normalizePlanContent({
  goal: 'Ship it', successCriteria: ['It ships'],
  changes: changes.map(change => ({ change, group, dependsOn: [], acceptance: [], extraChecks: [], guidance: '' })),
  roles: [{ group: 'middle-devs', profiles: [] }],
  landing: { mode: 'direct' },
})

/** A plan with an approved revision over these changes; returns { planId, hash }. */
const approvedPlan = (changes: string[], group: string | null = 'middle-devs'): { planId: string; hash: string } => {
  const planId = plansStore.insertPlan({ teamId: team.teamId, title: `P${++planSerial}`, creator: { kind: 'human', sessionId: null } })
  const content = contentOf(changes, group)
  const hash = `h${planSerial}`
  const revision = plansStore.atomically(() => plansStore.insertRevision(planId, { content, contentHash: hash, pin: null, author: { kind: 'human', sessionId: null } }))
  plansStore.setRevisionStatus(planId, revision, 'approved')
  plansStore.setCurrentApproved(planId, revision)
  return { planId, hash }
}

const start = (planId: string, hash: string, commandId: string, revision = 1) =>
  service.start(human, { planId, revision, contentHash: hash, commandId })

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-exec-start-')))
  const origin = path.join(root, 'origin.git')
  main = path.join(root, 'main')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, main], root)
  fs.mkdirSync(path.join(main, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(main, '.kawai', 'groups', 'middle-devs.md'), '---\nmax: 2\n---\nBuild.\n')
  for (const change of ['api', 'ui']) {
    fs.mkdirSync(path.join(main, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(main, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(main, 'changes')
  git(['push', '-q', 'origin', 'master'], main)
  git(['remote', 'set-url', 'origin', GITHUB_URL], main)
  git(['config', `url.${origin}.insteadOf`, GITHUB_URL], main)

  // The stub gh's tree holds exactly what origin's master tree holds, so
  // changes-on-base sees equal content.
  const entries = git(['ls-tree', '-r', 'HEAD'], main).trim().split('\n').map(line => {
    const [meta, file] = line.split('\t')
    const sha = meta!.split(' ')[2]!
    return `{ "path": "${file}", "sha": "${sha}", "type": "blob" }`
  })
  const bin = path.join(root, 'bin')
  const treesFile = path.join(bin, 'trees.json')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(treesFile, `{ "tree": [${entries.join(', ')}] }`)
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"auth status"*) exit 0 ;;
  *"git/trees/"*) cat "${treesFile}" ;;
  *"git/commits/"*) printf '%s' '{"tree":{"sha":"ttt-0000"}}' ;;
  *"repos/acme/app"*) printf '%s' '{"default_branch":"master","permissions":{"push":true}}' ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }

  db = schemaDb(path.join(root, 'exec.db'))
  plansStore = new PlanStore(db)
  const plans = new PlanService(plansStore, { getSession: () => null, strategies: new StrategyStore(db) })
  executions = new ExecutionStore(db)
  team = { teamId: path.join(main, '.git'), groupsRoot: main }
  human = { kind: 'human' as const, team }
  wakes = []
  service = new ExecutionService({
    store: executions,
    plansStore,
    plans,
    validation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-1', inputHash: 'ih-1', readiness: { carriedConditions: [] } } }) as never,
    },
    impact: { gate: () => null },
    settings: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 3, mergeMethod: 'merge' }) },
    getSession: () => null,
    landingModes: () => new Set(['direct']),
    promotions: { runningPromotion: () => null },
    identityOf: () => team,
    executionRevisions: new ExecutionRevisionStore(db),
    wake: teamId => wakes.push(teamId),
    ghOptions: { env },
  })
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('ExecutionService.start', () => {
  test('an agent caller is refused and nothing is read or written', async () => {
    const refused = await service.start({ kind: 'agent', sessionId: 'dev' }, { planId: 'plan-x', revision: 1, contentHash: 'h', commandId: 'c' })
    expect(refused).toMatchObject({ ok: false, reason: 'forbidden' })
  })

  test('a precondition failure refuses Start writing nothing but the refusal', async () => {
    const { planId, hash } = approvedPlan(['api', 'ui'], null)
    const refused = await start(planId, hash, 'cmd-no-group')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('group')
    expect(executions.running(planId)).toBeNull()
    expect(executions.executionsOf(planId)).toEqual([])
  })

  test('a cross-plan owned change is refused naming the change', async () => {
    const other = approvedPlan(['own1'])
    const foreign = executions.insertExecution({
      teamId: team.teamId, planId: other.planId, revision: 1, contentHash: other.hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
      maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'own1', landed: false }],
    })
    const mine = approvedPlan(['own1', 'own2'])
    const refused = await start(mine.planId, mine.hash, 'cmd-cross')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('own1')
    expect(executions.running(mine.planId)).toBeNull()
    expect(executions.finishExecution(foreign.id, 'stopped', 'test')).toBe(true)
  })

  test('a lost result replays: the same payload returns the prior execution, once', async () => {
    const target = approvedPlan(['rep1', 'rep2'])
    const first = await start(target.planId, target.hash, 'cmd-replay')
    expect(first).toMatchObject({ ok: true, replayed: false })
    const again = await start(target.planId, target.hash, 'cmd-replay')
    expect(again).toMatchObject({ ok: true, replayed: true })
    if (first.ok && again.ok) expect(again.execution.id).toBe(first.execution.id)
    expect(executions.executionsOf(target.planId)).toHaveLength(1)
    expect(plansStore.events(target.planId).filter(event => event.kind === 'execution-started')).toHaveLength(1)
    expect(wakes).toEqual([team.teamId])
  })

  test('a different payload under the same command id is refused naming the field', async () => {
    const target = approvedPlan(['pay1', 'pay2'])
    const refused = { planId: target.planId, revision: 1, contentHash: 'not-the-hash', commandId: 'fresh' }
    await start(target.planId, target.hash, 'fresh')
    const outcome = await service.start(human, refused)
    expect(outcome).toMatchObject({ ok: false, reason: 'payload' })
    if (!outcome.ok) expect(outcome.message).toContain('contentHash')
  })

  test('a second Start while one runs is refused as one-execution; one execution stands', async () => {
    const target = approvedPlan(['one1', 'one2'])
    await start(target.planId, target.hash, 'first-start')
    const second = await start(target.planId, target.hash, 'second-start')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.message).toContain('running execution')
    expect(executions.executionsOf(target.planId)).toHaveLength(1)
  })

  test('a landed change starts landed owning nothing; no task and no mail is written; the floor snapshot is recorded', async () => {
    const target = approvedPlan(['docs', 'web'])
    executions.insertLanding({
      planId: target.planId, change: 'web', executionId: 'exec-earlier', teamId: team.teamId, mechanism: 'direct',
      // integration-candidates D8: a landing fact names a commit the base contains (landings-on-base).
      prNumber: 5, prUrl: 'u', headSha: 'h', baseSha: 'b', mergeSha: git(['rev-parse', 'origin/master'], main).trim(), treeVerified: true,
    })
    const started = await start(target.planId, target.hash, 'cmd-landed')
    expect(started.ok).toBe(true)
    if (started.ok) {
      const rows = executions.changes(started.execution.id)
      expect(rows.map(row => [row.change, row.state, row.owns])).toEqual([['docs', 'waiting', true], ['web', 'landed', false]])
      expect(started.execution).toMatchObject({ baseBranch: 'master', reportId: 'rep-1', inputHash: 'ih-1' })
      expect(started.execution.floor).toEqual({ version: 1, map: FLOOR })
    }
    const tasks = db.prepare('SELECT COUNT(*) AS n FROM team_tasks').get() as { n: number }
    const mail = db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }
    expect(tasks.n).toBe(0)
    expect(mail.n).toBe(0)
  })
})

describe('ExecutionService.start: landings-on-base (integration-candidates D8)', () => {
  test("a landing fact the base lacks refuses Start, naming the change and the branch it landed on; nothing is written", async () => {
    const target = approvedPlan(['docs', 'ui'])
    executions.insertLanding({
      planId: target.planId, change: 'ui', executionId: 'exec-elsewhere', teamId: team.teamId, mechanism: 'integration-branch',
      prNumber: 6, prUrl: 'u', headSha: 'h', baseSha: 'b', mergeSha: '0123456789abcdef0123456789abcdef01234567', treeVerified: true,
    })
    const before = executions.executionsOf(target.planId).length
    const refused = await start(target.planId, target.hash, 'cmd-off-base')
    expect(refused).toMatchObject({ ok: false, reason: 'precondition' })
    if (!refused.ok) {
      // The shared database's earlier Starts also claim docs; only this entry is the subject.
      expect(refused.failures?.map(failure => failure.name)).toContain('landings-on-base')
      expect(refused.message).toContain("The base master's head on origin lacks landed work: ui (landed on an unknown branch)")
    }
    expect(executions.executionsOf(target.planId)).toHaveLength(before)
  })
})

describe('ExecutionService.preview', () => {
  test('the same reads, no write: the standing and the probe base', async () => {
    const target = approvedPlan(['api', 'ui'])
    const view = await service.preview(human, { planId: target.planId, revision: 1 })
    expect(view.ok).toBe(true)
    if (view.ok) {
      expect(view.failures).toEqual([])
      expect(view.probe.base).toMatchObject({ branch: 'master' })
    }
    expect(executions.running(target.planId)).toBeNull()
    expect(plansStore.events(target.planId).filter(event => event.kind === 'execution-started')).toHaveLength(0)
  })
})
