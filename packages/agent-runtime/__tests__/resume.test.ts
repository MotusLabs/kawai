// I2 over seeded crash schedules (task 4.4, Claude unit; design §Invariants:
// 0xA602, 300 sequences). The production ClaudeSession runs on the controlled
// query in each host lifetime. The test plays the runtime: it holds the
// conversations it has started and either refuses an unknown target before
// initialize, as the pinned CLI does, or substitutes a fresh one. It also
// plays the caller's durable store, which commits, rejects or holds each
// checkpoint offer. A lifetime either stops normally or crashes at a
// checkpoint, admission or result boundary with no stop; the store then
// keeps only what committed, or a pending write that landed. Each sequence's
// observed log must equal oracles/resumeModel.ts's prediction.
//
// These are controlled finite schedules over one test process. The
// cross-host witnesses (separate bun hosts over the real SDK and the fake
// CLI) are claudeResume.test.ts.
import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ResumeCheckpoint } from '../src/contract.js'
import { outcome, starting, tick } from './helpers/checkpointHarness.js'
import type { Driver } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'
import { generateSequence, predict, targetOf, type ResumeSequence } from './oracles/resumeModel.js'

interface Offer { id: string; resolve(): void; reject(error: unknown): void }

/** The pinned CLI's startup-failure frame for a target it does not hold (2.1.289). */
function startupFailure(target: string): SDKMessage {
  const line = `No conversation found with session ID: ${target}`
  return {
    type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0, stop_reason: null,
    session_id: crypto.randomUUID(), total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: crypto.randomUUID(), errors: [line], result_index: 0,
  } as unknown as SDKMessage
}

/** The value, or 'hung' after `ms`: a wrong driver fails the log instead of the slice's timeout. */
async function bounded<T>(promise: Promise<T>, ms = 1500): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'hung'>((resolve) => (timer = setTimeout(() => resolve('hung'), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

const label = (value: unknown) => (value === 'pending' ? 'pending' : value instanceof Error ? `refused:${(value as { category?: string }).category}` : 'ack')
const stopLabel = (stop: Promise<unknown>) => bounded(stop.then(() => 'ok', (e: { category?: string }) => e.category ?? 'unknown'))
const startLabel = (start: Promise<void>) => bounded(start.then(() => 'ok', (e: { category?: string }) => e.category ?? 'unknown'))
type Settled = { outcome: string; error: { category: string } | null }
const resultLabel = async (result: Promise<Settled>) => {
  const r = await bounded(result)
  return r === 'hung' ? 'hung' : r.outcome === 'success' ? 'success' : `${r.outcome}:${r.error?.category}`
}

async function observe(seq: ResumeSequence, index: number): Promise<string[]> {
  const log: string[] = []
  const runtime = new Set<string>()
  const known: string[] = []
  const disposed: { n: number; f: Driver; offers: Offer[] }[] = []
  let store: string | null = null
  let minted = 0
  const mint = () => `conv-${index}-${++minted}`

  for (const [n, spec] of seq.lifetimes.entries()) {
    const L = `L${n}`
    const target = targetOf(spec, store, known, index, n)
    const offers: Offer[] = []
    const onCheckpoint = (c: ResumeCheckpoint) => new Promise<void>((resolve, reject) => offers.push({ id: c.runtimeSessionId, resolve, reject }))
    const resume = target === null ? null : { runtime: 'claude' as const, runtimeSessionId: target }
    const f = await starting({ resume, onCheckpoint })
    log.push(`${L} options ${f.q().options.resume ?? '-'}`)
    const staleCheck = async () => {
      for (const old of disposed) {
        const before = old.offers.length
        const sent = await bounded(old.f.d.send('intrude').then(() => 'accepted', () => 'refused'))
        log.push(`stale L${old.n} ${sent}${old.offers.length === before ? '' : ' offered'}`)
      }
    }

    if (target !== null && !runtime.has(target) && seq.mode === 'refuse') {
      f.q().push(startupFailure(target))
      f.q().exit()
      log.push(`${L} start ${await startLabel(f.start)}`, `${L} stop ${await stopLabel(f.d.kill())}`, `${L} store ${store ?? '-'}`)
      if (offers.length > 0) log.push(`${L} offered ${offers.length}`)
      await staleCheck()
      disposed.push({ n, f, offers })
      continue
    }
    f.q().ready()
    log.push(`${L} start ${await startLabel(f.start)}`)

    let current = target
    let held: Offer | null = null
    let seen = 0
    let crashed = false
    let rejected = false
    const crashAt = (at: string, turn: number) => spec.crash.at === at && spec.crash.turn === turn
    const crash = () => {
      // The host dies: no stop. A write still pending may have reached the disk; nothing acknowledged it.
      if (held && spec.crash.landed) store = held.id
      crashed = true
      log.push(`${L} crash`)
    }
    for (let j = 0; j < spec.turns; j++) {
      const sending = f.d.send(`p${j}`)
      let ack = await outcome(sending)
      if (held) {
        log.push(`${L} send${j} ${ack === 'pending' ? 'waits' : label(ack)}`)
        store = held.id
        held.resolve()
        held = null
        ack = await outcome(sending)
      }
      log.push(`${L} send${j} ${label(ack)}`)
      if (label(ack) !== 'ack') break
      const handle = ack as Awaited<typeof sending>
      if (crashAt('after-admission', j)) {
        crash()
        break
      }
      const substituted = target !== null && !runtime.has(target)
      const id = current === null || spec.succession[j] || substituted ? mint() : current
      runtime.add(id)
      current = id
      f.q().push(frames.init(id))
      await f.q().drain()
      if (substituted) {
        // A substituting runtime answers the turn in its own conversation.
        f.q().push(frames.result([handle.messageUuid], 'substituted'))
        log.push(`${L} turn${j} ${await resultLabel(handle.result)}`, `${L} send${j + 1} ${label(await outcome(f.d.send('again')))}`)
        if (offers.length > 0) log.push(`${L} offered ${offers.map((o) => o.id).join(',')}`)
        // Settle what a wrong driver offered, so its stop can finish and the log shows the difference.
        for (const o of offers) o.resolve()
        break
      }
      let offer: Offer | null = null
      if (offers.length > seen) {
        offer = offers[seen]!
        const decision = spec.decisions[seen++ % spec.decisions.length]!
        log.push(`${L} checkpoint ${offer.id} ${decision}`)
        if (!known.includes(offer.id)) known.push(offer.id)
        held = offer
        if (crashAt('after-id', j)) {
          crash()
          break
        }
        if (decision === 'commit') {
          store = offer.id
          offer.resolve()
          held = null
        } else if (decision === 'reject') {
          offer.reject(new Error('the caller store refused the checkpoint'))
          held = null
          rejected = true
        }
        await f.q().drain()
      } else if (crashAt('after-id', j)) {
        crash()
        break
      }
      if (crashAt('after-commit', j)) {
        crash()
        break
      }
      if (!rejected) f.q().push(frames.result([handle.messageUuid], `r${j}`))
      log.push(`${L} turn${j} ${await resultLabel(handle.result)}`)
      if (rejected) {
        log.push(`${L} send${j + 1} ${label(await outcome(f.d.send('after')))}`)
        break
      }
      if (crashAt('after-result', j)) {
        crash()
        break
      }
    }
    if (!crashed) {
      if (held) {
        store = held.id
        held.resolve()
        held = null
      }
      log.push(`${L} stop ${await stopLabel(f.d.kill())}`)
    }
    log.push(`${L} store ${store ?? '-'}`)
    await staleCheck()
    if (!crashed) disposed.push({ n, f, offers })
    await tick()
  }
  return log
}

describe('Claude resume: I2 over seeded crash schedules', () => {
  // 0xA602, 300 sequences, in six slices so each test stays within its timeout.
  for (let slice = 0; slice < 6; slice++) {
    test(`I2: each launch resumes the caller's target, acknowledgement waits for persistence, and no fresh conversation is adopted (sequences ${slice * 50}-${slice * 50 + 49})`, async () => {
      for (let i = slice * 50; i < slice * 50 + 50; i++) {
        const seq = generateSequence(0xa602 + i * 7919)
        const observed = await observe(seq, i)
        const expected = predict(seq, i)
        // The first mismatch fails the slice at once, naming the sequence and its schedule.
        if (JSON.stringify(observed) !== JSON.stringify(expected)) expect({ sequence: i, schedule: seq, log: observed }).toEqual({ sequence: i, schedule: seq, log: expected })
      }
    })
  }

  test('I2 schedules reach every launch kind, decision, boundary and runtime mode, and both crash landings', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const seq = generateSequence(0xa602 + i * 7919)
      seen.add(`mode:${seq.mode}`)
      for (const spec of seq.lifetimes) {
        seen.add(`launch:${spec.launch}`)
        seen.add(`crash:${spec.crash.at}:${spec.crash.landed}`)
        for (const d of spec.decisions) seen.add(`decision:${d}`)
        if (spec.succession.includes(true)) seen.add('succession')
      }
      seen.add(`lifetimes:${seq.lifetimes.length}`)
    }
    expect([...seen].sort()).toEqual([
      'crash:after-admission:false', 'crash:after-admission:true', 'crash:after-commit:false', 'crash:after-commit:true', 'crash:after-id:false', 'crash:after-id:true',
      'crash:after-result:false', 'crash:after-result:true', 'crash:none:false', 'crash:none:true', 'decision:commit', 'decision:hold', 'decision:reject',
      'launch:fresh', 'launch:held', 'launch:invalid', 'launch:store', 'lifetimes:1', 'lifetimes:2', 'lifetimes:3', 'mode:refuse', 'mode:substitute', 'succession',
    ])
  })
})
