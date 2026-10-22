// importClosure.ts — the relative-import closure walker (per-result-suite
// D2, follow-ups F-u3), shared by the escape-set test, which proves the
// escape set covers every module the check machinery loads, and pre-commit's
// I1 test, which proves no module the commit hook loads can reach a record
// writer. The walk follows relative imports (static, re-exports, and
// dynamic) from the entry files; entries and results are slash-separated
// paths relative to the repository root.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g

function resolveModule(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`unresolved import ${specifier} in ${path.relative(ROOT, fromFile)}`)
}

export function importClosure(entries: string[]): string[] {
  const seen = new Set<string>()
  const pending = entries.map((entry) => path.join(ROOT, entry))
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_PATTERN)) pending.push(resolveModule(file, match[1]))
  }
  return [...seen].map((file) => path.relative(ROOT, file).split(path.sep).join('/')).sort()
}
