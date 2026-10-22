// ciCoverageOnPush.test.ts - The CI workflow (check-dedup 4.1) runs the unit
// suite once on pull requests and adds the coverage pass and its artifact
// upload on push only. Reads .github/workflows/ci.yml as YAML; spawns nothing.
// @reads: .github/workflows/ci.yml
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../..')

function ciSteps(): Array<Record<string, unknown>> {
  const text = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  const doc = Bun.YAML.parse(text) as Record<string, unknown>
  const jobs = doc.jobs as Record<string, { steps: Array<Record<string, unknown>> }>
  return jobs.ci.steps
}

function stepNamed(name: string): Record<string, unknown> {
  const step = ciSteps().find((step) => step.name === name)
  expect(step).toBeDefined()
  return step!
}

describe('CI coverage steps', () => {
  test('run the unit suite exactly once, on both events', () => {
    const suiteSteps = ciSteps().filter((step) => step.run === 'bun run test:ci')
    expect(suiteSteps).toHaveLength(1)
    expect(suiteSteps[0]).not.toHaveProperty('if')
  })

  test('skip the coverage pass except on push', () => {
    const step = stepNamed('Test (coverage)')
    expect(step.run).toBe('bun run test:coverage')
    expect(step.if).toBe("github.event_name == 'push'")
  })

  test('upload the coverage artifact only on push, still on failure', () => {
    const step = stepNamed('Upload coverage artifact')
    expect(step.if).toBe("always() && github.event_name == 'push'")
  })

  test('coverage follows the plain unit suite', () => {
    const names = ciSteps().map((step) => step.name)
    expect(names.indexOf('Test (coverage)')).toBeGreaterThan(names.indexOf('Test'))
  })
})
