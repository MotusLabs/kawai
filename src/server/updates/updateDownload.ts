// updateDownload.ts - fetch the release tarball for the running platform and
// verify its SHA256 against the release's published SHA256SUMS **before** any
// extraction or write near the live install. The checksum is over the
// tarball, not over extracted files, so extract-then-verify would be the
// wrong order. Checksums are the only trust anchor: a missing file or a
// missing entry refuses the update with no fallback path.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { UpdateError } from './updateErrors'
import type { LatestRelease } from './releaseFeed'

/** The release asset the checksum file is published under. */
export const CHECKSUM_ASSET_NAME = 'SHA256SUMS'

/**
 * The expected SHA256 for `tarballName` from `sha256sum` output, or null when
 * the file has no entry for it. Text mode (`<hash>  <name>`) and binary mode
 * (`<hash> *<name>`) lines both parse.
 */
export function parseChecksumEntry(sumsText: string, tarballName: string): string | null {
  for (const line of sumsText.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (!match) continue
    if (match[2] === tarballName) return match[1].toLowerCase()
  }
  return null
}

export interface DownloadAndVerifyOptions {
  release: LatestRelease
  /** Platform slug, e.g. `linux-x64` (see installRoot.platformSlug). */
  platform: string
  /** Existing directory, outside the live install root, receiving the tarball. */
  stagingDir: string
  fetchImpl?: typeof fetch
}

export interface VerifiedTarball {
  tarballPath: string
  sha256: string
}

/** Download the platform tarball and verify it; throws UpdateError to refuse. */
export async function downloadAndVerify(options: DownloadAndVerifyOptions): Promise<VerifiedTarball> {
  const { release, platform, stagingDir } = options
  const doFetch = options.fetchImpl ?? fetch
  const tarballName = `agentboard-${platform}.tar.gz`
  const assetNamed = (name: string) => release.assets.find((asset) => asset.name === name)
  const tarballAsset = assetNamed(tarballName)
  const checksumAsset = assetNamed(CHECKSUM_ASSET_NAME)

  const refuseUnverifiable = (why: string): UpdateError =>
    new UpdateError(
      'ERR_UPDATE_CHECKSUM_MISSING',
      `Release ${release.tag} cannot be verified: ${why}. There is no fallback check; the update is refused.`,
    )

  if (!tarballAsset) {
    throw refuseUnverifiable(`it has no ${tarballName} asset`)
  }
  if (!checksumAsset) {
    throw refuseUnverifiable('it publishes no SHA256SUMS file')
  }

  // The checksum file is tiny; fetch it first so a tarball is never
  // downloaded into a release that could not be verified anyway.
  let checksumResponse: Response
  try {
    checksumResponse = await doFetch(checksumAsset.url)
  } catch (cause) {
    throw refuseUnverifiable(`downloading SHA256SUMS failed (${cause instanceof Error ? cause.message : String(cause)})`)
  }
  if (!checksumResponse.ok) {
    throw refuseUnverifiable(`SHA256SUMS download returned HTTP ${checksumResponse.status}`)
  }
  const expected = parseChecksumEntry(await checksumResponse.text(), tarballName)
  if (expected === null) {
    throw refuseUnverifiable(`SHA256SUMS has no entry for ${tarballName}`)
  }

  let tarballResponse: Response
  try {
    tarballResponse = await doFetch(tarballAsset.url)
  } catch (cause) {
    throw new UpdateError(
      'ERR_UPDATE_DOWNLOAD',
      `Downloading ${tarballName} failed (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }
  if (!tarballResponse.ok) {
    throw new UpdateError(
      'ERR_UPDATE_DOWNLOAD',
      `Downloading ${tarballName} returned HTTP ${tarballResponse.status}`,
    )
  }

  const bytes = new Uint8Array(await tarballResponse.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    // Refused before extract: the live install has not been touched.
    throw new UpdateError(
      'ERR_UPDATE_CHECKSUM_MISMATCH',
      `Downloaded ${tarballName} hashes to ${actual} but the release publishes ${expected}; the update is refused before extraction.`,
    )
  }

  const tarballPath = path.join(stagingDir, tarballName)
  await fs.promises.writeFile(tarballPath, Buffer.from(bytes))
  return { tarballPath, sha256: actual }
}
