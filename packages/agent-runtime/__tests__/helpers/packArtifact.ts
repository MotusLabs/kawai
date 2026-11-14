// Packed-artifact helpers for the distribution oracles (D01, M-pack): build
// dist, pack the real tarball with `bun pm pack`, install it into a clean
// consumer project outside the repository, and check that every import in
// the shipped files stays inside the package or names a declared dependency.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

export const PACKAGE_DIR = resolve(import.meta.dir, '../..')
const TSC = Bun.resolveSync('typescript/bin/tsc', PACKAGE_DIR)

/** Bare specifiers the shipped files may import: declared deps and builtins. */
export const ALLOWED_BARE = new Set(['zod', '@anthropic-ai/claude-agent-sdk'])

export interface RunResult {
  code: number
  out: string
}

export function run(cmd: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, FORCE_COLOR: '0' } })
  return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` }
}

export function tsc(project: string, cwd: string): RunResult {
  return run([process.execPath, TSC, '-p', project], cwd)
}

/** Builds dist and packs it; returns the tarball path in a fresh temp dir. */
export function buildAndPack(): string {
  const build = tsc('tsconfig.build.json', PACKAGE_DIR)
  if (build.code !== 0) throw new Error(`build failed:\n${build.out}`)
  const dest = mkdtempSync(join(tmpdir(), 'agent-runtime-pack-'))
  const pack = run([process.execPath, 'pm', 'pack', '--destination', dest, '--ignore-scripts', '--quiet'], PACKAGE_DIR)
  if (pack.code !== 0) throw new Error(`pack failed:\n${pack.out}`)
  const tarball = readdirSync(dest).find((name) => name.endsWith('.tgz'))
  if (!tarball) throw new Error(`no tarball in ${dest}:\n${pack.out}`)
  return join(dest, tarball)
}

export function tarballEntries(tarball: string): string[] {
  const list = run(['tar', '-tzf', tarball], dirname(tarball))
  if (list.code !== 0) throw new Error(list.out)
  return list.out.split('\n').filter(Boolean).sort()
}

/** Extracts the tarball's `package/` into `<target>`. */
export function extract(tarball: string, target: string): void {
  mkdirSync(target, { recursive: true })
  const result = run(['tar', '-xzf', tarball, '-C', target, '--strip-components=1'], dirname(tarball))
  if (result.code !== 0) throw new Error(result.out)
}

/**
 * A clean consumer project in the OS temp dir: the packed package plus
 * links to the repository's installed zod, @types/node and undici-types
 * (which @types/node needs) only. undici-types is @types/node's dependency,
 * not the package's, so it resolves from the resolved @types/node directory:
 * an isolated install links it only there.
 */
export function consumerProject(tarball: string): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-runtime-consumer-'))
  extract(tarball, join(root, 'node_modules/@motuslabs/agent-runtime'))
  const directoryOf = (dep: string, from: string) => dirname(Bun.resolveSync(`${dep}/package.json`, from))
  const nodeTypes = directoryOf('@types/node', PACKAGE_DIR)
  const links: [string, string][] = [
    ['zod', directoryOf('zod', PACKAGE_DIR)],
    ['@types/node', nodeTypes],
    ['undici-types', directoryOf('undici-types', nodeTypes)],
  ]
  for (const [dep, directory] of links) {
    const link = join(root, 'node_modules', dep)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(directory, link, 'dir')
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
        // Lib checks stay on so errors inside the shipped declarations are
        // reported; @types/node supplies console (the installed bun-types does
        // not type-check with lib checks on, which is why the repo skips them).
        noEmit: true, skipLibCheck: false, verbatimModuleSyntax: true, types: ['node'],
      },
      include: ['*.ts'],
    }),
  )
  return root
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

/** Every import specifier in shipped JS/declarations that escapes the package or names an undeclared module. */
export function boundaryViolations(packageRoot: string): string[] {
  const violations: string[] = []
  for (const file of filesUnder(join(packageRoot, 'dist'))) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const spec = match[1]!
      const where = `${relative(packageRoot, file)}: ${spec}`
      if (spec.startsWith('.')) {
        const target = relative(join(packageRoot, 'dist'), resolve(dirname(file), spec))
        if (target.startsWith('..')) violations.push(where)
      } else if (!spec.startsWith('node:') && !ALLOWED_BARE.has(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'))) {
        violations.push(where)
      }
    }
  }
  return violations.sort()
}
