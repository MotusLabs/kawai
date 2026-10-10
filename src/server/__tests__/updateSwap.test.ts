// updateSwap.test.ts - the all-or-restore swap. Both live paths come from
// the staged release on success; a failure placing the second path restores
// the first so the install is unchanged; nothing else in the root is touched
// and no aside copies survive.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractTarball, swapInstallPaths } from '../updates/updateSwap'

let workRoot = ''
let root = ''
let stagedRoot = ''

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-update-swap-'))
  root = path.join(workRoot, 'live')
  stagedRoot = path.join(workRoot, 'staged')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(stagedRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true })
})

function seedTree(base: string, marker: string): void {
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(base, 'dist', 'client'), { recursive: true })
  fs.writeFileSync(path.join(base, 'bin', 'agentboard'), `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(base, 'dist', 'client', 'index.html'), `<html>${marker}</html>`)
}

/** File paths + contents under a root, proving exactly what changed. */
const snapshot = (base: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const full = path.join(base, String(entry))
    if (fs.statSync(full).isFile()) out[String(entry)] = fs.readFileSync(full, 'utf8')
  }
  return out
}

describe('swapInstallPaths', () => {
  test('replaces both live paths from the staged release', () => {
    seedTree(root, 'old')
    seedTree(stagedRoot, 'new')
    swapInstallPaths({ root, stagedRoot })
    const after = snapshot(root)
    expect(after['bin/agentboard']).toContain('new')
    expect(after['dist/client/index.html']).toContain('new')
    // No aside copies or staging leftovers remain in the live root.
    expect(Object.keys(after).sort()).toEqual(['bin/agentboard', 'dist/client/index.html'])
    // The executable bit survives the move (tar preserved it in staging).
    expect(fs.statSync(path.join(root, 'bin', 'agentboard')).mode & 0o777).toBe(0o755)
  })

  test('a failure placing the second path restores the first, unchanged', () => {
    seedTree(root, 'old')
    // Partial staged release: bin present, dist/client missing — the second
    // placement fails after the binary was already swapped.
    fs.mkdirSync(path.join(stagedRoot, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(stagedRoot, 'bin', 'agentboard'), '#!/bin/sh\n# new\n', { mode: 0o755 })
    const before = snapshot(root)
    let refusal: unknown
    try {
      swapInstallPaths({ root, stagedRoot })
    } catch (cause) {
      refusal = cause
    }
    expect(refusal).toBeInstanceOf(Error)
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_SWAP_FAILED')
    expect(snapshot(root)).toEqual(before)
  })

  test('a failure placing the first path restores its own aside copy', () => {
    seedTree(root, 'old')
    // Staged release missing its binary: the first placement fails after the
    // live binary was already moved aside.
    fs.mkdirSync(path.join(stagedRoot, 'dist', 'client'), { recursive: true })
    fs.writeFileSync(path.join(stagedRoot, 'dist', 'client', 'index.html'), '<html>new</html>')
    const before = snapshot(root)
    let refusal: unknown
    try {
      swapInstallPaths({ root, stagedRoot })
    } catch (cause) {
      refusal = cause
    }
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_SWAP_FAILED')
    expect(snapshot(root)).toEqual(before)
  })

  test('populates a fresh install root (source-run install)', () => {
    seedTree(stagedRoot, 'new')
    swapInstallPaths({ root, stagedRoot })
    const after = snapshot(root)
    expect(after['bin/agentboard']).toContain('new')
    expect(after['dist/client/index.html']).toContain('new')
  })

  test('a failed fresh install leaves no partial binary behind', () => {
    // Partial staged release: bin present, dist/client missing — the second
    // placement fails after the fresh binary was already placed. With no
    // aside copies to restore, rollback must remove what was placed.
    fs.mkdirSync(path.join(stagedRoot, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(stagedRoot, 'bin', 'agentboard'), '#!/bin/sh\n# new\n', { mode: 0o755 })
    let refusal: unknown
    try {
      swapInstallPaths({ root, stagedRoot })
    } catch (cause) {
      refusal = cause
    }
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_SWAP_FAILED')
    expect(snapshot(root)).toEqual({})
  })
})

describe('extractTarball', () => {
  test('extracts a real tarball into staging', async () => {
    const fixtureRoot = path.join(workRoot, 'fixture')
    seedTree(fixtureRoot, 'from-tar')
    const tarballPath = path.join(workRoot, 'fixture.tar.gz')
    const proc = Bun.spawn(['tar', '-czf', tarballPath, '-C', fixtureRoot, 'bin', 'dist'], { stdout: 'ignore', stderr: 'pipe' })
    expect(await proc.exited).toBe(0)

    const extractDir = path.join(workRoot, 'extracted')
    fs.mkdirSync(extractDir)
    await extractTarball({ tarballPath, stagingDir: extractDir })
    const after = snapshot(extractDir)
    expect(after['bin/agentboard']).toContain('from-tar')
    expect(after['dist/client/index.html']).toContain('from-tar')
  })

  test('a corrupt tarball refuses with the named error', async () => {
    const tarballPath = path.join(workRoot, 'corrupt.tar.gz')
    fs.writeFileSync(tarballPath, 'not a tarball')
    const extractDir = path.join(workRoot, 'extracted')
    fs.mkdirSync(extractDir)
    let refusal: unknown
    try {
      await extractTarball({ tarballPath, stagingDir: extractDir })
    } catch (cause) {
      refusal = cause
    }
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_TARBALL_EXTRACT')
  })
})
