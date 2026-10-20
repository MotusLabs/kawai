// checkTsBuildInfo.test.ts - The incremental typecheck state (check-dedup 3.2)
// must stay out of git: its build-info file lives under node_modules, which
// the repository ignores. Reads tsconfig.json and .gitignore directly; spawns
// nothing.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../..')

describe('incremental typecheck state', () => {
  test('is enabled with its build info under the gitignored node_modules', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8'))
    expect(tsconfig.compilerOptions.incremental).toBe(true)
    const buildInfo: unknown = tsconfig.compilerOptions.tsBuildInfoFile
    expect(typeof buildInfo).toBe('string')
    expect((buildInfo as string).replace(/\\/g, '/').startsWith('node_modules/')).toBe(true)
  })

  test('node_modules is a literal ignore rule of this repository', () => {
    const rules = fs
      .readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
    expect(rules).toContain('node_modules')
  })
})
