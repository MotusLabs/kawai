// codex-capacity-retry P4 (design "Acceptance oracles", task 4.1): capacity
// alone produces zero quota limit events. Seeded chains of capacity failures
// through Kawai's production composition (helpers/codexCapacityManager.ts:
// ChatSessionManager, the limit store, LimitOutcomes and the dispatcher over
// the in-tree package), with exhausted quota snapshots, retrying and
// not-retrying overload notifications and the object-free exact capacity
// code, human turns and delivered mail, ending in success, an exhausted
// window, a Stop or a non-limit failure. After every chain no limit event
// exists and neither profile on the shared home nor the separate home cools.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { CODEX_CAPACITY_CONTINUATION } from '@motuslabs/agent-runtime/codex'
import { until } from './codexDriverHarness'
import { capacityManager, type CapacityManager } from './helpers/codexCapacityManager'
import { propertyCases } from './helpers/propertyCases'

const CASES = 1000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let s: CapacityManager
beforeAll(async () => {
  s = await capacityManager()
})
afterAll(async () => {
  await s.cleanup()
})

const failed = (turnId: string, codexErrorInfo: unknown) => ({ turn: { id: turnId, status: 'failed', items: [], error: { message: 'over capacity', codexErrorInfo, additionalDetails: null } } })
const status = () => s.manager.getSnapshot(s.id)?.status
const exhausted = (random: () => number) => {
  const resetsAt = Math.floor(Date.now() / 1000) + 60 + Math.floor(random() * 7_200)
  return { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: random() < 0.5 ? 100 : 40, windowDurationMins: 10_080, resetsAt: resetsAt + 86_400 } } }
}

async function bind(request: { id: number }, attempt: string) {
  s.server.reply(request.id, { turn: { id: attempt, status: 'inProgress', items: [], error: null } })
  s.server.notify('turn/started', { turn: { id: attempt, status: 'inProgress', items: [], error: null } })
  await s.server.flush()
}

let ids = 0
const trace: string[] = []
const wait = (label: string, predicate: () => boolean) => until(predicate).catch((error: Error) => { throw new Error(`${label} [${trace.join(' ')}] status ${status()}: ${error.message}`) })

/** One logical turn's capacity chain; resolves once the chat is idle again. */
async function chain(random: () => number): Promise<void> {
  const before = s.server.turnStarts().length
  if (random() < 0.5) expect((await s.manager.send(s.id, `task ${ids}`)).ok).toBe(true)
  else {
    s.manager.mailbox.store.enqueue({ teamId: s.teamId, toKind: 'session', toId: s.id, fromSession: random() < 0.5 ? null : 'chat-peer', fromGroup: null, originPath: s.project, body: `mail ${ids}` })
    s.manager.dispatcher.notify()
  }
  await wait('first start', () => s.server.turnStarts().length > before)
  let attempt = `p${++ids}`
  await bind(s.server.turnStarts().at(-1)!, attempt)
  const failures = 1 + Math.floor(random() * 4)
  for (let n = 0; ; n++) {
    if (random() < 0.6) s.server.notify('account/rateLimits/updated', exhausted(random))
    if (random() < 0.5) s.server.notify('error', { turnId: attempt, willRetry: random() < 0.7, error: { message: 'busy', codexErrorInfo: 'serverOverloaded', additionalDetails: null } })
    if (n === failures) {
      const end = random()
      trace.push(end < 0.6 ? 'success' : end < 0.8 ? 'other' : 'stop')
      if (end < 0.6) s.server.notify('turn/completed', { turn: { id: attempt, status: 'completed', error: null, items: [] } })
      else if (end < 0.8) s.server.notify('turn/completed', failed(attempt, 'contextWindowExceeded'))
      else await s.manager.interrupt(s.id)
      break
    }
    s.clock.randoms.splice(0, s.clock.randoms.length, random())
    s.server.notify('turn/completed', failed(attempt, 'serverOverloaded'))
    trace.push('capacity')
    await wait('backoff', () => s.clock.pending === 1 || status() !== 'working')
    if (s.clock.pending === 0) break
    if (random() < 0.15) {
      // The continuation runs past the deadline and then fails at capacity: the turn ends with the capacity error (L4).
      trace.push('window')
      const starts = s.server.turnStarts().length
      s.clock.advance(600_000)
      await wait('late continuation', () => s.server.turnStarts().length > starts)
      attempt = `p${++ids}`
      await bind(s.server.turnStarts().at(-1)!, attempt)
      s.server.notify('turn/completed', failed(attempt, 'serverOverloaded'))
      break
    }
    const starts = s.server.turnStarts().length
    s.clock.advance(Math.min(...[...s.clock.timers.values()].map((timer) => timer.at)) - s.clock.now)
    await wait('continuation', () => s.server.turnStarts().length > starts || status() !== 'working')
    if (s.server.turnStarts().length === starts) break
    expect((s.server.turnStarts().at(-1)!.params.input as Array<{ text: string }>)[0]!.text).toBe(CODEX_CAPACITY_CONTINUATION)
    attempt = `p${++ids}`
    await bind(s.server.turnStarts().at(-1)!, attempt)
  }
  await wait('idle', () => status() === 'waiting')
  // The next chain's clock starts past any window this one fixed.
  s.clock.advance(700_000)
}

test('P4: capacity alone produces zero quota limit events (seed 0xCA9AC20, 1,000 cases)', async () => {
  for (let index = 0; index < propertyCases(CASES); index++) {
    const random = mulberry32(0xca9ac20 + index * 0x9e3779b1)
    trace.length = 0
    trace.push(`case ${index}`)
    await chain(random)
    const events = [...s.manager.limitEvents.forProvider(s.homeProvider), ...s.manager.limitEvents.forProvider(s.otherProvider), ...['codex', 'codex-fast', 'codex-2'].flatMap((profile) => s.manager.limitEvents.forProfile(profile))]
    if (events.length > 0) throw new Error(`case ${index}: ${JSON.stringify(events)}`)
    for (const [profile, provider] of [['codex', s.homeProvider], ['codex-fast', s.homeProvider], ['codex-2', s.otherProvider]] as const) {
      expect(s.manager.limitEvents.cooldownFor(profile, provider).until).toBeNull()
    }
  }
}, 1_800_000)
