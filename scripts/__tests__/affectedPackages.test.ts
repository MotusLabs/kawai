// affectedPackages.test.ts — the commit hook's affected selection over the
// agent-runtime package (extract-agent-runtime 6.4): the real unit corpus
// lists the package's tests, so a change to a fixture they spawn, a README
// they read, or a source file they import selects them, and the package's
// manifest and TypeScript configs escape to the full check. Selection runs
// over the real repository's files; nothing is executed.
// @reads: packages/agent-runtime/**
import { describe, expect, test } from 'bun:test'
import { isEscapeCandidate, selectAffectedTests } from '../affected-tests'
import { listUnitTestFiles } from '../lib/reads'

const PKG = 'packages/agent-runtime'

function select(staged: string[]) {
  return selectAffectedTests({
    root: process.cwd(),
    unitFiles: listUnitTestFiles(),
    changed: { staged, unstaged: [], untracked: [] },
  })
}

describe('affected selection over the agent-runtime package (6.4)', () => {
  test('the package manifest and TypeScript configs escape to the full check; its sources do not', () => {
    for (const escaped of [`${PKG}/package.json`, `${PKG}/tsconfig.json`, `${PKG}/tsconfig.build.json`]) {
      expect([escaped, isEscapeCandidate(escaped)]).toEqual([escaped, true])
    }
    for (const plain of [`${PKG}/src/index.ts`, `${PKG}/__tests__/lifecycle.test.ts`, `${PKG}/README.md`, `${PKG}/src/package.json.ts`]) {
      expect([plain, isEscapeCandidate(plain)]).toEqual([plain, false])
    }
    const selection = select([`${PKG}/tsconfig.json`])
    expect(selection.kind).toBe('escape')
    expect(selection.escapePaths).toEqual([`${PKG}/tsconfig.json`])
  })

  test('a spawned fixture selects the package test that declares it, in the declaration pass', () => {
    const selection = select([`${PKG}/__tests__/fixtures/codexResumeHost.ts`])
    expect(selection.kind).toBe('source')
    expect(selection.declarationFiles).toContain(`${PKG}/__tests__/codexRecovery.test.ts`)
    expect(selection.changedPassFiles).not.toContain(`${PKG}/__tests__/codexRecovery.test.ts`)
  })

  test('a package source change hands every other package test to the --changed pass', () => {
    const selection = select([`${PKG}/src/lifecycle/jobs.ts`])
    expect(selection.kind).toBe('source')
    expect(selection.changedPassFiles).toContain(`${PKG}/__tests__/lifecycle.test.ts`)
    expect(selection.changedPassFiles.filter((file) => file.startsWith(`${PKG}/`)).length).toBeGreaterThan(50)
  })

  test('a docs-only README edit runs exactly the package tests that read the README', () => {
    const selection = select([`${PKG}/README.md`])
    expect(selection.kind).toBe('docs-only')
    expect(selection.changedPassFiles).toEqual([])
    expect(selection.declarationFiles.filter((file) => file.startsWith(`${PKG}/`))).toEqual([
      `${PKG}/__tests__/codexExample.test.ts`,
      `${PKG}/__tests__/distribution.test.ts`,
      `${PKG}/__tests__/inlineRequestsExample.test.ts`,
    ])
  })
})
