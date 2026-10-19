// integration-candidates task 3.4: the `landings-on-base` pre-read over a
// local bare `origin`. A landing fact whose `merge_sha` the base head
// contains passes; one landed only on the integration branch is named with
// that branch; a plan with no landing facts, or a direct-only one whose
// facts are on the default branch, reads nothing off the base.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { readIntegrationStartFacts } from '../plans/landing/integration/integrationStart'

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

let root: string
let main: string
let onMaster: string
let onIntegration: string
let masterHead: string
let integrationHead: string
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-integration-start-')))
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  main = path.join(root, 'main')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, work], root)
  const commit = (file: string) => {
    fs.writeFileSync(path.join(work, file), `${file}\n`)
    git(['add', file], work)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', file], work)
    return git(['rev-parse', 'HEAD'], work)
  }
  onMaster = commit('a.txt')
  masterHead = commit('b.txt')
  git(['push', '-q', 'origin', 'master'], work)
  git(['checkout', '-q', '-b', 'wave/int'], work)
  onIntegration = commit('c.txt')
  integrationHead = onIntegration
  git(['push', '-q', 'origin', 'wave/int'], work)
  // The main checkout has never fetched wave/int: the pre-read's fetch brings it in.
  git(['clone', '-q', '--single-branch', '-b', 'master', origin, main], root)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const branches: Record<string, string> = { 'exec-direct': 'master', 'exec-int': 'wave/int' }

describe('readIntegrationStartFacts', () => {
  test('a landing only on the integration branch is off the default base, named with its branch', async () => {
    const facts = await readIntegrationStartFacts({
      main,
      probe: { base: { branch: 'master', head: masterHead, tree: 't' } },
      landings: [{ change: 'api', executionId: 'exec-direct', mergeSha: onMaster }, { change: 'ui', executionId: 'exec-int', mergeSha: onIntegration }],
      baseBranchOf: id => branches[id] ?? null,
      runningPromotion: null,
    })
    expect(facts.offBaseLandings).toEqual([{ change: 'ui', branch: 'wave/int' }])
  })

  test('the integration branch at its head contains both landings', async () => {
    const facts = await readIntegrationStartFacts({
      main,
      probe: { base: { branch: 'wave/int', head: integrationHead, tree: 't' }, integration: { branch: 'wave/int', target: 'master', exists: true } },
      landings: [{ change: 'api', executionId: 'exec-direct', mergeSha: onMaster }, { change: 'ui', executionId: 'exec-int', mergeSha: onIntegration }],
      baseBranchOf: id => branches[id] ?? null,
      runningPromotion: null,
    })
    expect(facts.offBaseLandings).toEqual([])
  })

  test('no landing facts, or direct-only facts on the default branch, pass; the running promotion is passed through', async () => {
    const promotion = { id: 'promo-1', number: 1, branch: 'wave/int', step: 'ci' }
    const none = await readIntegrationStartFacts({ main, probe: { base: { branch: 'master', head: masterHead, tree: 't' } }, landings: [], baseBranchOf: () => null, runningPromotion: promotion })
    expect(none).toEqual({ runningPromotion: promotion, offBaseLandings: [] })
    const direct = await readIntegrationStartFacts({
      main,
      probe: { base: { branch: 'wave/next', head: masterHead, tree: 't' }, integration: { branch: 'wave/next', target: 'master', exists: false } },
      landings: [{ change: 'api', executionId: 'exec-direct', mergeSha: onMaster }],
      baseBranchOf: id => branches[id] ?? null,
      runningPromotion: null,
    })
    expect(direct.offBaseLandings).toEqual([])
  })

  test('a base that cannot be fetched reports an error instead of a verdict', async () => {
    const facts = await readIntegrationStartFacts({
      main,
      probe: { base: { branch: 'no/such', head: masterHead, tree: 't' } },
      landings: [{ change: 'api', executionId: 'exec-direct', mergeSha: onMaster }],
      baseBranchOf: () => null,
      runningPromotion: null,
    })
    expect(facts.offBaseLandings).toEqual([])
    expect(facts.error).toContain('The base no/such could not be fetched')
  })

  test('an unknown merge sha reads as off the base, never as a pass', async () => {
    const facts = await readIntegrationStartFacts({
      main,
      probe: { base: { branch: 'master', head: masterHead, tree: 't' } },
      landings: [{ change: 'gone', executionId: 'exec-x', mergeSha: '0123456789abcdef0123456789abcdef01234567' }],
      baseBranchOf: () => null,
      runningPromotion: null,
    })
    expect(facts.offBaseLandings).toEqual([{ change: 'gone', branch: 'an unknown branch' }])
  })
})
