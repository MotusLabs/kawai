// integration-candidates task 3.1: the integration branch rules of the
// landing probe (D2). It runs over a local bare `origin`, reached through a
// github-shaped remote URL rewritten with `url.<path>.insteadOf`, and a stub
// gh. Four cases each refuse `landing-ready`, naming the branch:
// - the default branch;
// - a change name of the plan;
// - an origin branch without a record;
// - another plan's record.
// The probe creates no ref.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { IntegrationBranchRecord } from '../../shared/planIntegration'
import { probeIntegrationLanding, type IntegrationProbeInput } from '../plans/landing/integration/integrationProbe'

const GITHUB_URL = 'https://github.com/acme/app.git'
const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

let root: string
let origin: string
let main: string
let env: Record<string, string>
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-integration-probe-')))
  origin = path.join(root, 'origin.git')
  main = path.join(root, 'main')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, main], root)
  fs.writeFileSync(path.join(main, 'seed.txt'), 'seed\n')
  git(['add', '-A'], main)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'seed'], main)
  git(['push', '-q', 'origin', 'master'], main)
  git(['remote', 'set-url', 'origin', GITHUB_URL], main)
  git(['config', `url.${origin}.insteadOf`, GITHUB_URL], main)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"auth status"*) exit 0 ;;
  *"git/commits/"*) sha=$(printf '%s' "$*" | sed 's#.*git/commits/\\([0-9a-f]*\\).*#\\1#'); printf '{"tree":{"sha":"tree-%s"}}' "$sha" ;;
  *"repos/acme/app"*) printf '%s' '{"default_branch":"master","permissions":{"push":true}}' ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const record = (planId: string, branch: string): IntegrationBranchRecord =>
  ({ teamId: 'team', branch, planId, targetBranch: 'master', createdBy: 'exec-0', createdSha: 'x', createdAt: 'now' })

function probe(input: Partial<IntegrationProbeInput>) {
  return probeIntegrationLanding({
    main, floorChecks: FLOOR, changes: ['alpha'], provisioned: new Set(),
    teamId: 'team', planId: 'plan-1', branch: 'wave/int', record: () => null, ...input,
  }, { env })
}

const refs = () => git(['for-each-ref', '--format=%(refname) %(objectname)'], origin) + git(['for-each-ref', '--format=%(refname)'], main)

describe('probeIntegrationLanding', () => {
  test('a missing branch passes: the base is the integration branch at the default head', async () => {
    const before = refs()
    const result = await probe({})
    expect(result.findings).toEqual([])
    const head = git(['rev-parse', 'master'], origin).trim()
    expect(result.base).toEqual({ branch: 'wave/int', head, tree: `tree-${head}` })
    expect(result.integration).toEqual({ branch: 'wave/int', target: 'master', exists: false })
    expect(refs()).toBe(before)
  })

  test('the default branch named as integration branch refuses, naming it', async () => {
    const result = await probe({ branch: 'master', record: () => record('plan-1', 'master') })
    expect(result.findings.map(finding => finding.code)).toEqual(['integration-branch'])
    expect(result.findings[0]!.message).toContain('"master" is the repository\'s default branch')
  })

  test('a change name of the plan refuses, naming it', async () => {
    const result = await probe({ branch: 'alpha' })
    expect(result.findings.map(finding => finding.message).join(' ')).toContain('"alpha" is also a change name')
  })

  test('a branch made by hand, with no record, refuses and is left untouched', async () => {
    git(['push', '-q', 'origin', 'master:refs/heads/hand/int'], main)
    const before = refs()
    const result = await probe({ branch: 'hand/int' })
    expect(result.findings.map(finding => finding.code)).toEqual(['integration-branch'])
    expect(result.findings[0]!.message).toContain('"hand/int" already exists on origin')
    expect(refs()).toBe(before)
  })

  test("another plan's record refuses, naming the branch and that plan", async () => {
    const result = await probe({ record: () => record('plan-other', 'wave/int') })
    expect(result.findings.map(finding => finding.code)).toEqual(['integration-branch'])
    expect(result.findings[0]!.message).toContain('"wave/int" belongs to another plan (plan-other)')
  })

  test("this plan's existing branch passes at its own head", async () => {
    git(['push', '-q', 'origin', 'master:refs/heads/own/int'], main)
    const head = git(['rev-parse', 'refs/heads/own/int'], origin).trim()
    const result = await probe({ branch: 'own/int', record: () => record('plan-1', 'own/int') })
    expect(result.findings).toEqual([])
    expect(result.base).toEqual({ branch: 'own/int', head, tree: `tree-${head}` })
    expect(result.integration?.exists).toBe(true)
  })
})
