// The development fixture's integration and promotion adapters
// (integration-candidates L2): ref writes on the fixture's real bare origin
// with GitHub's rules — a create refuses an existing ref, a fast-forward a
// non-descendant, both as 422, never forced — a promotion merge that writes
// a real two-parent merge commit onto the pull request's base, `gh pr close`
// on the registry, and the promotion probe and reads naming the fixture
// repository with merge commits allowed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGitChecked } from '../git/gitCommand'
import { fixtureProbe, fixtureRoundAdapters } from '../plans/execution/fixtureAdapters'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import type { ExecutionRow } from '../plans/execution/executionRows'
import { schemaDb } from './schemaDb'
import {
  FIXTURE_REPO, fixtureMechanisms, fixtureInspectorReads, fixturePromotionAdapters, fixturePromotionProbe, fixturePromotionReads, fixtureRefAdapters,
} from '../plans/landing/integration/fixtureIntegrationAdapters'

let root: string
let origin: string
let main: string
const git = (args: string[], cwd: string) => runGitChecked(args, { cwd }).trim()
const originHead = (branch: string) => git(['rev-parse', `refs/heads/${branch}`], origin)

function commit(file: string, text: string): string {
  fs.writeFileSync(path.join(main, file), text)
  git(['add', file], main)
  git(['-c', 'user.name=T', '-c', 'user.email=t@example.internal', 'commit', '-q', '-m', file], main)
  return git(['rev-parse', 'HEAD'], main)
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-fixture-integration-'))
  origin = path.join(root, 'origin.git')
  main = path.join(root, 'main')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['init', '-q', '-b', 'master', main], root)
  git(['remote', 'add', 'origin', origin], main)
  commit('a.txt', 'a\n')
  git(['push', '-q', 'origin', 'master'], main)
  // The probe records the fixture's main checkout, as Start and Promote do.
  expect((await fixtureProbe({ main })).findings).toEqual([])
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('fixture ref adapters (L2)', () => {
  test('createRef writes a new ref on origin; an existing one is refused as 422 and left alone', async () => {
    const refs = fixtureRefAdapters()
    const sha = originHead('master')
    expect(await refs.createRef('', 'wave/f1', sha)).toEqual({ ok: true, data: null })
    expect(originHead('wave/f1')).toBe(sha)
    const second = commit('b.txt', 'b\n')
    git(['push', '-q', 'origin', `${second}:refs/heads/scratch-f1`], main)
    const again = await refs.createRef('', 'wave/f1', second)
    expect(!again.ok && again.error.httpStatus).toBe(422)
    expect(originHead('wave/f1')).toBe(sha)
  })

  test('fastForwardRef moves a ref to a descendant; a non-descendant is refused as 422 and the ref stays', async () => {
    const refs = fixtureRefAdapters()
    const base = originHead('master')
    await refs.createRef('', 'wave/f2', base)
    git(['checkout', '-q', '-B', 'f2', base], main)
    const next = commit('c.txt', 'c\n')
    git(['push', '-q', 'origin', `${next}:refs/heads/scratch-f2`], main)
    expect(await refs.fastForwardRef('', 'wave/f2', next)).toEqual({ ok: true, data: null })
    expect(originHead('wave/f2')).toBe(next)
    const back = await refs.fastForwardRef('', 'wave/f2', base)
    expect(!back.ok && back.error.httpStatus).toBe(422)
    expect(originHead('wave/f2')).toBe(next)
  })
})

describe('fixture promotion adapters (L2)', () => {
  test('a promotion merge writes a two-parent merge commit onto the base; gh pr close closes the registry row', async () => {
    const adapters = fixturePromotionAdapters()
    const base = originHead('master')
    git(['checkout', '-q', '-B', 'p1', base], main)
    const head = commit('p.txt', 'p\n')
    git(['push', '-q', 'origin', `${head}:refs/heads/wave/p--promote-1`], main)
    const opened = await adapters.rounds.prCreate(FIXTURE_REPO, { head: 'wave/p--promote-1', base: 'master', title: 't', body: 'b' })
    if (!opened.ok) throw new Error(opened.error.message)
    expect(await adapters.landing.prMerge(FIXTURE_REPO, opened.data.number, 'merge', head)).toEqual({ ok: true, data: null })
    const merged = originHead('master')
    expect(git(['rev-list', '--parents', '-n', '1', merged], origin).split(' ').slice(1)).toEqual([base, head])
    const view = await adapters.landing.prView(FIXTURE_REPO, opened.data.number)
    expect(view.ok && view.data).toMatchObject({ state: 'MERGED', mergeCommit: merged, headRefOid: head })

    const other = await adapters.rounds.prCreate(FIXTURE_REPO, { head: 'wave/p--promote-2', base: 'master', title: 't', body: 'b' })
    if (!other.ok) throw new Error(other.error.message)
    expect(await adapters.prClose(FIXTURE_REPO, other.data.number, 'closed')).toEqual({ ok: true, data: null })
    const listed = await fixtureInspectorReads().prList(FIXTURE_REPO, 'wave/p--promote-2', 'master')
    expect(listed.map(pull => pull.state)).toEqual(['CLOSED'])
  })

  test('the promotion probe names the fixture repository and its reads allow merge commits', async () => {
    const probe = await fixturePromotionProbe({ main })
    expect(probe).toMatchObject({ findings: [], repo: FIXTURE_REPO, base: { branch: 'master' } })
    expect(await fixturePromotionReads().allowMergeCommit(FIXTURE_REPO)).toBe(true)
    expect((await fixtureRoundAdapters().checkRuns(FIXTURE_REPO, 'x')).ok).toBe(true)
  })
})

describe('the fixture landing registry (L2)', () => {
  test('integration probes without gh: a missing branch bases on the default head and Start queues create-integration naming the fixture repository', async () => {
    const mechanisms = fixtureMechanisms(new IntegrationStore(schemaDb()))
    const master = originHead('master')
    const input = { main, floorChecks: null, changes: ['c1'], provisioned: new Set<string>(), teamId: 't', planId: 'p' }
    const probe = await mechanisms.get('integration-branch')!.probe({ ...input, landing: { mode: 'integration-branch', branch: 'wave/new' } })
    expect(probe).toEqual({ findings: [], repo: null, base: { branch: 'wave/new', head: master, tree: '' }, integration: { branch: 'wave/new', target: 'master', exists: false } })
    const execution = { id: 'e1', planId: 'p', teamId: 't', baseCommit: master } as unknown as ExecutionRow
    const effects = mechanisms.get('integration-branch')!.startEffects!({ execution, probe, main })
    expect(effects).toEqual([{ kind: 'create-integration', effectKey: 'e1::create-integration:1', command: expect.objectContaining({ repo: FIXTURE_REPO, branch: 'wave/new', sha: master, target: 'master' }) }])
    // A branch already on origin that no record of this plan holds is refused, as on GitHub.
    const taken = await mechanisms.get('integration-branch')!.probe({ ...input, landing: { mode: 'integration-branch', branch: 'wave/f1' } })
    expect(taken.findings.map(finding => finding.code)).toEqual(['integration-branch'])
    // Direct probes through the fixture probe too: no gh, the default base.
    expect(await mechanisms.get('direct')!.probe({ ...input, landing: { mode: 'direct' } })).toEqual({ findings: [], repo: null, base: { branch: 'master', head: master, tree: '' } })
  })
})
