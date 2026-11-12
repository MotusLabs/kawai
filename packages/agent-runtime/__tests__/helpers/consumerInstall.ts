// Synchronous package-manager probes finish before cleanup can remove roots.
// No native CLI/provider is run. All projects and pack destinations are owned
// by this fixture; the accepted shared once helper joins outside cleanup.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { ownedOnce } from './ownedCleanup.js'
import { PACKAGE_DIR, run } from './packArtifact.js'

export const platformNames = [
  'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl',
  'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64',
].map((suffix) => `@anthropic-ai/claude-agent-sdk-${suffix}`)

export function consumerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'consumer-batch-'))
  const closed = ownedOnce<void>()
  let closing = false
  const fresh = (name: string) => {
    if (closing) throw new Error('consumer fixture closed')
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    return path
  }
  return {
    root, fresh,
    pack(directory: string, name: string): string {
      const dest = fresh(name)
      const result = run([process.execPath, 'pm', 'pack', '--ignore-scripts', '--destination', dest, '--quiet'], directory)
      if (result.code) throw new Error(result.out)
      const file = readdirSync(dest).find((entry) => entry.endsWith('.tgz'))
      if (!file) throw new Error('pack produced no artifact')
      return join(dest, file)
    },
    close() { closing = true; return closed.run(async () => { rmSync(root, { recursive: true, force: true }) }) },
  }
}

export function installManifest(runtime: string, stub: string, claude: boolean) {
  return {
    name: 'independent-consumer', private: true, type: 'module',
    dependencies: {
      '@motuslabs/agent-runtime': runtime,
      ...(claude ? { '@anthropic-ai/claude-agent-sdk': '0.3.289' } : {}),
      typescript: '5.7.3', '@types/node': '22.10.2',
    },
    overrides: Object.fromEntries(platformNames.map((name) => [name, stub])),
  }
}

/** Examine actual installed platform-package contents, not just manifest intent. */
export function nativeContent(project: string): string[] {
  const violations: string[] = []
  const seen = new Set<string>()
  const visit = (directory: string) => {
    const actual = realpathSync(directory)
    if (seen.has(actual)) return
    seen.add(actual)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = statSync(path)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile() && path.includes('/claude-agent-sdk-')) {
        const allowed = ['package.json', 'README.md', 'LICENSE']
        if (!allowed.includes(entry.name)) violations.push(path.slice(project.length + 1))
        if (entry.name === 'package.json') {
          const manifest = JSON.parse(readFileSync(path, 'utf8'))
          if (manifest.name !== '@motuslabs/claude-agent-sdk-no-cli' || manifest.version !== '0.1.0' || manifest.scripts || manifest.bin || manifest.dependencies || manifest.optionalDependencies) {
            violations.push(path.slice(project.length + 1))
          }
        }
      }
    }
  }
  visit(join(project, 'node_modules'))
  return violations.sort()
}

export const STUB_DIR = resolve(PACKAGE_DIR, '../claude-agent-sdk-no-cli')
export function writeConsumer(project: string, manifest: object) {
  writeFileSync(join(project, 'package.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: false, noEmit: true, types: ['node'],
  }, include: ['*.ts'] }))
}

/** Reject binaries even when disguised as .js, and missing relative imports. */
export function runtimeContent(packageRoot: string): string[] {
  const violations: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      const bytes = readFileSync(file)
      const magic = bytes.subarray(0, 4).toString('hex')
      if (magic === '7f454c46' || magic.startsWith('4d5a') || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic)) violations.push(`native: ${relative(packageRoot, file)}`)
      if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
      for (const match of bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), match[1]!)
        const candidates = [target, `${target}.js`, `${target}.d.ts`, target.replace(/\.js$/, '.d.ts'), join(target, 'index.js'), join(target, 'index.d.ts')]
        if (!candidates.some((path) => existsSync(path))) violations.push(`missing: ${relative(packageRoot, file)}: ${match[1]}`)
      }
    }
  }
  walk(join(packageRoot, 'dist'))
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (/^(workspace:|file:|link:)/.test(String(version))) violations.push(`repository dependency: ${name}`)
    }
  }
  return violations.sort()
}
