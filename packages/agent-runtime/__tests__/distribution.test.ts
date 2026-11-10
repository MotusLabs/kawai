// @reads: packages/agent-runtime/**
// Distribution oracles on the real packed tarball (design "Package and
// application table"): D01 (clean consumer, no Kawai files), D09 (the
// headless contract consumer compiles unchanged), a Codex-only consumer with
// no Claude SDK that compiles and runs the README's Codex example, and the M-pack control (a
// repository-relative import in the shipped files is caught).
import { beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PACKAGE_DIR, boundaryViolations, buildAndPack, consumerProject, run, tarballEntries, tsc } from './helpers/packArtifact.js'
import { codexRoot } from './helpers/codexDriverHarness.js'

let tarball: string
let consumer: string

beforeAll(() => {
  tarball = buildAndPack()
  consumer = consumerProject(tarball)
}, 120_000)

describe('packed @motuslabs/agent-runtime', () => {
  test('ships only dist, docs and the manifest', () => {
    const extra = tarballEntries(tarball).filter(
      (entry) => !/^package\/(dist\/.+\.(js|d\.ts)|package\.json|README\.md|CHANGELOG\.md|LICENSE|NOTICE)$/.test(entry),
    )
    expect(extra).toEqual([])
    expect(tarballEntries(tarball)).toContain('package/dist/index.d.ts')
  })

  test('shipped files import nothing outside the package and its declared dependencies', () => {
    expect(boundaryViolations(join(consumer, 'node_modules/@motuslabs/agent-runtime'))).toEqual([])
  })

  // @covers: agent-runtime-distribution › The runtime is an ESM package with types › Clean external consumer
  test('a clean Bun project type-checks the headless contract consumer unchanged and imports every entry', () => {
    copyFileSync(join(PACKAGE_DIR, 'examples/contract-consumer.ts'), join(consumer, 'contract-consumer.ts'))
    writeFileSync(
      join(consumer, 'smoke.ts'),
      [
        "import { AgentRuntimeError } from '@motuslabs/agent-runtime'",
        "import type { AgentEvent } from '@motuslabs/agent-runtime/events'",
        "import type { QuotaReport } from '@motuslabs/agent-runtime/usage'",
        "const error = new AgentRuntimeError({ category: 'busy', message: 'a turn is active' })",
        'const event: AgentEvent | null = null',
        'const report: QuotaReport | null = null',
        'console.log(JSON.stringify({ error: error.toJSON(), event, report }))',
      ].join('\n'),
    )
    const check = tsc('tsconfig.json', consumer)
    expect(check.out).toBe('')
    expect(check.code).toBe(0)
    const smoke = run([process.execPath, 'smoke.ts'], consumer)
    expect(smoke.code).toBe(0)
    expect(JSON.parse(smoke.out)).toEqual({ error: { category: 'busy', message: 'a turn is active' }, event: null, report: null })
  })

  // @covers: agent-runtime-distribution › The runtime is an ESM package with types › Clean external consumer
  test('a Codex-only project without the Claude SDK type-checks and runs the headless Codex example from the tarball', () => {
    const project = consumerProject(tarball)
    expect(existsSync(join(project, 'node_modules/@anthropic-ai'))).toBe(false)
    copyFileSync(join(PACKAGE_DIR, 'examples/headless-codex.ts'), join(project, 'headless-codex.ts'))
    writeFileSync(
      join(project, 'main.ts'),
      [
        "import type { LaunchConfiguration, ResumeCheckpoint } from '@motuslabs/agent-runtime'",
        "import { headlessCodex } from './headless-codex.js'",
        'const launch = JSON.parse(process.argv[2]!) as LaunchConfiguration',
        'const saved: ResumeCheckpoint[] = []',
        'const logger = { debug() {}, info() {}, warn() {}, error() {} }',
        'const driver = headlessCodex(launch, logger, { load: () => null, save: async (c) => void saved.push(c) })!',
        'await driver.start()',
        "const result = await (await driver.send('packed')).result",
        'const receipt = await driver.shutdown()',
        'console.log(JSON.stringify({ finalText: result.finalText, saved: saved.length, mode: receipt.mode }))',
      ].join('\n'),
    )
    const check = tsc('tsconfig.json', project)
    expect(check.out).toBe('')
    expect(check.code).toBe(0)
    const root = codexRoot()
    writeFileSync(join(root.home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: ['sample', 'key'].join('-') }))
    const main = run([process.execPath, 'main.ts', JSON.stringify(root.launch())], project)
    expect(main.code).toBe(0)
    expect(JSON.parse(main.out.trim())).toEqual({ finalText: 'codex:dekcap|seen=', saved: 1, mode: 'shutdown' })
  })

  test('control: the clean project cannot resolve a Kawai type for a consumer', () => {
    const project = consumerProject(tarball)
    writeFileSync(
      join(project, 'kawai-import.ts'),
      "import type { ChatEvent } from '@motuslabs/kawai/src/shared/chat'\nexport type E = ChatEvent\n",
    )
    const check = tsc('tsconfig.json', project)
    expect(check.code).not.toBe(0)
    expect(check.out).toContain("Cannot find module '@motuslabs/kawai/src/shared/chat'")
  })

  test('control M-pack: a repository-relative import in a shipped file is reported', () => {
    const copy = join(mkdtempSync(join(tmpdir(), 'agent-runtime-mpack-')), 'pkg')
    cpSync(join(consumer, 'node_modules/@motuslabs/agent-runtime'), copy, { recursive: true })
    appendFileSync(join(copy, 'dist/index.js'), "\nexport * from '../../../src/shared/chat.js'\n")
    appendFileSync(join(copy, 'dist/options.d.ts'), "\nimport type { ChatEvent } from '@shared/chat'\n")
    expect(boundaryViolations(copy)).toEqual([
      'dist/index.js: ../../../src/shared/chat.js',
      'dist/options.d.ts: @shared/chat',
    ])
  })
})
