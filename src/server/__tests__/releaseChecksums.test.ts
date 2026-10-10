// releaseChecksums.test.ts - SHA256SUMS generation for the release job. The
// updater refuses any update whose tarball hash is not in this file, so the
// script must fail closed: no tarball, no manifest, no release.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { cleanGitEnv } from '../git/gitCommand'

const repoRoot = path.resolve(import.meta.dir, '../../..')
const script = path.join(repoRoot, 'scripts/release-checksums.sh')

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const

type ChecksumRun = { exitCode: number; stderr: string; checksums: string | null }

/** Runs the script against a temp release dir holding the given tarballs. */
function runScript(tarballs: readonly string[], mode: 'normal' | 'unreadable' = 'normal'): { dir: string } & ChecksumRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checksums-'))
  for (const platform of PLATFORMS) {
    if (!tarballs.includes(platform)) continue
    const body = `tarball-bytes-for-${platform}\n`
    fs.writeFileSync(path.join(dir, `agentboard-${platform}.tar.gz`), body)
    if (mode === 'unreadable' && platform === 'linux-x64') fs.chmodSync(path.join(dir, `agentboard-${platform}.tar.gz`), 0o000)
  }
  const proc = Bun.spawnSync({
    cmd: ['sh', script, dir],
    cwd: repoRoot,
    env: cleanGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const checksumsPath = path.join(dir, 'SHA256SUMS')
  return {
    dir,
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
    checksums: fs.existsSync(checksumsPath) ? fs.readFileSync(checksumsPath, 'utf8') : null,
  }
}

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

describe('release-checksums', () => {
  test('all four tarballs yield a manifest entry each, matching their bytes', () => {
    const run = runScript(PLATFORMS)
    try {
      expect(run.exitCode).toBe(0)
      expect(run.checksums).not.toBeNull()
      const lines = run.checksums!.split('\n').filter(line => line.length > 0)
      expect(lines).toHaveLength(4)
      for (const platform of PLATFORMS) {
        const file = path.join(run.dir, `agentboard-${platform}.tar.gz`)
        const expected = `${sha256(file)}  agentboard-${platform}.tar.gz`
        expect(lines).toContain(expected)
      }
    } finally {
      fs.rmSync(run.dir, { recursive: true, force: true })
    }
  })

  test('a missing tarball fails the run instead of publishing a partial manifest', () => {
    const run = runScript(['darwin-arm64', 'darwin-x64', 'linux-x64'])
    try {
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toContain('agentboard-linux-arm64.tar.gz is missing')
      // What was written never claims the missing tarball.
      expect(run.checksums).not.toContain('agentboard-linux-arm64.tar.gz')
      expect(run.checksums!.split('\n').filter(line => line.length > 0)).toHaveLength(3)
    } finally {
      fs.rmSync(run.dir, { recursive: true, force: true })
    }
  })

  test('an unreadable tarball fails the run', () => {
    const run = runScript(PLATFORMS, 'unreadable')
    try {
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toContain('could not hash agentboard-linux-x64.tar.gz')
    } finally {
      // Restore permissions so rmSync can descend.
      fs.chmodSync(path.join(run.dir, 'agentboard-linux-x64.tar.gz'), 0o644)
      fs.rmSync(run.dir, { recursive: true, force: true })
    }
  })

  test('usage errors fail without touching a directory', () => {
    const proc = Bun.spawnSync({
      cmd: ['sh', script],
      cwd: repoRoot,
      env: cleanGitEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(proc.exitCode).not.toBe(0)
    expect(proc.stderr.toString()).toContain('usage:')
  })
})
