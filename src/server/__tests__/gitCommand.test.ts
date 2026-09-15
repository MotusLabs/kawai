// gitCommand.test.ts - runGit contract: leaked GIT_DIR-family environment
// variables must not override the explicit cwd. Git exports GIT_DIR and
// GIT_COMMON_DIR to hook scripts, so the pre-commit test gate (and any server
// started from a hook) would otherwise resolve every command against the
// hook's repository instead of the requested working directory.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'

let tempRoot: string
let repoA: string
let repoB: string

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-gitcmd-'))
  repoA = path.join(tempRoot, 'repo-a')
  repoB = path.join(tempRoot, 'repo-b')
  for (const repo of [repoA, repoB]) {
    const init = runGit(['init', '--initial-branch=main', repo], { timeoutMs: 5000 })
    if (!init.ok) {
      throw new Error(`git init failed for ${repo}: ${init.stderr.trim()}`)
    }
  }
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('runGit environment hygiene', () => {
  test('ignores GIT_DIR/GIT_COMMON_DIR leaked into the environment', () => {
    // Simulate git's hook exports pointing at an unrelated repository.
    const previousGitDir = process.env.GIT_DIR
    const previousCommonDir = process.env.GIT_COMMON_DIR
    process.env.GIT_DIR = path.join(repoA, '.git')
    process.env.GIT_COMMON_DIR = path.join(repoA, '.git')
    try {
      const result = runGit(
        ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
        { cwd: repoB }
      )
      expect(result.ok).toBe(true)
      const [commonDir, toplevel] = result.stdout.trim().split('\n').map((line) => line.trim())
      expect(commonDir).toBe(path.join(repoB, '.git'))
      expect(toplevel).toBe(repoB)
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      if (previousCommonDir === undefined) delete process.env.GIT_COMMON_DIR
      else process.env.GIT_COMMON_DIR = previousCommonDir
    }
  })

  test('still honors an explicit GIT_DIR passed through the env option', () => {
    const result = runGit(['rev-parse', '--git-dir'], {
      cwd: repoB,
      env: { GIT_DIR: path.join(repoA, '.git') },
    })
    expect(result.ok).toBe(true)
    expect(result.stdout.trim()).toBe(path.join(repoA, '.git'))
  })
})
