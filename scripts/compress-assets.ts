// compress-assets.ts — precompressed siblings for the built client
// (slow-link-resilience D6, task 5.1).
//
// Run after `vite build`: walks dist/client and writes `<file>.br` (brotli
// quality 11) and `<file>.gz` (gzip level 9) beside every eligible file.
// Originals are read, never rewritten. The eligible list excludes `.br` and
// `.gz`, so a rerun overwrites the copies from the fresh original and never
// compresses a copy of a copy.
//
//   "build": "vite build && bun scripts/compress-assets.ts"
//
// Only node: builtins — no new dependency (D6).
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ELIGIBLE_EXTENSIONS = ['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt']

const BROTLI_QUALITY_11 = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY } }
const GZIP_LEVEL_9 = { level: 9 }

export function isEligibleAsset(file: string): boolean {
  return ELIGIBLE_EXTENSIONS.some((extension) => file.endsWith(extension))
}

// Walks `root`, writing the `.br` and `.gz` siblings of every eligible
// file, and returns the compressed originals' paths relative to `root`.
export function compressAssets(root: string): string[] {
  const compressed: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.isFile() && isEligibleAsset(entry.name)) {
        const original = readFileSync(absolute)
        writeFileSync(`${absolute}.br`, brotliCompressSync(original, BROTLI_QUALITY_11))
        writeFileSync(`${absolute}.gz`, gzipSync(original, GZIP_LEVEL_9))
        compressed.push(path.relative(root, absolute))
      }
    }
  }
  walk(root)
  return compressed.sort()
}

async function main(): Promise<number> {
  const root = path.resolve(process.cwd(), 'dist/client')
  if (!existsSync(root)) {
    console.error(`compress-assets: no build output at ${root} — run vite build first`)
    return 1
  }
  const compressed = compressAssets(root)
  console.log(`compress-assets: wrote .br and .gz siblings for ${compressed.length} files under ${path.relative(process.cwd(), root)}`)
  return 0
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(2)
    })
}
