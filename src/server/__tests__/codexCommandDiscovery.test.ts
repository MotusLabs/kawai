// Lifecycle table L, production driver wiring (Kawai's Codex adapter over
// the package core and the replaying fake as a real child, task-5906f19c), and
// P3's seeded race model.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CodexCommandDiscovery } from '../chat/codex/CodexCommandDiscovery'
import type { CodexClient } from '../chat/provider/codexDriverTypes'
import type { ChatCommandState } from '../../shared/chat'
import { createCodexDriverWith } from '../../../packages/agent-runtime/src/codex/driver'
import { Script, startHarness, tempDirs, THREAD_ID, until, type Harness } from './codexDriverHarness'

// Table L verbatim: [Id, Event, Context, Observable result].
export const lifecycleOracles = [
  ['L1', 'Start/resume succeeds', 'Live client, no discovery pending', 'Loading/empty then discovery for latest cwd; no model turn'],
  ['L2', 'Skills changed or cwd changes', 'Live ready client, no discovery pending', 'Loading/empty; discovery for current cwd with forceReload'],
  ['L3', 'Skills changed or cwd changes', 'Discovery pending, or boot pending', 'Loading/empty; one latest-context follow-up after pending request/boot settles'],
  ['L4', 'Discovery reply', 'Current request, valid response', 'Ready with C table result'],
  ['L5', 'Discovery rejection/timeout or invalid response', 'Current request', 'Unavailable/empty; normal sends unaffected'],
  ['L6', 'Discovery reply or rejection', 'Superseded request, any outcome', 'No state publication from old result; pending latest-context scan proceeds if live'],
  ['L7', 'Agent exits or is stopped', '*', 'Unavailable/empty; no later reply restores candidates'],
  ['L8', 'Client reconnects', 'Live chat, any catalog state', 'Snapshot contains current state/list; no model turn'],
  ['L9', 'Client attaches or skill invalidation arrives', 'Archived/stopped chat without a live client', 'Unavailable/empty; no discovery request'],
] as const

const response = (cwd: string, name = 'explore') => ({ data: [{ cwd, errors: [], skills: [
  { name, description: 'Explore code', path: `/skills/${name}/SKILL.md`, scope: 'repo', enabled: true },
] }] })
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function controlled() {
  const calls: Array<{ method: string; params?: Record<string, unknown>; reply: ReturnType<typeof deferred<unknown>> }> = []
  const client: CodexClient = {
    start() {}, end() {}, initialize: async () => ({}),
    request(method, params) {
      const reply = deferred<unknown>(); calls.push({ method, params, reply }); return reply.promise
    },
  }
  return { client, calls }
}

// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Working directory changes during a request
// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Skills change while attached
test('L1-L4/L6: invalidations coalesce and never publish a superseded cwd, including a return to the same cwd', async () => {
  const { client, calls } = controlled()
  const states: ChatCommandState[] = []
  const discovery = new CodexCommandDiscovery(state => states.push(state))
  discovery.start(client, '/a'); discovery.changeDirectory('/b'); discovery.ready(); await flush()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.params).toEqual({ cwds: ['/b'], forceReload: true })
  discovery.changeDirectory('/c'); discovery.changed(); discovery.changeDirectory('/b')
  expect(discovery.snapshot()).toEqual({ status: 'loading', commands: [] })
  calls[0]!.reply.resolve(response('/b', 'stale')); await flush()
  expect(calls).toHaveLength(2)
  expect(states.some(state => state.commands.some(command => command.name === 'stale'))).toBe(false)
  calls[1]!.reply.resolve(response('/b')); await flush()
  expect(discovery.snapshot().commands.map(command => command.name)).toEqual(['explore'])
  discovery.changed(); await flush()
  expect(calls[2]!.params).toEqual({ cwds: ['/b'], forceReload: true })
  expect(discovery.inputs('/explore')).toEqual([])
  calls[2]!.reply.resolve(response('/b', 'new-skill')); await flush()
  expect(discovery.snapshot().commands[0]!.name).toBe('new-skill')
})

// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Agent ends and restarts
test('L5-L7/L9: failure, stopped invalidation, and late process replies cannot restore candidates', async () => {
  const old = controlled(); const fresh = controlled()
  const discovery = new CodexCommandDiscovery(() => {})
  discovery.start(old.client, '/a'); discovery.ready(); await flush()
  discovery.stop(); discovery.changed(); discovery.changeDirectory('/b'); await flush()
  expect(old.calls).toHaveLength(1)
  expect(discovery.snapshot()).toEqual({ status: 'unavailable', commands: [] })
  discovery.start(fresh.client, '/b'); discovery.ready(); await flush()
  old.calls[0]!.reply.resolve(response('/a', 'stale')); await flush()
  expect(discovery.snapshot().status).toBe('loading')
  fresh.calls[0]!.reply.reject(new Error('unsupported')); await flush()
  expect(discovery.snapshot()).toEqual({ status: 'unavailable', commands: [] })
  discovery.changed(); await flush()
  fresh.calls[1]!.reply.resolve(null); await flush()
  expect(discovery.snapshot().status).toBe('unavailable')
})

let harness: Harness | null = null
afterEach(async () => {
  const done = harness?.cleanup()
  harness = null
  await done
})
// @covers: codex-chat-sessions › Codex skills populate the chat command list › Opening a Codex chat discovers skills
test('L1/L4: production driver starts discovery after boot, before a model turn, and refreshes on resume', async () => {
  for (const resume of [false, true]) {
    // Kawai's production Codex composition over the replaying fake as a real
    // default-owned child (task-5906f19c); the server's skills/changed waits
    // at a gate so the first ready is observed before the refresh.
    const dirs = tempDirs()
    const other = path.join(dirs.dir, 'other')
    const changed = path.join(dirs.dir, 'skills-changed')
    const states: ChatCommandState[] = []
    const script = new Script().boot(resume ? 'thread/resume' : 'thread/start').request('skills/list', response(dirs.project))
    script.lines.push({ fake: 'gate', path: changed })
    script.notify('skills/changed', {}).request('skills/list', response(dirs.project)).request('skills/list', response(other))
    const run = startHarness(script, { onCommandState: state => states.push(state), ...(resume ? { resumeThreadId: THREAD_ID } : {}) }, dirs)
    try {
      run.driver.start()
      await until(() => run.driver.getCommandState().status === 'ready')
      expect(run.sent.flatMap(message => (message.method && message.method !== 'initialize' ? [message.method] : []))).toEqual([resume ? 'thread/resume' : 'thread/start', 'skills/list'])
      expect(run.events).toEqual([])
      expect(states.map(state => state.status)).toEqual(['loading', 'ready'])
      fs.writeFileSync(changed, '')
      await until(() => states.length === 4)
      expect(states.map(state => state.status)).toEqual(['loading', 'ready', 'loading', 'ready'])
      run.driver.setProjectPath(other)
      expect(run.driver.getCommandState().status).toBe('loading')
      await until(() => run.driver.getCommandState().status === 'ready')
      expect(run.sent.filter(message => message.method === 'skills/list').map(message => message.params)).toEqual([
        { cwds: [dirs.project], forceReload: false }, { cwds: [dirs.project], forceReload: true }, { cwds: [other], forceReload: true },
      ])
      expect(run.sent.some(message => message.method === 'turn/start')).toBe(false)
      run.driver.kill(); expect(run.driver.getCommandState().status).toBe('unavailable')
    } finally {
      await run.cleanup()
    }
  }
})

// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Unsupported or failed discovery
test('L5: a real RPC timeout leaves ordinary turns working without awaiting discovery', async () => {
  const dirs = tempDirs()
  const gate = path.join(dirs.dir, 'release')
  const script = new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1').completed('ct-1')
  script.lines.splice(5, 0, { fake: 'gate', path: gate })
  // Only discovery has a short test deadline, through the package's private
  // per-method deadlines (createCodexDriverWith, task-5906f19c A7) under
  // Kawai's own adapter; cold child startup and ordinary turns keep the
  // production 30 000 ms bound under suite contention.
  harness = startHarness(script, {}, dirs, options => createCodexDriverWith(options, { requestTimeoutsMs: { 'skills/list': 500 } }))
  harness.driver.start()
  await until(() => harness!.sent.some(message => message.method === 'skills/list'))
  harness.driver.send('hello')
  await until(() => harness!.sent.some(message => message.method === 'turn/start'))
  expect(harness.driver.getCommandState().status).toBe('loading')
  await until(() => harness!.driver.getCommandState().status === 'unavailable')
  // The held turn/start outlives a 500 ms bound by this finite hold, so only
  // discovery's own deadline can have expired (a global 500 fails the turn).
  await Bun.sleep(600)
  fs.writeFileSync(gate, '')
  await until(() => harness!.events.some(event => event.type === 'turn_completed'))
  expect(harness.events.filter(event => event.type === 'error')).toEqual([])
  expect(harness.driver.getCommandState().status).toBe('unavailable')
})

test('P3: 300 seeded 40-event sequences agree with lifecycle publication model across crashes and stale replies', async () => {
  let seed = 0xC0DE03
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  for (let sequence = 0; sequence < 300; sequence++) {
    const discovery = new CodexCommandDiscovery(() => {})
    let live = false; let booted = false; let cwd = '/a'; let version = 0
    let expected: ChatCommandState['status'] = 'unavailable'
    let transport = controlled()
    const replies: Array<{ call: typeof transport.calls[number]; version: number; cwd: string }> = []
    let observed = 0
    const capture = () => {
      for (; observed < transport.calls.length; observed++) replies.push({ call: transport.calls[observed]!, version, cwd })
    }
    for (let step = 0; step < 40; step++) {
      const event = random() % 7
      if (event === 0) {
        discovery.stop(); version++; live = false; booted = false; expected = 'unavailable'
      } else if (event === 1 && !live) {
        transport = controlled(); observed = 0; live = true; booted = false; version++
        discovery.start(transport.client, cwd); expected = 'loading'
      } else if (event === 2 && live && !booted) {
        booted = true; discovery.ready()
      } else if (event === 3) {
        discovery.changed(); if (live) { version++; expected = 'loading' }
      } else if (event === 4) {
        cwd = cwd === '/a' ? '/b' : '/a'; discovery.changeDirectory(cwd)
        if (live) { version++; expected = 'loading' }
      } else if ((event === 5 || event === 6) && replies.length) {
        const index = random() % replies.length
        const reply = replies.splice(index, 1)[0]!
        const fresh = live && reply.version === version && reply.cwd === cwd
        if (event === 5) reply.call.reply.resolve(response(reply.cwd, `s-${sequence}-${step}`))
        else reply.call.reply.reject(new Error('timeout'))
        if (fresh) expected = event === 5 ? 'ready' : 'unavailable'
      }
      await flush(); capture()
      expect({ sequence, step, status: discovery.snapshot().status }).toEqual({ sequence, step, status: expected })
      if (expected !== 'ready') expect(discovery.snapshot().commands).toEqual([])
    }
    discovery.stop()
    for (const reply of replies) reply.call.reply.resolve(response(reply.cwd, 'after-crash'))
    await flush(); expect(discovery.snapshot().status).toBe('unavailable')
  }
})
