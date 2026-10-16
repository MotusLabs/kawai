// ghCommand (plan-execution D14): argument-array gh over a stub executable
// on a private PATH — argv passes through untouched (one element per
// argument), exit codes and both streams come back, a timeout kills the
// process as exitCode null, output is capped, and token-looking substrings
// are redacted from what a caller would record.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactTokens, runGh } from '../plans/landing/ghCommand'

let dir: string
let stubDir: string
let env: Record<string, string>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-gh-'))
  stubDir = path.join(dir, 'bin')
  env = { PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}` }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const stubGh = (script: string): void => {
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(path.join(stubDir, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

describe('runGh', () => {
  test('argv passes through one element per argument, and a zero exit is ok', async () => {
    stubGh('printf "%s\\n" "$@"')
    const result = await runGh(['pr', 'view', 'kawai/a b'], { env })
    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(result.stdout).toBe('pr\nview\nkawai/a b\n')
  })

  test('a non-zero exit code is reported with its stderr', async () => {
    stubGh('echo "gh: no such ref" >&2\nexit 4')
    const result = await runGh(['api', 'repos/x/y'], { env })
    expect(result).toMatchObject({ ok: false, exitCode: 4, stdout: '' })
    expect(result.stderr).toContain('no such ref')
  })

  test('a timeout kills the process: a non-success with exitCode null', async () => {
    stubGh('exec sleep 5')
    const result = await runGh(['pr', 'list'], { env, timeoutMs: 150 })
    expect(result).toMatchObject({ ok: false, exitCode: null, stdout: '', stderr: '' })
  })

  test('a missing gh on the PATH is a non-success, not a crash', async () => {
    fs.mkdirSync(stubDir, { recursive: true })
    const result = await runGh(['auth', 'status'], { env: { PATH: stubDir } })
    expect(result).toMatchObject({ ok: false, exitCode: null, stdout: '', stderr: '' })
  })

  test('output is capped at maxOutputBytes', async () => {
    stubGh('yes a | head -c 100000')
    const result = await runGh(['api', 'big'], { env, maxOutputBytes: 1000 })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('a\n'.repeat(500))
  })

  test('tokens are redacted from stdout and stderr, and truncation keeps the marker', async () => {
    stubGh('echo "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 and github_pat_11AAAAAAAAAAAAAAAAAAAAAA_x" >&2\necho "auth as ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 done"')
    const result = await runGh(['auth', 'status'], { env })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('auth as [redacted] done\n')
    expect(result.stderr).toBe('token [redacted] and [redacted]\n')
  })

  test('ordinary text with short gh-prefixes is untouched', async () => {
    stubGh('echo "ghp_short and github_pat_tiny"')
    const result = await runGh(['api', 'x'], { env })
    expect(result.stdout).toBe('ghp_short and github_pat_tiny\n')
  })
})

describe('redactTokens', () => {
  test('covers the classic prefixes standalone', () => {
    expect(redactTokens('gho_0123456789012345678901')).toBe('[redacted]')
    expect(redactTokens('x ghu_01234567890123456789 y')).toBe('x [redacted] y')
    expect(redactTokens('ghr_012345678901234567890123')).toBe('[redacted]')
  })
})
