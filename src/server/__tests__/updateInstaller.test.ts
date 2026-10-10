// updateInstaller.test.ts - the orchestrated update verb. A source run
// installs the release under ~/.agentboard/app with the git tree untouched;
// a compiled run swaps the live root; a checksum refusal leaves the live
// install and staging parent unchanged.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installUpdate } from '../updates/updateInstaller'
import { discoverInstallRoot } from '../updates/installRoot'
import type { LatestRelease } from '../updates/releaseFeed'

const TARBALL_NAME = 'agentboard-linux-x64.tar.gz'
const TARBALL_URL = `https://example.com/release/${TARBALL_NAME}`
const SUMS_URL = 'https://example.com/release/SHA256SUMS'

let workRoot = ''
let tarballBytes = new Uint8Array()
let tarballSha = ''

beforeEach(async () => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-update-install-'))
  // A real tarball so extraction runs the real path.
  const fixtureRoot = path.join(workRoot, 'fixture')
  fs.mkdirSync(path.join(fixtureRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, 'dist', 'client'), { recursive: true })
  fs.writeFileSync(path.join(fixtureRoot, 'bin', 'agentboard'), '#!/bin/sh\necho new\n', { mode: 0o755 })
  fs.writeFileSync(path.join(fixtureRoot, 'dist', 'client', 'index.html'), '<html>new</html>')
  const tarballPath = path.join(workRoot, 'fixture.tar.gz')
  const proc = Bun.spawn(['tar', '-czf', tarballPath, '-C', fixtureRoot, 'bin', 'dist'], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
  tarballBytes = new Uint8Array(fs.readFileSync(tarballPath))
  tarballSha = createHash('sha256').update(tarballBytes).digest('hex')
})

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true })
})

const release: LatestRelease = {
  tag: 'v1.2.0-7',
  htmlUrl: null,
  assets: [
    { name: TARBALL_NAME, url: TARBALL_URL },
    { name: 'SHA256SUMS', url: SUMS_URL },
  ],
}

function fetchFixture(sumsText: string | null = `${tarballSha}  ${TARBALL_NAME}\n`): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === SUMS_URL && sumsText !== null) return new Response(sumsText, { status: 200 })
    if (url === TARBALL_URL) return new Response(tarballBytes.slice().buffer as ArrayBuffer, { status: 200 })
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

const snapshot = (base: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const full = path.join(base, String(entry))
    if (fs.statSync(full).isFile()) out[String(entry)] = fs.readFileSync(full, 'utf8')
  }
  return out
}

describe('installUpdate (source run)', () => {
  test('installs the release under ~/.agentboard/app without touching the checkout', async () => {
    const home = path.join(workRoot, 'home')
    // The source checkout the server runs from: tracked files that must be
    // identical afterwards.
    const checkout = path.join(workRoot, 'checkout')
    fs.mkdirSync(path.join(checkout, 'src'), { recursive: true })
    fs.writeFileSync(path.join(checkout, 'package.json'), '{}')
    fs.writeFileSync(path.join(checkout, 'src', 'index.ts'), 'old')
    const checkoutBefore = snapshot(checkout)

    const result = await installUpdate({
      release,
      platform: 'linux-x64',
      discover: () => discoverInstallRoot({ isCompiled: false, homeDir: home }),
      fetchImpl: fetchFixture(),
    })

    expect(result.compiled).toBe(false)
    expect(result.root).toBe(path.join(home, '.agentboard', 'app'))
    const installed = snapshot(result.root)
    expect(installed['bin/agentboard']).toContain('echo new')
    expect(installed['dist/client/index.html']).toContain('new')
    expect(fs.statSync(path.join(result.root, 'bin', 'agentboard')).mode & 0o777).toBe(0o755)
    // The git tree is untouched: no tracked or untracked changes.
    expect(snapshot(checkout)).toEqual(checkoutBefore)
    // Staging is cleaned up beside the install target.
    expect(fs.readdirSync(path.join(home, '.agentboard'))).toEqual(['app'])
  })
})

describe('installUpdate (compiled run)', () => {
  test('swaps the live root and invokes the restart verb', async () => {
    const root = path.join(workRoot, 'live')
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(root, 'dist', 'client'), { recursive: true })
    fs.writeFileSync(path.join(root, 'bin', 'agentboard'), 'old')
    fs.writeFileSync(path.join(root, 'dist', 'client', 'index.html'), 'old')

    let restarts = 0
    const result = await installUpdate({
      release,
      platform: 'linux-x64',
      discover: () => ({ root, binPath: path.join(root, 'bin', 'agentboard'), clientDir: path.join(root, 'dist', 'client'), compiled: true }),
      fetchImpl: fetchFixture(),
      restart: () => { restarts += 1 },
    })

    expect(result.compiled).toBe(true)
    expect(restarts).toBe(1)
    expect(fs.readFileSync(path.join(root, 'bin', 'agentboard'), 'utf8')).toContain('echo new')
    expect(fs.readFileSync(path.join(root, 'dist', 'client', 'index.html'), 'utf8')).toContain('new')
  })

  test('a checksum mismatch refuses before any write into the live root', async () => {
    const root = path.join(workRoot, 'live')
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(root, 'dist', 'client'), { recursive: true })
    fs.writeFileSync(path.join(root, 'bin', 'agentboard'), 'old')
    fs.writeFileSync(path.join(root, 'dist', 'client', 'index.html'), 'old')
    const before = snapshot(root)
    const beforeParent = fs.readdirSync(workRoot)

    let refusal: unknown
    await installUpdate({
      release,
      platform: 'linux-x64',
      discover: () => ({ root, binPath: path.join(root, 'bin', 'agentboard'), clientDir: path.join(root, 'dist', 'client'), compiled: true }),
      fetchImpl: fetchFixture(`${'b'.repeat(64)}  ${TARBALL_NAME}\n`),
    }).catch((cause) => { refusal = cause })

    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_CHECKSUM_MISMATCH')
    expect(snapshot(root)).toEqual(before)
    // Staging beside the live root is cleaned up after the refusal.
    expect(fs.readdirSync(workRoot).sort()).toEqual(beforeParent.slice().sort())
  })

  test('an unsupported running platform refuses with the named error', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'freebsd' })
    let refusal: unknown
    try {
      await installUpdate({
        release,
        discover: () => ({ root: workRoot, binPath: workRoot, clientDir: workRoot, compiled: true }),
        fetchImpl: fetchFixture(),
      }).catch((cause) => { refusal = cause })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_UNSUPPORTED_PLATFORM')
  })
})
