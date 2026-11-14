// @reads: packages/agent-runtime/__tests__/fixtures/**
// The private per-method request deadlines (task-5906f19c A7/V6): a
// construction-time map on AppServerTransport, forwarded only through
// createCodexDriverWith and the session; the public factory and the package
// entry carry none. Over the real owned fakes:
// - a listed method's request is admitted with its own deadline (same numeric
//   meaning: 0 disables); any other method keeps requestTimeoutMs, and with
//   no map requestTimeoutMs keeps its meaning (30 000 ms default, 0 disables);
// - the deadline is chosen once, when the request is admitted;
// - through the driver, createCodexDriverWith's map bounds skills/list while
//   the public factory, handed the same key, bounds nothing.
// Controls: a selection that ignores the method fails the ordinary-request
// values; a session or driver that drops the map fails the forwarding value.
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandState } from '../src/activity.js'
import { createCodexDriver } from '../src/codex/index.js'
import * as codexEntry from '../src/codex/index.js'
import { fake as transportFake, rejection, stopAll } from './helpers/appServerHarness.js'
import { codexDriver, codexRoot, PERMISSIONS, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'

const roots: string[] = []
afterEach(async () => {
  try {
    await stopAll()
    await stopDrivers()
  } finally {
    // Only after every driver and transport joined its stop.
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  }
})
afterAll(stopAll)

/** A transport over the owned fake whose root afterEach removes after the join. */
const fake = (...args: Parameters<typeof transportFake>) => {
  const owned = transportFake(...args)
  roots.push(owned.root)
  return owned
}

test('a listed method takes its own deadline; any other method keeps requestTimeoutMs', async () => {
  const f = fake({ requestTimeoutMs: 10_000, requestTimeoutsMs: { late: 40 } })
  f.transport.start()
  // A warm child, so only the deadlines below decide (cold start under load is slow).
  expect(await f.transport.request('echo', { value: 'warm' })).toBe('warm')
  const listed = await rejection(f.transport.request('late', { ms: 200 }))
  expect([listed.category, listed.message]).toEqual(['transport', 'app-server request 2 (late) had no reply within 40 ms'])
  // An ordinary request held well past the listed bound still gets its reply.
  expect(await f.transport.request('delay', { ms: 200, value: 'ordinary' })).toBe('ordinary')
  expect(f.transport.pendingCount).toBe(0)
})

test('a listed 0 disables that method’s deadline; without a map requestTimeoutMs keeps its meaning', async () => {
  const listedZero = fake({ requestTimeoutMs: 40, requestTimeoutsMs: { delay: 0 } })
  listedZero.transport.start()
  expect(await listedZero.transport.request('delay', { ms: 150, value: 'unbounded' })).toBe('unbounded')
  const ordinary = await rejection(listedZero.transport.request('late', { ms: 150 }))
  expect(ordinary.message).toBe('app-server request 2 (late) had no reply within 40 ms')

  const timers = spyOn(globalThis, 'setTimeout')
  try {
    const omitted = fake()
    omitted.transport.start()
    expect(await omitted.transport.request('echo', { value: 'v' })).toBe('v')
    const disabled = fake({ requestTimeoutMs: 0 })
    disabled.transport.start()
    expect(await disabled.transport.request('echo', { value: 'w' })).toBe('w')
    const delays = timers.mock.calls.map((call) => call[1])
    // The omitted transport armed the 30 000 ms default; the disabled one armed none.
    expect(delays.filter((ms) => ms === 30_000)).toHaveLength(1)
  } finally {
    timers.mockRestore()
  }
})

test('a request keeps the deadline chosen at its admission', async () => {
  const deadlines: Record<string, number> = { late: 40 }
  const f = fake({ requestTimeoutMs: 0, requestTimeoutsMs: deadlines })
  f.transport.start()
  const admitted = rejection(f.transport.request('late', { ms: 200 }))
  deadlines.late = 0
  expect((await admitted).message).toBe('app-server request 1 (late) had no reply within 40 ms')
  // A later request is admitted under the map as it is then.
  expect(await f.transport.request('late', { ms: 120 })).toBe('first')
})

// The fake holds skills/list 400 ms; a 100 ms skills/list bound expires first.
function slowCatalog(home: string, cwd: string): void {
  const skill = { name: 'explore', path: '/skills/explore/SKILL.md', description: 'explore', scope: 'repo', enabled: true }
  writeFileSync(join(home, 'skills.json'), JSON.stringify({ skills: [skill], byCwd: { [cwd]: { skills: [skill], delayMs: 400 } } }))
}

test('createCodexDriverWith forwards its per-method deadlines; the public factory, handed the same key, forwards none', async () => {
  const privateStates: CommandState[] = []
  const root = codexRoot()
  roots.push(root.root)
  slowCatalog(root.home, root.launch().cwd)
  const bounded = codexDriver({ root, requestTimeoutsMs: { 'skills/list': 100 }, callbacks: { onCommandState: (state) => privateStates.push(state) } })
  await bounded.driver.start()
  await waitFor(() => privateStates.at(-1)?.status === 'unavailable')

  const publicStates: CommandState[] = []
  const other = codexRoot()
  roots.push(other.root)
  slowCatalog(other.home, other.launch().cwd)
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const driver = createCodexDriver({
    logger, launch: other.launch(), permissions: PERMISSIONS,
    callbacks: { onEvent() {}, onCommandState: (state) => publicStates.push(state) },
    ...({ requestTimeoutsMs: { 'skills/list': 100 } } as object),
  })
  try {
    await driver.start()
    await waitFor(() => publicStates.at(-1)?.status === 'ready')
    expect({ privateLast: privateStates.at(-1)?.status, publicStatuses: publicStates.map((state) => state.status) })
      .toEqual({ privateLast: 'unavailable', publicStatuses: ['loading', 'ready'] })
  } finally {
    await driver.kill()
  }
})

test('the package entry exports no private seam', () => {
  expect(Object.keys(codexEntry).sort()).toEqual(['createCodexDriver', 'hasCodexLogin'])
})
