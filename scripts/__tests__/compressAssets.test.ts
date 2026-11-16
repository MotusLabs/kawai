// compressAssets.test.ts — property P3 over a fixture tree and the build
// wiring (slow-link-resilience D6, task 5.1).
//
// The fixture mirrors the real dist/client shape: content-hashed bundles
// under assets/, one nested directory, a webmanifest and texts with
// non-ASCII bytes, an empty file — plus the ineligible formats the build
// emits beside them (PNG, ICO, WOFF2). P3 is deterministic over the tree,
// so it needs no seed. The real-build round trip over dist/client is
// verified outside the suite (V2), not here.
// @reads: package.json, scripts/compress-assets.ts
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { compressAssets, isEligibleAsset } from '../compress-assets'

const ELIGIBLE_FILES: Record<string, string> = {
  'index.html': '<!doctype html>\n<html lang="en"><title>Kawai ✓</title></html>\n',
  'assets/index-abc123.js': 'export const main = "app"\n'.repeat(40),
  'assets/chunk-def456.mjs': 'export const chunk = () => 1\n'.repeat(8),
  'assets/style-789.css': 'body{color:#111}\n:root{--pad:1px}\n'.repeat(20),
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text>日本語 ✓</text></svg>\n',
  'manifest.webmanifest': `${JSON.stringify({ name: 'Kawai ✓ 日本語', icons: [] })}\n`,
  'robots.txt': 'User-agent: *\nDisallow:\n',
  'assets/nested/data.json': '',
  'assets/nested/notes.txt': 'café résumé — ΩΩ\n'.repeat(3),
}

const INELIGIBLE_FILES: Record<string, Buffer> = {
  'icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  'favicon.ico': Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]),
  'fonts/inter-abc.woff2': Buffer.from('wOF2', 'ascii'),
}

interface Fixture {
  root: string
  bytes: Map<string, Buffer> // relative path → exact bytes on disk
}

function writeTree(base: string): Map<string, Buffer> {
  const bytes = new Map<string, Buffer>()
  for (const [relative, content] of [...Object.entries(ELIGIBLE_FILES), ...Object.entries(INELIGIBLE_FILES)]) {
    const absolute = path.join(base, relative)
    mkdirSync(path.dirname(absolute), { recursive: true })
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    writeFileSync(absolute, buffer)
    bytes.set(relative, Buffer.from(buffer))
  }
  return bytes
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'compress-assets-'))
  return { root, bytes: writeTree(root) }
}

// Every regular file under root, as sorted paths relative to root.
function listAllFiles(root: string, directory: string = root): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...listAllFiles(root, absolute))
    else found.push(path.relative(root, absolute))
  }
  return found.sort()
}

let fixture: Fixture | null = null

function useFixture(): Fixture {
  fixture ??= makeFixture()
  return fixture
}

afterEach(() => {
  if (fixture !== null) {
    rmSync(fixture.root, { recursive: true, force: true })
    fixture = null
  }
})

describe('compress-assets (task 5.1, D6)', () => {
  test('P3: every eligible file round-trips through both siblings, originals preserved', () => {
    const { root, bytes } = useFixture()
    const compressed = compressAssets(root)

    // The walk reports exactly the fixture's eligible files, so a file the
    // fixture failed to create (or one silently skipped) cannot hide.
    expect(compressed).toEqual(Object.keys(ELIGIBLE_FILES).sort())

    for (const [relative, original] of bytes) {
      const absolute = path.join(root, relative)
      // Every original's bytes are exactly as written, eligible or not.
      expect(readFileSync(absolute)).toEqual(original)
      if (!isEligibleAsset(relative)) continue
      // A sibling pair and a byte-exact decompression for every eligible
      // extension: at the root and nested, for text, empty and non-ASCII.
      expect(brotliDecompressSync(readFileSync(`${absolute}.br`))).toEqual(original)
      expect(gunzipSync(readFileSync(`${absolute}.gz`))).toEqual(original)
    }
  })

  // @covers: web-asset-delivery › Static assets are served compressed › An asset without a compressed copy
  test('P3: ineligible assets receive no compressed copies', () => {
    const { root, bytes } = useFixture()
    compressAssets(root)
    // The named ineligible formats, whatever the script's list says — so a
    // list drift cannot make this loop vacuous.
    expect(Object.keys(INELIGIBLE_FILES).length).toBeGreaterThan(0)
    for (const relative of Object.keys(INELIGIBLE_FILES)) {
      expect(bytes.has(relative)).toBe(true)
      expect(existsSync(`${path.join(root, relative)}.br`)).toBe(false)
      expect(existsSync(`${path.join(root, relative)}.gz`)).toBe(false)
    }
  })

  test('I2: rerunning overwrites the copies, never compresses a copy of a copy', () => {
    const { root, bytes } = useFixture()
    compressAssets(root)
    compressAssets(root)

    // Still exactly the originals plus their two siblings: no .br.br,
    // .gz.gz or .gz.br grew from recompressing the first run's copies.
    expect(listAllFiles(root)).toEqual(
      [...bytes.keys(), ...bytes.keys().filter(isEligibleAsset).flatMap((relative) => [`${relative}.br`, `${relative}.gz`])].sort()
    )
    // The second run's siblings still decode to the original bytes.
    for (const relative of bytes.keys()) {
      if (!isEligibleAsset(relative)) continue
      const absolute = path.join(root, relative)
      expect(brotliDecompressSync(readFileSync(`${absolute}.br`))).toEqual(bytes.get(relative)!)
      expect(gunzipSync(readFileSync(`${absolute}.gz`))).toEqual(bytes.get(relative)!)
    }
  })

  test('the eligible list is exactly the D6 extensions', () => {
    for (const extension of ['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt']) {
      expect(isEligibleAsset(`bundle${extension}`)).toBe(true)
    }
    // Copies from an earlier run are not eligible (I2), nor other formats.
    for (const name of ['bundle.br', 'bundle.gz', 'bundle.js.br', 'bundle.js.gz', 'bundle.png', 'bundle.woff2', 'bundle']) {
      expect(isEligibleAsset(name)).toBe(false)
    }
  })

  test('A2: the build script compresses after vite build', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.build).toBe('vite build && bun scripts/compress-assets.ts')
  })
})

// The production entry: package.json runs `bun scripts/compress-assets.ts`
// as a child process, so at least one oracle must reach the seam through
// that entry (oracle-hazards M1), not only the imported helper.
const SCRIPT = path.resolve(import.meta.dir, '..', 'compress-assets.ts')

function runScript(cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

describe('compress-assets CLI entry (production path, M1)', () => {
  // @covers: web-asset-delivery › Static assets are served compressed › An asset without a compressed copy
  test('the real script writes both siblings that decode exactly, originals preserved', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'compress-assets-cli-'))
    try {
      const dist = path.join(cwd, 'dist', 'client')
      const bytes = writeTree(dist)
      const result = runScript(cwd)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('compress-assets:')
      for (const [relative, original] of bytes) {
        const absolute = path.join(dist, relative)
        expect(readFileSync(absolute)).toEqual(original)
        if (!isEligibleAsset(relative)) {
          expect(existsSync(`${absolute}.br`)).toBe(false)
          expect(existsSync(`${absolute}.gz`)).toBe(false)
          continue
        }
        expect(brotliDecompressSync(readFileSync(`${absolute}.br`))).toEqual(original)
        expect(gunzipSync(readFileSync(`${absolute}.gz`))).toEqual(original)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('a cwd without dist/client refuses with exit 1', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'compress-assets-cli-empty-'))
    try {
      const result = runScript(cwd)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('no build output')
      expect(result.stdout).not.toContain('compress-assets: wrote')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
