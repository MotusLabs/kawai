// @reads: packages/agent-runtime/**, packages/claude-agent-sdk-no-cli/**
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_DIR, boundaryViolations, run, tarballEntries, tsc } from './helpers/packArtifact.js'
import { consumerFixture, installManifest, nativeContent, platformNames, runtimeContent, STUB_DIR, writeConsumer } from './helpers/consumerInstall.js'
import { controlledLaunch, recordedPids } from './helpers/consumerControlled.js'

const fixture = consumerFixture()
const bun = process.env.CONSUMER_BUN ?? process.execPath
let runtime: string
let stub: string
let claude: string
let codex: string

beforeAll(() => {
  expect(tsc('tsconfig.build.json', PACKAGE_DIR)).toEqual({ code: 0, out: '' })
  runtime = fixture.pack(PACKAGE_DIR, 'runtime-pack')
  stub = fixture.pack(STUB_DIR, 'stub-pack')
  for (const enabled of [false, true]) {
    const project = fixture.fresh(enabled ? 'claude' : 'codex')
    writeConsumer(project, installManifest(runtime, stub, enabled))
    const install = run([bun, 'install'], project)
    expect(install.code, install.out).toBe(0)
    expect(install.out).not.toMatch(/postinstall|downloading.*claude|claude.*--version/i)
    if (enabled) claude = project
    else codex = project
  }
}, 120_000)
afterAll(() => fixture.close())

test('consumer fixture closes admission, shares idempotent cleanup and removes roots after synchronous commands finish', async () => {
  const isolated = consumerFixture()
  expect(run([bun, '-e', 'process.stdout.write("joined")'], isolated.root)).toEqual({ code: 0, out: 'joined' })
  const first = isolated.close()
  expect(isolated.close()).toBe(first)
  expect(() => isolated.fresh('late')).toThrow('consumer fixture closed')
  expect(() => isolated.pack(STUB_DIR, 'late')).toThrow('consumer fixture closed')
  await first
  expect(existsSync(isolated.root)).toBe(false)
  expect(isolated.close()).toBe(first)
})

test('README recipes match the shipped examples and all eight published consumer-root aliases', () => {
  const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8')
  for (const name of ['headless', 'headless-codex', 'inline-requests']) {
    const marker = `<!-- example: examples/${name}.ts -->\n\`\`\`ts\n`
    const start = readme.indexOf(marker)
    expect(start).toBeGreaterThan(0)
    const body = start + marker.length
    expect(readme.slice(body, readme.indexOf('\n```', body)).trimEnd()).toBe(readFileSync(join(PACKAGE_DIR, `examples/${name}.ts`), 'utf8').trimEnd())
  }
  const manifest = JSON.parse(readme.split('```json\n')[1]!.split('\n```')[0]!)
  expect(Object.keys(manifest.overrides).sort()).toEqual([...platformNames].sort())
  expect(new Set(Object.values(manifest.overrides))).toEqual(new Set(['npm:@motuslabs/claude-agent-sdk-no-cli@0.1.0']))
  expect(readme).toContain('//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}')
})

// @covers: agent-runtime-distribution › CLI binaries are installed separately › Installation without native CLI packages
test('D02 I9: clean Bun installs use eight empty aliases with no native package contents or install hooks', () => {
  expect(run([bun, '--version'], fixture.root).out.trim()).toMatch(/^1\.(3\.0|4\.3)$/)
  expect(tarballEntries(stub)).toEqual(['package/LICENSE', 'package/README.md', 'package/package.json'])
  expect(nativeContent(claude)).toEqual([])
  expect(nativeContent(codex)).toEqual([])
  const installed = join(claude, 'node_modules/@motuslabs/agent-runtime')
  expect(boundaryViolations(installed)).toEqual([])
  expect(runtimeContent(installed)).toEqual([])
  for (const directory of [installed, join(claude, 'node_modules/@anthropic-ai/claude-agent-sdk')]) {
    const scripts = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts ?? {}
    expect(Object.keys(scripts).filter((key) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(key))).toEqual([])
  }
  expect(existsSync(join(codex, 'node_modules/@anthropic-ai/claude-agent-sdk'))).toBe(false)
  const manifest = JSON.parse(readFileSync(join(claude, 'package.json'), 'utf8'))
  expect(Object.keys(manifest.overrides).sort()).toEqual([...platformNames].sort())
  expect(new Set(Object.values(manifest.overrides))).toEqual(new Set([stub]))
})

// @covers: agent-runtime-distribution › The runtime is an ESM package with types › Clean external consumer
// @covers: agent-runtime-distribution › CLI binaries are installed separately › Missing executable
test('D01 D03: a clean no-SDK consumer compiles the contract and missing Codex does not break imports', () => {
  copyFileSync(join(PACKAGE_DIR, 'examples/contract-consumer.ts'), join(codex, 'contract-consumer.ts'))
  writeFileSync(join(codex, 'smoke.ts'), `
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import { hostQuotaReport } from '@motuslabs/agent-runtime/usage'
const driver = createCodexDriver({
  logger: { debug() {}, info() {}, warn() {}, error() {} }, callbacks: { onEvent() {} },
  launch: { cwd: ${JSON.stringify(codex)}, childEnv: {}, executablePath: '/missing/consumer-codex', homeDir: ${JSON.stringify(codex)}, cacheDir: ${JSON.stringify(codex)}, tempDir: ${JSON.stringify(codex)} },
  permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
})
let category = ''; let primary: unknown
let stopError: string | null = null
const raw = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(raw) : error instanceof AgentRuntimeError && error.causes.length ? error.causes.flatMap(raw) : [error]
try { await driver.start() } catch (error) { primary = error; if (error instanceof AgentRuntimeError) category = error.category; else throw error }
finally { try { await driver.shutdown() } catch (error) {
  if (!(error instanceof AgentRuntimeError) || raw(error).length !== 1 || raw(error)[0] !== primary) throw error
  stopError = error.category
} }
console.log(JSON.stringify({ category, stopError, source: hostQuotaReport({ status: 'allowed', windows: [], accountScope: 'unknown', receivedAt: 'r' }).source }))
`)
  const check = run([bun, 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], codex)
  expect(check.code, check.out).toBe(0)
  const result = run([bun, 'smoke.ts'], codex)
  expect(result.code, result.out).toBe(0)
  expect(JSON.parse(result.out)).toEqual({ category: 'dependency', stopError: 'stop', source: 'host-supplied' })
})

test('M-pack: the native-content oracle rejects binary payloads under every platform alias', () => {
  for (const name of platformNames) {
    const project = fixture.fresh(`control-${name.split('-').slice(-2).join('-')}`)
    const directory = join(project, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '0.3.289', bin: './claude' }))
    writeFileSync(join(directory, 'claude'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    expect(nativeContent(project)).toContain(`node_modules/${name}/claude`)
  }
})

test('M-pack: disguised runtime binaries, unresolved relative imports and workspace dependencies fail the artifact oracle', () => {
  const project = fixture.fresh('runtime-content-control')
  mkdirSync(join(project, 'dist'))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { private: 'workspace:*' } }))
  writeFileSync(join(project, 'dist/native.js'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  writeFileSync(join(project, 'dist/index.js'), "export * from './missing.js'\n")
  expect(runtimeContent(project)).toEqual(['missing: dist/index.js: ./missing.js', 'native: dist/native.js', 'repository dependency: private'])
})

test('D02 negative control: removing the required native platform override installs forbidden CLI contents', () => {
  const project = fixture.fresh('missing-override')
  const manifest = installManifest(runtime, stub, true)
  const native = `@anthropic-ai/claude-agent-sdk-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
  expect(platformNames).toContain(native)
  delete manifest.overrides[native]
  writeConsumer(project, manifest)
  const install = run([bun, 'install'], project)
  expect(install.code, install.out).toBe(0)
  // The native package is downloaded by the dependency manager, never run.
  const forbidden = nativeContent(project)
  expect(forbidden.some((path) => path.includes(native) && !path.endsWith('package.json'))).toBe(true)
}, 120_000)

function runExample(mode: string) {
  const project = fixture.fresh(`claude/example-${mode}`)
  const launches = { claude: controlledLaunch(project, 'claude', bun), codex: controlledLaunch(project, 'codex', bun) }
  const store = join(project, 'saved.json')
  writeFileSync(store, '{}')
  // The actual packed example runs unchanged, with no repository path or alias.
  copyFileSync(join(claude, 'node_modules/@motuslabs/agent-runtime/examples/headless.ts'), join(claude, 'headless.ts'))
  const main = readFileSync(join(PACKAGE_DIR, '__tests__/fixtures/consumerHeadless.ts'), 'utf8').replace('../../examples/headless.js', './headless.js')
  writeFileSync(join(claude, 'main.ts'), main)
  const check = run([bun, 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], claude)
  expect(check.code, check.out).toBe(0)
  const execution = run([bun, 'main.ts', JSON.stringify({ ...launches, store, mode })], claude)
  expect(execution.code, execution.out).toBe(0)
  return { project, output: JSON.parse(execution.out) }
}

function requireExited(project: string, runtime: string, count: number) {
  const pids = recordedPids(project, runtime)
  expect(pids).toHaveLength(count)
  for (const pid of pids) {
    let alive = true
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      alive = false
    }
    expect(alive, `owned ${runtime} pid ${pid}`).toBe(false)
  }
}

// @covers: agent-runtime-distribution › A headless example proves both runtimes › Headless lifecycle demonstration
// @covers: agent-runtime-distribution › Documentation covers the complete consumer contract › Consumer implements against documentation
// @covers: agent-runtime › Drivers operate without a Kawai server › Headless construction
// @covers: agent-runtime › Requests can be answered immediately › Inline response
test('D09 Q01-Q02 R01 R04-R05 R08: the packed public example answers, denies, interrupts, joins and reconstructs both providers', () => {
  const { project, output } = runExample('normal')
  const turns = output.turns
  expect(turns.map((turn: any) => turn.outcome)).toEqual(['success', 'success', 'success', 'interrupted', 'success', 'success', 'success', 'success', 'interrupted', 'success'])
  expect(turns[0].finalText).toBe('denied Bash (The tool use was denied)')
  expect(turns[1].finalText).toContain('"answers":{"Colour?":"Blue"}')
  expect(turns[2]).toMatchObject({ usage: null, model: null, toolCallCount: 0, compactionCount: 0 })
  const history = JSON.parse(turns[4].finalText)
  expect(history[0]).toBe('ask Bash {"command":"PRIVATE-INPUT"}')
  expect(history[1]).toContain('ask AskUserQuestion ')
  // Interrupt may cancel the hang before its native prompt is consumed.
  expect(history.length === 3 || history.length === 4).toBe(true)
  expect(turns[5]).toMatchObject({ toolCallCount: 2, compactionCount: 1, usage: { inputTokens: 60, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: null } })
  expect(JSON.parse(turns[6].finalText)).toEqual({ decision: 'decline' })
  expect(JSON.parse(turns[7].finalText)).toEqual({ answers: { colour: { answers: ['Blue'] } } })
  expect(turns[9].finalText).toContain('seen=')
  expect(output.prints.filter((fact: any) => 'outcome' in fact)).toEqual(turns.map((turn: any, index: number) => ({
    runtime: index < 5 ? 'claude' : 'codex', outcome: turn.outcome, usage: turn.usage,
    toolCallCount: turn.toolCallCount, compactionCount: turn.compactionCount,
  })))
  expect(Object.keys(output.saved).sort()).toEqual(['claude', 'codex'])
  const codexFrames = readFileSync(join(project, 'codex/home/received.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(codexFrames.filter((frame) => frame.method === 'thread/resume').map((frame) => frame.params.threadId)).toEqual([output.saved.codex.runtimeSessionId])
  for (const frame of codexFrames.filter((frame) => ['thread/start', 'thread/resume'].includes(frame.method))) {
    expect(frame.params).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' })
    expect(frame.params.dynamicTools).toBeUndefined()
  }
  for (const frame of codexFrames.filter((frame) => frame.method === 'turn/start')) expect(frame.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
  const claudeFrames = readFileSync(join(project, 'claude/frames.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(claudeFrames.filter((frame) => frame.argv).at(-1).argv).toContain(`--resume=${output.saved.claude.runtimeSessionId}`)
  expect(claudeFrames.filter((frame) => frame.request?.subtype === 'initialize').map((frame) => frame.request.sdkMcpServers ?? [])).toEqual([[], []])
  expect(existsSync(join(project, 'claude/work/executed-Bash'))).toBe(false)
  expect(output.stops.map((stop: any) => [stop.mode, stop.scope, stop.js])).toEqual([
    ['kill', 'agent-processes', 'settled'], ['shutdown', 'agent-processes', 'settled'],
    ['kill', 'agent-processes', 'settled'], ['shutdown', 'agent-processes', 'settled'],
  ])
  expect(output.stops.every((stop: any) => stop.processes.every((p: any) => p.state === 'exited' && p.groupCleared))).toBe(true)
  expect(output.prints.filter((fact: any) => fact.limit).map((fact: any) => [fact.limit, fact.cause ?? null])).toEqual([['failure', null], ['wait-start', null], ['wait-end', 'resumed']])
  expect(output.prints.filter((fact: any) => fact.source)).toEqual([{ runtime: 'codex', source: 'push', accountScope: 'session', windows: [{ percentUsed: 100, resetsAt: '2030-03-17T17:46:40.000Z' }, { percentUsed: 12, resetsAt: '2030-03-23T12:40:00.000Z' }] }])
  expect(JSON.stringify(output.prints)).not.toMatch(/PRIVATE-INPUT|SECRET-TOKEN|childEnv|command|Colour/)
  requireExited(project, 'claude', 2)
  requireExited(project, 'codex', 2)
}, 60_000)

test('A11: primary output and observer cleanup failures retain exact raw identity while owned process exits before removal', () => {
  for (const mode of ['print-failure', 'async-print-failure']) {
    const { project, output } = runExample(mode)
    expect(output.expected).toEqual(['primary', 'observer', 'observer', 'observer', 'observer'])
    requireExited(project, 'claude', 1)
    expect(existsSync(join(project, 'codex/pids'))).toBe(false)
  }
}, 60_000)
