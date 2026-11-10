// I2 for Codex over seeded crash schedules (design §Invariants: 0xA602, 300
// sequences; task 4.4 Codex unit). Every lifetime is a public driver over the
// owned fake app-server, and all lifetimes of one sequence share one retained
// Codex home, so the runtime holds exactly the threads earlier lifetimes
// started. The test plays the caller's durable store (commit, reject or hold
// each checkpoint offer) and ends each lifetime with a stop or a crash at a
// start, admission or result boundary (the driver is abandoned: nothing of
// it is logged after that point). The observed log must equal
// oracles/codexResumeModel.ts; real thread ids are aliased in offer order.
import { afterEach, describe, expect, test } from 'bun:test'
import type { CodexAgentDriver } from '../src/contract.js'
import { generateSequence, targetOf, type ResumeSequence } from './oracles/resumeModel.js'
import { predictCodex } from './oracles/codexResumeModel.js'
import { codexDriver, codexRoot, deferred, stopDrivers } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function bounded<T>(promise: Promise<T>, ms = 3000): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'hung'>((resolve) => (timer = setTimeout(() => resolve('hung'), ms)))])
  } finally {
    clearTimeout(timer)
  }
}
const category = (promise: Promise<unknown>) => bounded(promise.then(() => 'ok', (e: { category?: string }) => e.category ?? 'unknown'))

async function observe(seq: ResumeSequence, index: number): Promise<string[]> {
  const log: string[] = []
  const root = codexRoot()
  const alias = new Map<string, string>()
  const real = new Map<string, string>()
  const known: string[] = []
  const disposed: Array<{ n: number; driver: CodexAgentDriver }> = []
  let store: string | null = null

  for (const [n, spec] of seq.lifetimes.entries()) {
    const L = `L${n}`
    const target = targetOf(spec, store, known, index, n)
    log.push(`${L} options ${target ?? '-'}`)
    const offered = deferred<{ id: string; release(): void; fail(): void }>()
    const h = codexDriver({
      root,
      env: seq.mode === 'substitute' ? { FAKE_CODEX_RESUME: 'substitute-unknown' } : {},
      ...(target !== null ? { resume: { runtime: 'codex' as const, runtimeSessionId: real.get(target) ?? target } } : {}),
      callbacks: {
        onCheckpoint: (checkpoint) => {
          const held = deferred()
          offered.resolve({ id: checkpoint.runtimeSessionId, release: () => held.resolve(), fail: () => held.reject(new Error('store refused')) })
          return held.promise
        },
      },
    })
    const end = (dispose: boolean) => {
      log.push(`${L} store ${store ?? '-'}`)
      return dispose
    }
    const stale = async () => {
      for (const d of disposed) log.push(`stale L${d.n} ${(await category(d.driver.send('late'))) === 'ok' ? 'acked' : 'refused'}`)
    }
    const crash = async () => {
      log.push(`${L} crash`)
      end(false)
      await stale()
    }
    const start = h.driver.start()
    let startLabel: Promise<unknown> = category(start)
    if (target === null) {
      const offer = await bounded(offered.promise)
      if (offer === 'hung') {
        log.push(`${L} no offer`)
        break
      }
      const name = `thread-${index}-${alias.size + 1}`
      alias.set(offer.id, name)
      real.set(name, offer.id)
      known.push(name)
      const decision = spec.decisions[0]!
      log.push(`${L} checkpoint ${decision}`)
      if (spec.crash.at === 'after-id') {
        if (spec.crash.landed) store = name
        offer.release()
        await crash()
        continue
      }
      if (decision === 'hold') {
        await tick(30)
        if ((await bounded(start.then(() => 'done', () => 'done'), 0)) === 'hung') log.push(`${L} start waits`)
      }
      if (decision === 'reject') offer.fail()
      else {
        store = name
        offer.release()
      }
      startLabel = category(start)
      if (spec.crash.at === 'after-commit') {
        await startLabel
        await crash()
        continue
      }
    }
    const started = await startLabel
    log.push(`${L} start ${started}`)
    if (started !== 'ok') {
      log.push(`${L} stop ${await category(h.driver.kill())}`)
      end(true)
      await stale()
      disposed.push({ n, driver: h.driver })
      continue
    }
    let crashed = false
    for (let j = 0; j < spec.turns; j++) {
      const sent = await bounded(h.driver.send(`t${j}`).then((handle) => handle, (e: { category?: string }) => `refused:${e.category}`))
      if (typeof sent === 'string') {
        log.push(`${L} send${j} ${sent}`)
        break
      }
      log.push(`${L} send${j} ack`)
      if (spec.crash.at === 'after-admission' && spec.crash.turn === j) {
        crashed = true
        break
      }
      const result = await bounded(sent.result)
      log.push(`${L} turn${j} ${result === 'hung' ? 'hung' : result.outcome === 'success' ? 'success' : `${result.outcome}:${result.error?.category}`}`)
      if (spec.crash.at === 'after-result' && spec.crash.turn === j) {
        crashed = true
        break
      }
    }
    if (crashed) {
      await crash()
      continue
    }
    log.push(`${L} stop ${await category(h.driver.kill())}`)
    end(true)
    await stale()
    disposed.push({ n, driver: h.driver })
  }
  return log
}

describe('Codex resume: I2 over fixed-seed crash schedules', () => {
  // 0xA602, 300 sequences, in twenty slices so each test stays within its timeout.
  for (let slice = 0; slice < 20; slice++) {
    test(`I2: each lifetime resumes the caller's target, readiness waits for persistence, and no fresh thread is adopted (sequences ${slice * 15}-${slice * 15 + 14})`, async () => {
      for (let i = slice * 15; i < slice * 15 + 15; i++) {
        const seq = generateSequence(0xa602 + i * 7919)
        const observed = await observe(seq, i)
        await stopDrivers()
        expect({ i, seq, log: observed }).toEqual({ i, seq, log: predictCodex(seq, i) })
      }
    })
  }
})
