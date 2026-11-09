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
//   saved transcript holds.
// - Missing target: start rejects with category `resume`; no prompt,
//   checkpoint or transcript of a fresh conversation exists afterwards.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClaudeDriver } from '../src/claude/index.js'
import type { ClaudeAgentDriver, ProcessEndReport, ResumeCheckpoint } from '../src/contract.js'
import type { AgentEvent } from '../src/events.js'
import type { LaunchConfiguration } from '../src/options.js'
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
async function host(config: { launch: LaunchConfiguration; store: string; resume: boolean; prompts: string[]; stop: 'kill' | 'shutdown' }): Promise<HostReport> {
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

describe('Claude resume across host processes (fake CLI sessions)', () => {
  // @covers: agent-runtime › Shutdown preserves resumability › Resume after forced process termination
  test('L02/A1: after a killed host, a new driver in another host process continues the saved conversation from the retained homes', async () => {
    const home = fakeClaudeHome()
    const launch = home.launch({ FAKE_CLAUDE_SESSIONS: '1' })
    const store = join(home.root, 'checkpoint.json')
    const marker = `marker-${crypto.randomUUID()}`

    const a = await host({ launch, store, resume: false, prompts: [marker], stop: 'kill' })
    expect(a.start).toBe('ok')
    expect(a.results).toEqual([{ outcome: 'success', finalText: `echo: ${marker}` }])
    // The caller's store holds the identity the runtime reported, and nothing else.
    expect(a.checkpoints).toHaveLength(1)
    const saved = a.checkpoints[0]!
    expect(Object.keys(saved).sort()).toEqual(['runtime', 'runtimeSessionId'])
    expect(saved.runtime).toBe('claude')
    expect(typeof saved.runtimeSessionId).toBe('string')
    expect(a.stored).toEqual(saved)
    expect(a.stop).toEqual({ mode: 'kill', processes: 1 })

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
})
