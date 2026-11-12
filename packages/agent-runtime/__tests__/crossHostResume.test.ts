// @reads: packages/agent-runtime/__tests__/fixtures/**
// Cross-host resume with correlated identities (task 4.4, batch B U3; L02,
// L21-L23 identity, R10 no fallback, I2). For BOTH public drivers, host
// process 1 (fixtures/crossHostDriver.ts) starts fresh over an isolated
// retained home, sends a unique marker, persists the checkpoint in the
// caller's file store and stops with an awaited kill; the test waits for
// that host's actual exit, then checks that the host and every leader its
// receipt names are gone. Only then does host process 2 resume from the
// store and continue the same conversation (its reply holds host 1's
// marker), ending with an awaited shutdown. In each host every handle, its
// result and its onTurnResult callback name the same turnId and messageUuid,
// and the runtime received exactly those message ids (Codex
// clientUserMessageId on turn/start, Claude user-frame uuid). The providers
// are the package's controlled fakes (fakeClaude in session mode, the fake
// app-server): this is not native acceptance (task 7.4).
//
// Cleanup is one shared ownedAggregate (helpers/ownedCleanup.ts): each
// case's entry reserves closing before any effect, so no host spawns after
// its cleanup began. A host is registered with its whole collection (stdout,
// stderr and actual exit, joined with allSettled) before anything is awaited,
// so the parent owns it even when a collection rejects. The cleanup SIGKILLs
// every live host, joins its exit and both streams, keeps each raw failure
// without skipping the remaining hosts, and removes the roots last. Each
// host script stops its driver in finally on every post-construction path
// and reports every failure raw (fixtures/crossHostDriver.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchConfiguration } from '../src/options.js'
import { alive, BUN, codexRoot, pids, sent } from './helpers/codexDriverHarness.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'
import { ownedAggregate, ownedOnce, type OwnedOnce } from './helpers/ownedCleanup.js'

const HOST = join(import.meta.dir, 'fixtures', 'crossHostDriver.ts')

interface Case {
  closing: boolean
  hosts: Set<{ child: Bun.Subprocess; collected: Promise<PromiseSettledResult<unknown>[]> }>
  roots: string[]
  closed: OwnedOnce<void>
}

/** Close one case once: refuse new hosts, kill and await live ones, then remove the roots. */
const dispose = (entry: Case): Promise<void> =>
  entry.closed.run(async () => {
    entry.closing = true
    const failures: unknown[] = []
    try {
      for (const { child, collected } of entry.hosts) {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch (error) {
          failures.push(error)
        }
        // Exit and both streams; a collection failure already reached its test.
        await collected
      }
    } finally {
      for (const root of entry.roots) rmSync(root, { recursive: true, force: true })
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'cross-host case cleanup failed')
  })

const owned = ownedAggregate<Case, void>({
  join: dispose,
  failures: (_entry, outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []),
  message: 'cross-host cleanups failed',
})
afterEach(() => owned.join())

function newCase(root: string): Case {
  const entry: Case = { closing: false, hosts: new Set(), roots: [root], closed: ownedOnce<void>() }
  owned.add(entry)
  return entry
}

interface Ids { turnId: string; messageUuid: string | null }
interface HostReport {
  pid: number
  resumed: { runtime: string; runtimeSessionId: string } | null
  handles: Ids[]
  results: Array<Ids & { outcome: string; finalText: string | null }>
  callbacks: Array<Ids & { outcome: string }>
  checkpoints: Array<{ runtime: string; runtimeSessionId: string }>
  stored: { runtime: string; runtimeSessionId: string } | null
  receipt: { mode: string; processes: Array<{ state: string; pid?: number }> } | null
  ends: unknown[]
  failures: string[]
}

/** Run one host process to its actual exit and read its report. */
async function host(entry: Case, root: string, config: Record<string, unknown>): Promise<HostReport> {
  if (entry.closing) throw new Error('the case closed before the host spawned')
  const child = Bun.spawn([BUN, HOST, JSON.stringify(config)], { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: root } })
  const collected = Promise.allSettled([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  entry.hosts.add({ child, collected })
  const outcomes = await collected
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  const [stdout, stderr, code] = outcomes.map((o) => (o as PromiseFulfilledResult<unknown>).value) as [string, string, number]
  if (code !== 0) throw new Error(`host exited ${code}: ${stderr}\n${stdout}`)
  // The host has actually exited (reaped); nothing it owned may outlive it.
  expect(alive(child.pid)).toBe(false)
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as HostReport
}

/** Every handle, result and callback of one host name the same ids, once each. */
function correlated(report: HostReport, outcomes: string[]): string[] {
  expect(report.handles).toHaveLength(outcomes.length)
  expect(report.results.map(({ turnId, messageUuid }) => ({ turnId, messageUuid }))).toEqual(report.handles)
  expect(report.callbacks).toEqual(report.results.map(({ turnId, messageUuid, outcome }) => ({ turnId, messageUuid, outcome })))
  expect(report.results.map((r) => r.outcome)).toEqual(outcomes)
  expect(new Set(report.handles.map((h) => h.turnId)).size).toBe(outcomes.length)
  return report.handles.map((h) => h.messageUuid!)
}

/** The receipt reports each leader exited, and none of them is alive after the host's exit. */
function leadersGone(report: HostReport, mode: string): number[] {
  expect(report.failures).toEqual([])
  expect(report.receipt?.mode).toBe(mode)
  const processes = report.receipt!.processes
  expect(processes.length).toBeGreaterThan(0)
  for (const fact of processes) expect(fact.state).toBe('exited')
  const leaders = processes.map((p) => p.pid!)
  expect(leaders.filter(alive)).toEqual([])
  return leaders
}

interface Runtime {
  name: 'claude' | 'codex'
  fixture(): { root: string; launch: LaunchConfiguration; received(): string[]; recorded(): number[] }
  recall: string
  expected(marker: string): string
}

const RUNTIMES: Runtime[] = [
  {
    name: 'claude',
    fixture: () => {
      const home = fakeClaudeHome()
      return {
        root: home.root,
        launch: home.launch({ FAKE_CLAUDE_SESSIONS: '1' }),
        received: () => home.received().filter((frame) => frame.type === 'user').map((frame) => frame.uuid as string),
        recorded: () => home.pids(),
      }
    },
    recall: 'history',
    expected: (marker) => JSON.stringify([marker]),
  },
  {
    name: 'codex',
    fixture: () => {
      const root = codexRoot()
      return {
        root: root.root,
        launch: root.launch(),
        received: () => sent(root, 'turn/start').map((m) => m.params.clientUserMessageId as string),
        recorded: () => pids(root.home),
      }
    },
    recall: 'recall',
    expected: (marker) => `codex:llacer|seen=${marker}`,
  },
]

// One body per case, run once per runtime by the literal titles below (so a
// coverage citation resolves each title), in the original claude-then-codex order.
async function resumeAcrossHosts(runtime: Runtime): Promise<void> {
  const fixture = runtime.fixture()
  const entry = newCase(fixture.root)
  const store = join(fixture.root, 'checkpoint.json')
  const marker = `marker-${crypto.randomUUID()}`
  const base = { runtime: runtime.name, launch: fixture.launch, store }

  const first = await host(entry, fixture.root, { ...base, resume: false, prompts: [marker], stop: 'kill' })
  expect(first.resumed).toBeNull()
  expect(first.checkpoints).toHaveLength(1)
  const saved = first.checkpoints[0]!
  expect(saved.runtime).toBe(runtime.name)
  expect(first.stored).toEqual(saved)
  const firstIds = correlated(first, ['success'])
  const firstLeaders = leadersGone(first, 'kill')
  // Every process the fake recorded for this home is gone before host 2 starts.
  expect(fixture.recorded().filter(alive)).toEqual([])

  const second = await host(entry, fixture.root, { ...base, resume: true, prompts: [runtime.recall], stop: 'shutdown' })
  expect(second.pid).not.toBe(first.pid)
  expect(second.resumed).toEqual(saved)
  // The same conversation: host 2's reply holds host 1's unique marker.
  expect(second.results[0]!.finalText).toBe(runtime.expected(marker))
  // The resumed identity is already saved: no new checkpoint, the store unchanged.
  expect(second.checkpoints).toEqual([])
  expect(second.stored).toEqual(saved)
  const secondIds = correlated(second, ['success'])
  const secondLeaders = leadersGone(second, 'shutdown')
  expect(secondLeaders.some((pid) => firstLeaders.includes(pid))).toBe(false)
  expect(fixture.recorded().filter(alive)).toEqual([])
  // The runtime received exactly the message ids the handles reported, in order.
  expect(fixture.received()).toEqual([...firstIds, ...secondIds])
  expect(new Set([...firstIds, ...secondIds]).size).toBe(2)
  // Neither host saw an unexpected process end.
  expect([first.ends, second.ends]).toEqual([[], []])
}

async function failedStoreHost(runtime: Runtime): Promise<void> {
  const fixture = runtime.fixture()
  const entry = newCase(fixture.root)
  // The store's directory does not exist: the caller's persistence throws.
  const store = join(fixture.root, 'missing', 'checkpoint.json')
  const outcome = await host(entry, fixture.root, { runtime: runtime.name, launch: fixture.launch, store, resume: false, prompts: ['one'], stop: 'kill' }).then(
    () => null,
    (error: Error) => error.message,
  )
  expect(outcome).toStartWith('host exited 1: ')
  const report = JSON.parse(outcome!.trim().split('\n').at(-1)!) as HostReport
  // The expected failures, exactly: the store's raw ENOENT, kept in order. A start
  // that awaited the persistence rejects with category checkpoint (Codex readiness
  // always does; Claude does when the persistence lands before its start settles),
  // and the stop in finally then fails with every retained cause, the raw one first.
  const raw = `Error: ENOENT: no such file or directory, open '${store}.tmp'`
  const refused = `checkpoint: the runtime identity could not be persisted <= [${raw}]`
  const shapes = [
    [refused, `stop: stop failed: 2 owned operation(s) failed <= [${raw} ; ${refused}]`],
    ...(runtime.name === 'claude' ? [[`stop: stop failed: 1 owned operation(s) failed <= [${raw}]`]] : []),
  ]
  expect(shapes).toContainEqual(report.failures)
  // A failed stop carries no receipt; the stop still ran, and no process the fake started outlives the host.
  expect(report.receipt).toBeNull()
  expect(fixture.recorded().length).toBeGreaterThan(0)
  expect(fixture.recorded().filter(alive)).toEqual([])
}

const [CLAUDE, CODEX] = RUNTIMES as [Runtime, Runtime]

describe('cross-host resume with correlated identities (4.4, both public drivers)', () => {
  // @covers: agent-runtime › Shutdown preserves resumability › Resume after forced process termination
  test("claude: host 2 resumes host 1's saved conversation only after host 1 exited; handles, results, callbacks and wire ids correlate and every leader is gone", () => resumeAcrossHosts(CLAUDE))

  test('claude: a host whose checkpoint store cannot be written still stops its driver in finally, reports the raw failure and exits nonzero, and the parent finds every leader gone', () => failedStoreHost(CLAUDE))

  // @covers: agent-runtime › Shutdown preserves resumability › Resume after forced process termination
  test("codex: host 2 resumes host 1's saved conversation only after host 1 exited; handles, results, callbacks and wire ids correlate and every leader is gone", () => resumeAcrossHosts(CODEX))

  test('codex: a host whose checkpoint store cannot be written still stops its driver in finally, reports the raw failure and exits nonzero, and the parent finds every leader gone', () => failedStoreHost(CODEX))
})
