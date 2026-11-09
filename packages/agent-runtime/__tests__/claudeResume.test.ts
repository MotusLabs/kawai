// @reads: packages/agent-runtime/__tests__/fixtures/**
// Claude resume across host processes (task 4.4 Claude unit; L02/R10, the
// runtime spec's "Shutdown preserves resumability"). The real SDK and the
// owned spawner run the fake CLI in its session mode. The fake keeps each
// conversation's transcript under the launch's explicit HOME, and on a
// missing --resume target it refuses before initialize in the order the
// pinned CLI 2.1.289 uses (its transcript loader runs before the stdin loop
// that answers initialize). That order is source-qualified for the fake; it
// is not native acceptance.
//
// - Cross-process: host A and host B are separate bun processes. Each builds
//   its own driver through the public factory, and they share only the
//   retained homes and the caller's file checkpoint store. B proves it
//   continued A's conversation by the unique prompt A sent, which only the
//   saved transcript holds. Host A stops its CLI with an awaited kill (or
//   shutdown) and then exits normally: these rows are not abrupt host death.
// - Caller authority: an identity the caller holds resumes even when an
//   earlier owner's store refused to persist it.
// - Missing target: start rejects with category `resume`; no prompt,
//   checkpoint or transcript of a fresh conversation exists afterwards. The
//   classification is safe both ways: an early exit without the refusal is
//   transport, and the refusal text on a fresh launch is not a resume failure.
// - In one host: an unexpected exit, then an explicit start, resumes the
//   same conversation with that generation's launch and the same policy; a
//   stopped driver cannot touch the conversation a new driver resumed.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeDriver } from '../src/claude/index.js'
import type { ClaudeAgentDriver, ProcessEndReport, ResumeCheckpoint } from '../src/contract.js'
import type { AgentEvent } from '../src/events.js'
import type { ClaudeDriverOptions, LaunchConfiguration } from '../src/options.js'
import { fakeClaudeHome, type FakeClaudeHome } from './helpers/fakeClaudeHome.js'

const HOST = join(import.meta.dir, 'fixtures', 'resumeHost.ts')
const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }

const hosts = new Set<ChildProcess>()
let driver: ClaudeAgentDriver | null = null
afterEach(async () => {
  // Only this file's own host children; each is waited for.
  for (const child of hosts) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  hosts.clear()
  await driver?.kill().catch(() => {})
  driver = null
})

interface HostReport {
  pid: number
  resumed: ResumeCheckpoint | null
  start: 'ok' | { category: string | null; message: string }
  results?: { outcome: string; finalText: string | null }[]
  checkpoints: ResumeCheckpoint[]
  stored: ResumeCheckpoint | null
  stop: { mode: string; processes: number } | { category: string | null; message: string }
}

/** Run one host process to completion and read its report. */
async function host(config: { launch: LaunchConfiguration; store: string; resume: boolean; resumeId?: string; rejectCheckpoint?: boolean; prompts: string[]; stop: 'kill' | 'shutdown' }): Promise<HostReport> {
  const child = spawn(process.execPath, [HOST, JSON.stringify(config)], { cwd: config.launch.cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  hosts.add(child)
  let out = ''
  let err = ''
  child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
  child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
  const code = await new Promise<number | null>((resolve) => child.once('close', (exitCode) => resolve(exitCode)))
  hosts.delete(child)
  if (code !== 0) throw new Error(`host exited ${code}: ${err}`)
  return JSON.parse(out.trim().split('\n').at(-1)!) as HostReport
}

const sessionsOf = (home: FakeClaudeHome) => join(home.root, 'home', '.fake-claude', 'sessions')

/** Host A runs one conversation and stops its CLI with `stopA`; host B resumes it from the store. */
async function crossHost(stopA: 'kill' | 'shutdown'): Promise<void> {
  const home = fakeClaudeHome()
  const launch = home.launch({ FAKE_CLAUDE_SESSIONS: '1' })
  const store = join(home.root, 'checkpoint.json')
  const marker = `marker-${crypto.randomUUID()}`

  const a = await host({ launch, store, resume: false, prompts: [marker], stop: stopA })
  expect(a.start).toBe('ok')
  expect(a.results).toEqual([{ outcome: 'success', finalText: `echo: ${marker}` }])
  // The caller's store holds the identity the runtime reported, and nothing else.
  expect(a.checkpoints).toHaveLength(1)
  const saved = a.checkpoints[0]!
  expect(Object.keys(saved).sort()).toEqual(['runtime', 'runtimeSessionId'])
  expect(saved.runtime).toBe('claude')
  expect(typeof saved.runtimeSessionId).toBe('string')
  expect(a.stored).toEqual(saved)
  expect(a.stop).toEqual({ mode: stopA, processes: 1 })

  const b = await host({ launch, store, resume: true, prompts: ['history'], stop: 'shutdown' })
  expect(b.pid).not.toBe(a.pid)
  expect(b.resumed).toEqual(saved)
  expect(b.start).toBe('ok')
  // Only the saved transcript holds A's prompt: B's conversation is A's.
  expect(b.results).toEqual([{ outcome: 'success', finalText: JSON.stringify([marker]) }])
  // The resumed identity is already saved: no new checkpoint, the store unchanged.
  expect(b.checkpoints).toEqual([])
  expect(b.stored).toEqual(saved)
  expect(b.stop).toEqual({ mode: 'shutdown', processes: 1 })
  // B's CLI was launched with the saved identity, and the homes hold one conversation.
  expect(home.argv().at(-1)).toContain(`--resume=${saved.runtimeSessionId}`)
  expect(readdirSync(sessionsOf(home))).toEqual([`${saved.runtimeSessionId}.jsonl`])
}

interface Sink { events: AgentEvent[]; ends: ProcessEndReport[]; checkpoints: ResumeCheckpoint[] }
const sink = (): Sink => ({ events: [], ends: [], checkpoints: [] })

/** A driver over the fake in this process; the latest one is the file's cleanup target. */
function local(launch: ClaudeDriverOptions['launch'], resume: string | null, into: Sink): ClaudeAgentDriver {
  const created = createClaudeDriver({
    launch,
    logger,
    permissions: { mode: 'default', enabledTools: ['Read'], disallowedTools: ['Bash'] },
    callbacks: { onEvent: (e) => into.events.push(e), onProcessEnd: (r) => into.ends.push(r), onCheckpoint: (c) => void into.checkpoints.push(c) },
    ...(resume === null ? {} : { resume: { runtime: 'claude', runtimeSessionId: resume } }),
  })
  driver = created
  return created
}
const category = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: { category?: string }) => e.category ?? null)
/** A launch's argv without its --resume flag: the policy it was given. */
const policy = (argv: string[]) => argv.filter((arg) => !arg.startsWith('--resume'))

describe('Claude resume across host processes (fake CLI sessions)', () => {
  // @covers: agent-runtime › Shutdown preserves resumability › Resume after forced process termination
  test('L02/A1: after host A\'s CLI was killed (awaited kill, then a normal host exit), a new driver in host B continues the saved conversation from the retained homes', async () => {
    await crossHost('kill')
  })

  test('L02/A1: after host A\'s CLI was shut down (then a normal host exit), a new driver in host B continues the saved conversation', async () => {
    await crossHost('shutdown')
  })

  test('A2/I1: a caller-held identity resumes in host B even though host A\'s store refused to persist it', async () => {
    const home = fakeClaudeHome()
    const launch = home.launch({ FAKE_CLAUDE_SESSIONS: '1' })
    const store = join(home.root, 'checkpoint.json')
    const marker = `marker-${crypto.randomUUID()}`
    const a = await host({ launch, store, resume: false, rejectCheckpoint: true, prompts: [marker], stop: 'kill' })
    expect(a.checkpoints).toHaveLength(1)
    expect(a.stored).toBeNull()
    expect(a.stop).toMatchObject({ category: 'stop' })
    const held = a.checkpoints[0]!.runtimeSessionId
    const b = await host({ launch, store, resume: false, resumeId: held, prompts: ['history'], stop: 'shutdown' })
    expect(b.resumed).toEqual({ runtime: 'claude', runtimeSessionId: held })
    expect(b.start).toBe('ok')
    expect(b.results).toEqual([{ outcome: 'success', finalText: JSON.stringify([marker]) }])
    expect(b.checkpoints).toEqual([])
    expect(b.stored).toBeNull()
    expect(home.argv().at(-1)).toContain(`--resume=${held}`)
    expect(readdirSync(sessionsOf(home))).toEqual([`${held}.jsonl`])
  })

  // @covers: agent-runtime › Shutdown preserves resumability › Missing or invalid resume identity
  test('R10/A2: a target with no transcript fails start with category resume before initialize, with no prompt, checkpoint or fresh conversation', async () => {
    const home = fakeClaudeHome()
    const missing = crypto.randomUUID()
    const events: AgentEvent[] = []
    const ends: ProcessEndReport[] = []
    const checkpoints: ResumeCheckpoint[] = []
    driver = createClaudeDriver({
      launch: home.launch({ FAKE_CLAUDE_SESSIONS: '1' }),
      logger,
      permissions: { mode: 'default', enabledTools: ['Read'], disallowedTools: [] },
      callbacks: { onEvent: (e) => events.push(e), onProcessEnd: (r) => ends.push(r), onCheckpoint: (c) => void checkpoints.push(c) },
      resume: { runtime: 'claude', runtimeSessionId: missing },
    })
    let failure: { category?: string; message?: string; causes?: readonly unknown[] } | null = null
    await driver.start().catch((e) => (failure = e))
    const refused = failure as { category?: string; message?: string; causes?: readonly unknown[] } | null
    expect([refused?.category, refused?.message, refused?.causes?.length]).toEqual(['resume', 'the runtime refused the resume target or its transcript is unavailable', 1])
    expect(driver.state).toBe('exited')
    // The CLI exited before reading stdin: no initialize was answered and no prompt was sent.
    const launches = home.argv()
    expect(launches).toHaveLength(1)
    expect(launches[0]).toContain(`--resume=${missing}`)
    expect(home.received()).toEqual([])
    // Nothing fresh: no checkpoint, no transcript, no turn.
    expect(checkpoints).toEqual([])
    expect(existsSync(sessionsOf(home))).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['error'])
    expect(ends).toEqual([{ generation: 1, code: 1, signal: null, reason: null }])
    // A send is refused: the driver did not start.
    const sent = await driver.send('hello').then(() => null, (e: { category?: string }) => e.category)
    expect(sent).toBe('not-ready')
    // The stop still reports every owned failure (accepted semantics): the SDK's read of the CLI's
    // startup-failure frame, the refused start, and the process's own exit 1 before the stop.
    type Cause = { category?: string; message?: string; facts?: { code: number | null; observedBeforeStop: boolean | null } }
    const stopped = await driver.shutdown().then(() => null, (e: { category?: string; causes?: readonly Cause[] }) => e)
    expect(stopped?.category).toBe('stop')
    const causes = stopped?.causes ?? []
    expect(causes.map((c) => [c.category ?? null, c.facts?.code ?? null, c.facts?.observedBeforeStop ?? null])).toEqual([[null, null, null], ['resume', null, null], ['transport', 1, true]])
    expect(causes[0]?.message).toContain(`No conversation found with session ID: ${missing}`)
    driver = null
  })

  // @covers: agent-runtime › Shutdown preserves resumability › Missing or invalid resume identity
  test('G1/R10: a nonconforming CLI that silently starts a fresh conversation on a missing target is refused at its first init; nothing is adopted', async () => {
    const home = fakeClaudeHome()
    const missing = crypto.randomUUID()
    const into = sink()
    const d = local(home.launch({ FAKE_CLAUDE_SESSIONS: '1', FAKE_CLAUDE_RESUME: 'fresh' }), missing, into)
    await d.start()
    const result = await (await d.send('hello')).result
    expect([result.outcome, result.error?.category, result.finalText]).toEqual(['failed', 'resume', null])
    // The substituted conversation's identity never reached the caller.
    expect(into.checkpoints).toEqual([])
    expect(into.events.flatMap((e) => (e.type === 'error' ? [e.error.category] : []))).toEqual(['resume'])
    expect(await category(d.send('again'))).toBe('resume')
    expect(home.argv()[0]).toContain(`--resume=${missing}`)
    const stopped = await d.shutdown().then(() => null, (e: { category?: string; causes?: readonly { category?: string }[] }) => e)
    expect(stopped?.category).toBe('stop')
    expect(stopped?.causes?.[0]?.category).toBe('resume')
    driver = null
  })

  test('R10: a start failure is classified resume only when a resumed launch ended with the refusal; other early exits stay transport', async () => {
    const rows: { name: string; text: string; resume: string | null; expected: string }[] = [
      { name: 'resumed, refusal on stderr only', text: '--resume requires a valid session ID', resume: 'sess-x', expected: 'resume' },
      { name: 'resumed, unrelated early exit', text: 'fatal: cannot open settings', resume: 'sess-x', expected: 'transport' },
      { name: 'fresh, refusal text on stderr', text: 'No conversation found with session ID: sess-x', resume: null, expected: 'transport' },
    ]
    const seen: string[] = []
    for (const row of rows) {
      const home = fakeClaudeHome()
      const d = local(home.launch({ FAKE_CLAUDE_SESSIONS: '1', FAKE_CLAUDE_EARLY_EXIT: row.text }), row.resume, sink())
      seen.push(`${row.name}: ${await category(d.start())}`)
      expect(home.received()).toEqual([])
      await d.shutdown().catch(() => {})
    }
    expect(seen).toEqual(rows.map((row) => `${row.name}: ${row.expected}`))
    driver = null
  })

  // @covers: agent-runtime › Unexpected process end is reported › Crash during a turn
  test('A3: after an unexpected exit, an explicit start resumes the same conversation with that generation\'s launch and the same policy', async () => {
    const home = fakeClaudeHome()
    let generation = 0
    const launches: string[] = []
    const into = sink()
    const d = local(() => {
      generation += 1
      launches.push(String(generation))
      return home.launch({ FAKE_CLAUDE_SESSIONS: '1', GEN: String(generation) })
    }, null, into)
    await d.start()
    const marker = `marker-${crypto.randomUUID()}`
    expect((await (await d.send(marker)).result).outcome).toBe('success')
    expect(into.checkpoints).toHaveLength(1)
    const id = into.checkpoints[0]!.runtimeSessionId
    const crashed = await (await d.send('crash')).result
    expect(crashed.outcome).toBe('process-ended')
    while (into.ends.length === 0) await Bun.sleep(5)
    expect(into.ends).toEqual([{ generation: 1, code: 3, signal: null, reason: null }])
    await d.start()
    // Generation 2 read its own launch and resumed the reported identity.
    expect(launches).toEqual(['1', '2'])
    const [first, second] = home.argv()
    expect(first!.some((arg) => arg.startsWith('--resume'))).toBe(false)
    expect(second).toContain(`--resume=${id}`)
    expect(policy(second!)).toEqual(policy(first!))
    expect((await (await d.send('env GEN')).result).finalText).toBe(JSON.stringify({ GEN: '2' }))
    expect((await (await d.send('history')).result).finalText).toBe(JSON.stringify([marker, 'crash', 'env GEN']))
    // Still one conversation and one checkpoint: the resumed identity was already the caller's.
    expect(into.checkpoints).toHaveLength(1)
    expect(readdirSync(sessionsOf(home))).toEqual([`${id}.jsonl`])
    expect(into.ends).toHaveLength(1)
    // The stop still owns generation 1's crash (accepted semantics): the SDK's read failure and that
    // exit; generation 2's graceful end is no failure.
    type Cause = { category?: string; message?: string; facts?: { generation: number; code: number | null; observedBeforeStop: boolean | null } }
    const stopped = await d.shutdown().then(() => null, (e: { category?: string; causes?: readonly Cause[] }) => e)
    expect(stopped?.category).toBe('stop')
    const causes = stopped?.causes ?? []
    expect(causes.map((c) => [c.category ?? null, c.facts?.generation ?? null, c.facts?.code ?? null, c.facts?.observedBeforeStop ?? null])).toEqual([[null, null, null, null], ['transport', 1, 3, true]])
    expect(causes[0]?.message).toBe('Claude Code process exited with code 3')
    driver = null
  })

  test('I1: a stopped driver cannot touch the conversation a new driver resumed: it refuses work and reports nothing more', async () => {
    const home = fakeClaudeHome()
    const launch = home.launch({ FAKE_CLAUDE_SESSIONS: '1' })
    const old = sink()
    const d1 = local(launch, null, old)
    await d1.start()
    const marker = `marker-${crypto.randomUUID()}`
    await (await d1.send(marker)).result
    const id = old.checkpoints[0]!.runtimeSessionId
    await d1.kill()
    const settled = { events: old.events.length, ends: old.ends.length, checkpoints: old.checkpoints.length }

    const d2 = local(launch, id, sink())
    await d2.start()
    expect([await category(d1.send('intrude')), await category(d1.start())]).toEqual(['stopped', 'stopped'])
    expect((await (await d2.send('history')).result).finalText).toBe(JSON.stringify([marker]))
    expect({ events: old.events.length, ends: old.ends.length, checkpoints: old.checkpoints.length }).toEqual(settled)
    // The prompts that reached any CLI are the two drivers' own.
    const prompts = home.received().filter((f) => f.type === 'user').map((f) => (f.message as { content: unknown }).content)
    expect(JSON.stringify(prompts)).not.toContain('intrude')
    await d2.shutdown()
    driver = null
  })
})
