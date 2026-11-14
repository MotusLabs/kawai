// Lifecycle table L's unit cases and P3's seeded race model (autocomplete
// D2), moved from Kawai's codexCommandDiscovery.test.ts with every case and
// title (task-ce05430a R2) onto the package's discovery, which the deleted
// root CodexCommandDiscovery.ts was copied to (CodexSkillDiscovery, task 6.1
// R2 A9). The translation is the host seam only: the root client became the
// generation object and a host whose request() holds each reply, the root
// snapshot() is the latest published state (none published reads
// unavailable, the initial state), and ready()/changed() name the generation.
// Kawai keeps L1/L4 and L5 on its production driver.
import { expect, test } from 'bun:test'
import type { CommandState } from '../src/activity.js'
import { CodexSkillDiscovery } from '../src/codex/skills.js'

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
/** One process generation: its identity and the skills/list requests sent on it. */
function controlled() {
  const calls: Array<{ params?: Record<string, unknown>; reply: ReturnType<typeof deferred<unknown>> }> = []
  return { generation: {}, calls }
}
type Generation = ReturnType<typeof controlled>

/** A discovery whose host routes each request to its generation's calls. */
function discoveryOf(states: CommandState[] = []) {
  const live = new Map<object, Generation>()
  const discovery = new CodexSkillDiscovery({
    request(generation, params) {
      const reply = deferred<unknown>(); live.get(generation)!.calls.push({ params, reply }); return reply.promise
    },
    publish: state => states.push(state),
    warn() {},
  })
  const snapshot = (): CommandState => states.at(-1) ?? { status: 'unavailable', commands: [] }
  const start = (g: Generation, cwd: string) => { live.set(g.generation, g); discovery.start(g.generation, cwd) }
  return { discovery, snapshot, start }
}

// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Working directory changes during a request
// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Skills change while attached
test('L1-L4/L6: invalidations coalesce and never publish a superseded cwd, including a return to the same cwd', async () => {
  const g = controlled(); const { calls } = g
  const states: CommandState[] = []
  const { discovery, snapshot, start } = discoveryOf(states)
  start(g, '/a'); discovery.changeDirectory('/b'); discovery.ready(g.generation); await flush()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.params).toEqual({ cwds: ['/b'], forceReload: true })
  discovery.changeDirectory('/c'); discovery.changed(g.generation); discovery.changeDirectory('/b')
  expect(snapshot()).toEqual({ status: 'loading', commands: [] })
  calls[0]!.reply.resolve(response('/b', 'stale')); await flush()
  expect(calls).toHaveLength(2)
  expect(states.some(state => state.commands.some(command => command.name === 'stale'))).toBe(false)
  calls[1]!.reply.resolve(response('/b')); await flush()
  expect(snapshot().commands.map(command => command.name)).toEqual(['explore'])
  discovery.changed(g.generation); await flush()
  expect(calls[2]!.params).toEqual({ cwds: ['/b'], forceReload: true })
  expect(discovery.inputs('/explore')).toEqual([])
  calls[2]!.reply.resolve(response('/b', 'new-skill')); await flush()
  expect(snapshot().commands[0]!.name).toBe('new-skill')
})

// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Agent ends and restarts
test('L5-L7/L9: failure, stopped invalidation, and late process replies cannot restore candidates', async () => {
  const old = controlled(); const fresh = controlled()
  const { discovery, snapshot, start } = discoveryOf()
  start(old, '/a'); discovery.ready(old.generation); await flush()
  discovery.stop(); discovery.changed(old.generation); discovery.changeDirectory('/b'); await flush()
  expect(old.calls).toHaveLength(1)
  expect(snapshot()).toEqual({ status: 'unavailable', commands: [] })
  start(fresh, '/b'); discovery.ready(fresh.generation); await flush()
  old.calls[0]!.reply.resolve(response('/a', 'stale')); await flush()
  expect(snapshot().status).toBe('loading')
  fresh.calls[0]!.reply.reject(new Error('unsupported')); await flush()
  expect(snapshot()).toEqual({ status: 'unavailable', commands: [] })
  discovery.changed(fresh.generation); await flush()
  fresh.calls[1]!.reply.resolve(null); await flush()
  expect(snapshot().status).toBe('unavailable')
})

test('P3: 300 seeded 40-event sequences agree with lifecycle publication model across crashes and stale replies', async () => {
  let seed = 0xC0DE03
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  for (let sequence = 0; sequence < 300; sequence++) {
    const { discovery, snapshot, start } = discoveryOf()
    let live = false; let booted = false; let cwd = '/a'; let version = 0
    let expected: CommandState['status'] = 'unavailable'
    let transport = controlled()
    const replies: Array<{ call: Generation['calls'][number]; version: number; cwd: string }> = []
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
        start(transport, cwd); expected = 'loading'
      } else if (event === 2 && live && !booted) {
        booted = true; discovery.ready(transport.generation)
      } else if (event === 3) {
        discovery.changed(transport.generation); if (live) { version++; expected = 'loading' }
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
      expect({ sequence, step, status: snapshot().status }).toEqual({ sequence, step, status: expected })
      if (expected !== 'ready') expect(snapshot().commands).toEqual([])
    }
    discovery.stop()
    for (const reply of replies) reply.call.reply.resolve(response(reply.cwd, 'after-crash'))
    await flush(); expect(snapshot().status).toBe('unavailable')
  }
})
