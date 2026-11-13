// @reads: packages/agent-runtime/**
// Distribution oracles on the real packed tarball (design "Package and
// application table"): D01 (clean consumer, no Kawai files), D09 (the
// headless contract consumer compiles unchanged), a Codex-only consumer with
// no Claude SDK that compiles and runs the README's Codex example (omitted and
// supplied claimRateLimitsRead) and the `./usage` helpers, runtime `./usage` exports in the clean consumer, and the M-pack control (a
// repository-relative import in the shipped files is caught).
import { beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PACKAGE_DIR, boundaryViolations, buildAndPack, consumerProject, run, tarballEntries, tsc } from './helpers/packArtifact.js'
import { codexRoot, sent } from './helpers/codexDriverHarness.js'

let tarball: string
let consumer: string

beforeAll(() => {
  tarball = buildAndPack()
  consumer = consumerProject(tarball)
}, 120_000)

describe('packed @motuslabs/agent-runtime', () => {
  test('ships only dist, public examples, docs and the manifest', () => {
    const extra = tarballEntries(tarball).filter(
      (entry) => !/^package\/(dist\/.+\.(js|d\.ts)|examples\/(headless|headless-codex|inline-requests)\.ts|package\.json|README\.md|CHANGELOG\.md|LICENSE|NOTICE)$/.test(entry),
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
        "import { addTokenUsage, codexUpdateRequests, hostQuotaReport, type QuotaReport } from '@motuslabs/agent-runtime/usage'",
        "const error = new AgentRuntimeError({ category: 'busy', message: 'a turn is active' })",
        'const event: AgentEvent | null = null',
        "const report: QuotaReport = hostQuotaReport({ status: 'allowed', windows: [], accountScope: 'unknown', receivedAt: 'r' })",
        'const totals = { totalTokens: 10, inputTokens: 6, cachedInputTokens: 2, outputTokens: 4 }',
        'const update = codexUpdateRequests({ ...totals, totalTokens: 15, inputTokens: 9, outputTokens: 6 }, null, totals)',
        'const sum = addTokenUsage(null, { inputTokens: 1, outputTokens: 2, cacheReadTokens: null, cacheCreationTokens: null })',
        'console.log(JSON.stringify({ error: error.toJSON(), event, report, update: update.requests, sum }))',
      ].join('\n'),
    )
    const check = tsc('tsconfig.json', consumer)
    expect(check.out).toBe('')
    expect(check.code).toBe(0)
    const smoke = run([process.execPath, 'smoke.ts'], consumer)
    expect(smoke.code).toBe(0)
    expect(JSON.parse(smoke.out)).toEqual({
      error: { category: 'busy', message: 'a turn is active' },
      event: null,
      report: { status: 'allowed', windows: [], receivedAt: 'r', source: 'host-supplied', accountScope: 'unknown' },
      // A counter neither total reported stays unknown.
      update: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, cacheWriteInputTokens: null },
      sum: { inputTokens: 1, outputTokens: 2, cacheReadTokens: null, cacheCreationTokens: null },
    })
  })

  // @covers: agent-runtime-distribution › The runtime is an ESM package with types › Clean external consumer
  test('a Codex-only project without the Claude SDK type-checks and runs the headless Codex example from the tarball', () => {
    const project = consumerProject(tarball)
    expect(existsSync(join(project, 'node_modules/@anthropic-ai'))).toBe(false)
    copyFileSync(join(PACKAGE_DIR, 'examples/headless-codex.ts'), join(project, 'headless-codex.ts'))
    writeFileSync(
      join(project, 'main.ts'),
      [
        "import type { AgentDriver, LaunchConfiguration, ResumeCheckpoint } from '@motuslabs/agent-runtime'",
        "import { codexQuotaReport } from '@motuslabs/agent-runtime/usage'",
        "import { headlessCodex } from './headless-codex.js'",
        'const launch = JSON.parse(process.argv[2]!) as LaunchConfiguration',
        'const saved: ResumeCheckpoint[] = []',
        'const logger = { debug() {}, info() {}, warn() {}, error() {} }',
        'const owned: AgentDriver[] = []; const failures: unknown[] = []',
        'try {',
        'const driver = headlessCodex(launch, logger, { load: () => null, save: async (c) => void saved.push(c) })!',
        'owned.push(driver)',
        'await driver.start()',
        "const result = await (await driver.send('packed')).result",
        'const receipt = await driver.shutdown()',
        '// A second home, whose host claims no read: the supplied claim is asked once.',
        'let asked = 0',
        'const denied = headlessCodex(JSON.parse(process.argv[3]!) as LaunchConfiguration, logger, { load: () => null, save: async () => {} }, () => (asked++, false))!',
        'owned.push(denied)',
        'await denied.start()',
        "await (await denied.send('denied')).result",
        'await denied.shutdown()',
        "const quota = codexQuotaReport({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 0 }, secondary: null, rateLimitReachedType: 'rateLimitReached' }, 'report', 'r')",
        'console.log(JSON.stringify({ finalText: result.finalText, saved: saved.length, mode: receipt.mode, quota: quota && [quota.status, quota.source, quota.accountScope], asked }))',
        '} catch (error) { failures.push(error) } finally {',
        'const joined = await Promise.allSettled(owned.map(async (d) => d.shutdown()))',
        'for (const o of joined) if (o.status === "rejected" && !failures.includes(o.reason)) failures.push(o.reason)',
        '}',
        'if (failures.length) throw new AggregateError(failures, "consumer and cleanup failed")',
      ].join('\n'),
    )
    const check = tsc('tsconfig.json', project)
    expect(check.out).toBe('')
    expect(check.code).toBe(0)
    const root = codexRoot()
    const claimed = codexRoot()
    for (const home of [root.home, claimed.home]) writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: ['sample', 'key'].join('-') }))
    const main = run([process.execPath, 'main.ts', JSON.stringify(root.launch()), JSON.stringify(claimed.launch())], project)
    expect(main.code).toBe(0)
    // ./usage loads and runs without the Claude SDK.
    expect(JSON.parse(main.out.trim())).toEqual({ finalText: 'codex:dekcap|seen=', saved: 1, mode: 'shutdown', quota: ['limited', 'report', 'session'], asked: 1 })
    // Omitted, the packed driver sends its one read; the denied claim sends none.
    expect([sent(root, 'account/rateLimits/read').length, sent(claimed, 'account/rateLimits/read').length]).toEqual([1, 0])
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
