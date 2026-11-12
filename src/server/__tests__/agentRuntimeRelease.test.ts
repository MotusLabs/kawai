// @reads: .github/workflows/agent-runtime*, scripts/agent-runtime-release*, packages/agent-runtime/CHANGELOG.md, packages/agent-runtime/README.md, packages/agent-runtime/package.json, packages/claude-agent-sdk-no-cli/package.json
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { releaseErrors, type ReleaseInput } from '../../../scripts/agent-runtime-release-gate.js'

const root = resolve(import.meta.dir, '../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const sha = 'a'.repeat(40)
const eligible = (): ReleaseInput => ({
  event: 'push', ref: 'refs/tags/agent-runtime-v0.1.0', sha,
  version: JSON.parse(read('packages/agent-runtime/package.json')).version,
  companionVersion: JSON.parse(read('packages/claude-agent-sdk-no-cli/package.json')).version,
  changelog: read('packages/agent-runtime/CHANGELOG.md'), checks: 'success',
  acceptedSha: sha, nativeSha: sha, authorizedSha: sha,
})

// @covers: agent-runtime-distribution › Kawai CI publishes to GitHub Packages › Version mismatch or failed checks
test('D04 M-release: only an exact trusted tag with checks and all owner evidence pins is eligible', () => {
  expect(releaseErrors(eligible())).toEqual([])
  const refused: Partial<ReleaseInput>[] = [
    { event: 'pull_request' }, { event: 'pull_request_target' }, { event: 'workflow_dispatch' },
    { ref: 'refs/tags/v0.1.0' }, { ref: 'refs/tags/agent-runtime-v0.1.1' },
    { version: '0.1.0-rc.1' }, { companionVersion: '0.0.0' },
    { changelog: '## 0.1.00\n' }, { changelog: '## Unreleased (0.1.0)' },
    ...['failure', 'cancelled', 'skipped', 'neutral', '', 'true'].map((checks) => ({ checks })),
    { sha: 'abc' }, { acceptedSha: '' }, { nativeSha: '' }, { authorizedSha: '' },
    { acceptedSha: 'b'.repeat(40) }, { nativeSha: 'b'.repeat(40) }, { authorizedSha: 'b'.repeat(40) },
  ]
  for (const input of refused) expect(releaseErrors({ ...eligible(), ...input }).length).toBeGreaterThan(0)
  for (const version of ['00.1.0', '0.01.0', '0.1.00']) {
    expect(releaseErrors({ ...eligible(), version, companionVersion: version, ref: `refs/tags/agent-runtime-v${version}`, changelog: `## ${version}` })).toContain('stable semver required')
  }
})

// @covers: agent-runtime-distribution › Releases have an independent compatibility contract › Initial and breaking releases
test('D05: the candidate version has an independent changelog and requires major migration for breaking changes', () => {
  const entry = eligible()
  expect(entry.version).toBe('0.1.0')
  expect(entry.companionVersion).toBe('0.1.0')
  expect(entry.changelog).toContain('new major version, even after 0.x')
  expect(read('packages/agent-runtime/README.md')).toContain('with\nmigration notes')
})

test('release workflow has no PR trigger and credentials exist only after the trusted publication gate', () => {
  const workflow = Bun.YAML.parse(read('.github/workflows/agent-runtime-release.yml')) as any
  expect(workflow.on).toEqual({ push: { tags: ['agent-runtime-v*'] } })
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const { verify, publish } = workflow.jobs
  expect(verify.permissions).toBeUndefined()
  expect(publish.needs).toEqual(['verify', 'minimum-consumer'])
  expect(publish.if).toBe("github.event_name == 'push' && needs.verify.result == 'success' && needs.minimum-consumer.result == 'success' && startsWith(github.ref, 'refs/tags/agent-runtime-v') && vars.AGENT_RUNTIME_ACCEPTED_SHA == github.sha && vars.AGENT_RUNTIME_NATIVE_SHA == github.sha && vars.AGENT_RUNTIME_AUTHORIZED_SHA == github.sha")
  expect(publish.environment).toBe('agent-runtime-release')
  expect(publish.permissions).toEqual({ contents: 'read', packages: 'write' })
  expect(verify.steps.map((step: any) => step.run)).toContain('bun run check --full-properties --no-retry')
  const minimum = workflow.jobs['minimum-consumer']
  expect(minimum.permissions).toBeUndefined()
  expect(JSON.stringify([verify, minimum])).not.toContain('secrets.')
  for (const job of [verify, minimum, publish]) {
    expect(job['runs-on']).toBe('ubuntu-latest')
    for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
  }
  const gate = publish.steps.findIndex((step: any) => step.run === 'bun scripts/agent-runtime-release.ts')
  expect(gate).toBeGreaterThan(0)
  expect(publish.steps[gate].env).toEqual({ REQUIRED_CHECKS: '${{ needs.verify.result }}', ACCEPTED_SHA: '${{ vars.AGENT_RUNTIME_ACCEPTED_SHA }}', NATIVE_SHA: '${{ vars.AGENT_RUNTIME_NATIVE_SHA }}', AUTHORIZED_SHA: '${{ vars.AGENT_RUNTIME_AUTHORIZED_SHA }}' })
  publish.steps.forEach((step: any, i: number) => {
    if (JSON.stringify(step).includes('secrets.')) expect(i).toBeGreaterThan(gate)
    expect(step['continue-on-error']).toBeUndefined()
  })
  expect(publish.steps.at(-1).run).toContain('npm publish ./packages/claude-agent-sdk-no-cli --ignore-scripts')
  expect(publish.steps.at(-1).run).toContain('npm publish ./packages/agent-runtime --ignore-scripts')
})

test('M-release: the actual workflow gate command exits nonzero for mismatches or bypassed acceptance', () => {
  const env = {
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/agent-runtime-v0.1.0', GITHUB_SHA: sha,
    REQUIRED_CHECKS: 'success', ACCEPTED_SHA: sha, NATIVE_SHA: sha, AUTHORIZED_SHA: sha,
  }
  const invoke = (changed: Record<string, string | undefined>) => Bun.spawnSync([process.execPath, 'scripts/agent-runtime-release.ts'], { cwd: root, env: { ...env, ...changed }, stdout: 'pipe', stderr: 'pipe' })
  expect(invoke({}).exitCode).toBe(0)
  for (const changed of [
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/tags/agent-runtime-v0.2.0' },
    { REQUIRED_CHECKS: 'failure' }, { REQUIRED_CHECKS: 'skipped' },
    { ACCEPTED_SHA: '' }, { NATIVE_SHA: '' }, { AUTHORIZED_SHA: '' },
  ]) {
    const result = invoke(changed)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString().trim().length).toBeGreaterThan(0)
  }
})
