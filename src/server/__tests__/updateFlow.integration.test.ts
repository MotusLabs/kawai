// updateFlow.integration.test.ts - the L3 update flow end to end against a
// fake release server and a temp install root: download → verify → extract →
// all-or-restore swap → restart verb. Asserts the new files land, the
// restart verb fires, a checksum mismatch leaves the root byte-identical,
// and a mid-swap failure (partial tarball) restores both paths.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installUpdate } from '../updates/updateInstaller'
import { discoverInstallRoot } from '../updates/installRoot'

let workRoot = ''
let root = ''
let server: ReturnType<typeof Bun.serve> | null = null

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-update-flow-'))
  root = path.join(workRoot, 'live')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'dist', 'client'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'agentboard'), 'old binary', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'dist', 'client', 'index.html'), 'old client')
})

afterEach(() => {
  server?.stop(true)
  server = null
  fs.rmSync(workRoot, { recursive: true, force: true })
})

/** Build a real tar.gz over the given file map ({relativePath: content}). */
async function makeTarball(files: Record<string, string>): Promise<Uint8Array> {
  const fixtureRoot = fs.mkdtempSync(path.join(workRoot, 'fixture-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(fixtureRoot, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, { mode: relative.endsWith('agentboard') ? 0o755 : 0o644 })
  }
  // Top-level entries actually present, so a partial map tars cleanly.
  const entries = [...new Set(Object.keys(files).map((relative) => relative.split('/')[0]))]
  const tarballPath = `${fixtureRoot}.tar.gz`
  const proc = Bun.spawn(['tar', '-czf', tarballPath, '-C', fixtureRoot, ...entries], { stdout: 'ignore', stderr: 'ignore' })
  expect(await proc.exited).toBe(0)
  return new Uint8Array(fs.readFileSync(tarballPath))
}

interface FakeRelease {
  tarball: Uint8Array
  /** Overrides the published hash; defaults to the tarball's real hash. */
  publishedSha?: string
}

/** Serve SHA256SUMS + the platform tarball as release assets. */
function serveRelease(release: FakeRelease): { baseUrl: string } {
  const sha = createHash('sha256').update(release.tarball).digest('hex')
  const published = release.publishedSha ?? sha
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/release/agentboard-linux-x64.tar.gz') {
        return new Response(release.tarball.slice().buffer as ArrayBuffer, { status: 200 })
      }
      if (url.pathname === '/release/SHA256SUMS') {
        return new Response(`${published}  agentboard-linux-x64.tar.gz\n`, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}` }
}

const releaseAt = (baseUrl: string) => ({
  tag: 'v1.2.0-7',
  htmlUrl: null,
  assets: [
    { name: 'agentboard-linux-x64.tar.gz', url: `${baseUrl}/release/agentboard-linux-x64.tar.gz` },
    { name: 'SHA256SUMS', url: `${baseUrl}/release/SHA256SUMS` },
  ],
})

const discoverLive = () => discoverInstallRoot({ execPath: path.join(root, 'bin', 'agentboard'), isCompiled: true })

const snapshot = (base: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const full = path.join(base, String(entry))
    if (fs.statSync(full).isFile()) out[String(entry)] = fs.readFileSync(full, 'utf8')
  }
  return out
}

describe('L3 update flow (fake release server)', () => {
  test('download → verify → extract → swap → restart lands the new files', async () => {
    const tarball = await makeTarball({
      'bin/agentboard': '#!/bin/sh\necho new binary\n',
      'dist/client/index.html': '<html>new client</html>',
    })
    const { baseUrl } = serveRelease({ tarball })
    const restarts: string[] = []

    const result = await installUpdate({
      release: releaseAt(baseUrl),
      platform: 'linux-x64',
      discover: discoverLive,
      restart: () => { restarts.push(discoverLive().root) },
    })

    expect(result.compiled).toBe(true)
    expect(fs.readFileSync(path.join(root, 'bin', 'agentboard'), 'utf8')).toContain('new binary')
    expect(fs.readFileSync(path.join(root, 'dist', 'client', 'index.html'), 'utf8')).toContain('new client')
    expect(fs.statSync(path.join(root, 'bin', 'agentboard')).mode & 0o777).toBe(0o755)
    // The restart verb ran once, after the swap.
    expect(restarts).toEqual([root])
    // No staging leftovers beside the live root.
    expect(fs.readdirSync(workRoot).filter((entry) => entry.startsWith('.agentboard-update'))).toEqual([])
  })

  test('a checksum mismatch leaves the install byte-identical', async () => {
    const tarball = await makeTarball({
      'bin/agentboard': '#!/bin/sh\necho new binary\n',
      'dist/client/index.html': '<html>new client</html>',
    })
    const { baseUrl } = serveRelease({ tarball, publishedSha: 'f'.repeat(64) })
    const before = snapshot(root)
    const restarts: number[] = []

    let refusal: unknown
    await installUpdate({
      release: releaseAt(baseUrl),
      platform: 'linux-x64',
      discover: discoverLive,
      restart: () => { restarts.push(1) },
    }).catch((cause) => { refusal = cause })

    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_CHECKSUM_MISMATCH')
    expect(snapshot(root)).toEqual(before)
    expect(restarts).toEqual([])
  })

  test('a mid-swap failure restores both paths', async () => {
    // A verifiable but partial tarball: the swap moves the binary aside,
    // then fails to place the missing dist/client and must restore.
    const tarball = await makeTarball({ 'bin/agentboard': '#!/bin/sh\necho new binary\n' })
    const { baseUrl } = serveRelease({ tarball })
    const before = snapshot(root)

    let refusal: unknown
    await installUpdate({
      release: releaseAt(baseUrl),
      platform: 'linux-x64',
      discover: discoverLive,
    }).catch((cause) => { refusal = cause })

    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_SWAP_FAILED')
    expect(snapshot(root)).toEqual(before)
  })
})
