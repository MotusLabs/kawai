// updateDownload.test.ts - the verify-before-extract contract of the update
// installer. A matching checksum hands back a staged tarball; a mismatch or
// an unverifiable release (missing file, missing entry, missing asset)
// refuses with the named error and leaves the live install untouched —
// nothing is written outside the staging directory.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadAndVerify, parseChecksumEntry } from '../updates/updateDownload'
import type { LatestRelease } from '../updates/releaseFeed'

const TARBALL_NAME = 'agentboard-linux-x64.tar.gz'
const TARBALL_URL = `https://example.com/release/${TARBALL_NAME}`
const SUMS_URL = 'https://example.com/release/SHA256SUMS'

const tarballBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
const tarballSha = createHash('sha256').update(tarballBytes).digest('hex')

let workRoot = ''
let stagingDir = ''
let liveRoot = ''

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-update-dl-'))
  stagingDir = path.join(workRoot, 'staging')
  liveRoot = path.join(workRoot, 'live')
  fs.mkdirSync(stagingDir)
  fs.mkdirSync(path.join(liveRoot, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(liveRoot, 'bin', 'agentboard'), 'old binary')
})

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true })
})

/** Recursive file listing with contents, to prove a tree is untouched. */
const snapshot = (root: string): Array<string> =>
  fs.readdirSync(root, { recursive: true }).flatMap((entry) => {
    const full = path.join(root, String(entry))
    return fs.statSync(full).isFile() ? [`${entry}=${fs.readFileSync(full, 'utf8')}`] : []
  })

function makeRelease(assets: Array<{ name: string; url: string }>): LatestRelease {
  return { tag: 'v1.2.0-7', htmlUrl: null, assets }
}

function fetchWith(sumsText: string | null, tarball: Uint8Array | null): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === SUMS_URL && sumsText !== null) {
      return new Response(sumsText, { status: 200 })
    }
    if (url === TARBALL_URL && tarball !== null) {
      return new Response(tarball.slice().buffer as ArrayBuffer, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

const goodSums = `${tarballSha}  ${TARBALL_NAME}\n`
const standardAssets = [
  { name: TARBALL_NAME, url: TARBALL_URL },
  { name: 'SHA256SUMS', url: SUMS_URL },
]

describe('parseChecksumEntry', () => {
  test('reads text-mode and binary-mode sha256sum lines', () => {
    const text = `${tarballSha}  ${TARBALL_NAME}\n${'a'.repeat(64)}  other.tar.gz\n`
    const binary = `${tarballSha} *${TARBALL_NAME}\n`
    expect(parseChecksumEntry(text, TARBALL_NAME)).toBe(tarballSha)
    expect(parseChecksumEntry(binary, TARBALL_NAME)).toBe(tarballSha)
    expect(parseChecksumEntry(text, 'other.tar.gz')).toBe('a'.repeat(64))
    expect(parseChecksumEntry(text, 'absent.tar.gz')).toBeNull()
  })
})

describe('downloadAndVerify', () => {
  test('a matching checksum stages the tarball and reports its hash', async () => {
    const before = snapshot(liveRoot)
    const verified = await downloadAndVerify({
      release: makeRelease(standardAssets),
      platform: 'linux-x64',
      stagingDir,
      fetchImpl: fetchWith(goodSums, tarballBytes),
    })
    expect(verified.sha256).toBe(tarballSha)
    expect(verified.tarballPath).toBe(path.join(stagingDir, TARBALL_NAME))
    // The tarball landed in staging, and only there.
    expect(new Uint8Array(fs.readFileSync(verified.tarballPath))).toEqual(tarballBytes)
    expect(fs.readdirSync(stagingDir)).toEqual([TARBALL_NAME])
    expect(snapshot(liveRoot)).toEqual(before)
  })

  test('a checksum mismatch refuses before extract and writes nothing', async () => {
    const before = snapshot(liveRoot)
    const wrongSums = `${'b'.repeat(64)}  ${TARBALL_NAME}\n`
    let refusal: unknown
    await downloadAndVerify({
      release: makeRelease(standardAssets),
      platform: 'linux-x64',
      stagingDir,
      fetchImpl: fetchWith(wrongSums, tarballBytes),
    }).catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_CHECKSUM_MISMATCH')
    expect(String((refusal as Error).message)).toContain(tarballSha)
    // Refused before extract: no tarball is even written to staging.
    expect(fs.readdirSync(stagingDir)).toEqual([])
    expect(snapshot(liveRoot)).toEqual(before)
  })

  test('a missing checksum file refuses with no fallback', async () => {
    const before = snapshot(liveRoot)
    const release = makeRelease([{ name: TARBALL_NAME, url: TARBALL_URL }])
    let refusal: unknown
    await downloadAndVerify({
      release,
      platform: 'linux-x64',
      stagingDir,
      fetchImpl: fetchWith(null, null),
    }).catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_CHECKSUM_MISSING')
    expect(String((refusal as Error).message)).toContain('SHA256SUMS')
    expect(fs.readdirSync(stagingDir)).toEqual([])
    expect(snapshot(liveRoot)).toEqual(before)
  })

  test('a missing entry for the platform tarball refuses with no fallback', async () => {
    const before = snapshot(liveRoot)
    const otherPlatformSums = `${'c'.repeat(64)}  agentboard-darwin-arm64.tar.gz\n`
    let refusal: unknown
    await downloadAndVerify({
      release: makeRelease(standardAssets),
      platform: 'linux-x64',
      stagingDir,
      fetchImpl: fetchWith(otherPlatformSums, tarballBytes),
    }).catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_CHECKSUM_MISSING')
    expect(String((refusal as Error).message)).toContain(`no entry for ${TARBALL_NAME}`)
    expect(fs.readdirSync(stagingDir)).toEqual([])
    expect(snapshot(liveRoot)).toEqual(before)
  })

  test('a release without the platform tarball asset refuses', async () => {
    const release = makeRelease([{ name: 'SHA256SUMS', url: SUMS_URL }])
    let refusal: unknown
    await downloadAndVerify({
      release,
      platform: 'linux-x64',
      stagingDir,
      fetchImpl: fetchWith(goodSums, null),
    }).catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_CHECKSUM_MISSING')
    expect(String((refusal as Error).message)).toContain(`no ${TARBALL_NAME} asset`)
  })

  test('a failed checksum download refuses as unverifiable', async () => {
    let refusal: unknown
    await downloadAndVerify({
      release: makeRelease(standardAssets),
      platform: 'linux-x64',
      stagingDir,
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    }).catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_CHECKSUM_MISSING')
    expect(String((refusal as Error).message)).toContain('HTTP 500')
  })

  test('a failed tarball download surfaces a named download error', async () => {
    let refusal: unknown
    await downloadAndVerify({
      release: makeRelease(standardAssets),
      platform: 'linux-x64',
      stagingDir,
      fetchImpl: fetchWith(goodSums, null),
    }).catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_DOWNLOAD')
    expect(String((refusal as Error).message)).toContain('HTTP 404')
  })
})
