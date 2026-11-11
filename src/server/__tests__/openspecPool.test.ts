// openspecPool.test.ts - PL1 (the pool property over seeded task mixes on a
// fake clock) and QT1 (time queued in the pool never counts toward the
// runner's timeout, through the real runOpenspecList and a stub CLI) from
// bounded-openspec-discovery design.md.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOpenspecList } from '../workspace/openspecDiscovery'
import {
  ConcurrencyPool,
  createPooledOpenspecRunner,
  OPENSPEC_POOL_SIZE,
  openspecListPool,
} from '../workspace/openspecPool'
import { propertyCases } from './helpers/propertyCases'

/** mulberry32: a small seeded PRNG, so failing cases replay exactly. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const SEED = 0x0a5e
const CASES = 300

describe('ConcurrencyPool PL1', () => {
  // @covers: openspec-visibility › Bound concurrent OpenSpec discovery › A full reconciliation
  test(`PL1: at most ${OPENSPEC_POOL_SIZE} run at once, each result reaches its own caller once, a throw releases its slot (${CASES} cases, seed 0x0a5e)`, async () => {
    expect(OPENSPEC_POOL_SIZE).toBe(3)
    expect(openspecListPool.size).toBe(3)
    const random = prng(SEED)
    for (let caseIndex = 0; caseIndex < propertyCases(CASES); caseIndex += 1) {
      const pool = new ConcurrencyPool(OPENSPEC_POOL_SIZE)
      const n = 1 + Math.floor(random() * 60)
      const allAtOnce = caseIndex % 2 === 0
      const tasks = Array.from({ length: n }, (_, index) => ({
        index,
        offset: allAtOnce ? 0 : Math.floor(random() * 20),
        duration: (allAtOnce ? 1 : 0) + Math.floor(random() * 20),
        throws: random() < 0.1,
      }))

      let tick = 0
      let active = 0
      let maxActive = 0
      const timers: Array<{ at: number; resolve: () => void }> = []
      const settled = new Map<number, number>()
      const outcomes = new Map<number, 'ok' | 'threw'>()
      const promises: Promise<void>[] = []

      const submit = (task: (typeof tasks)[number]): void => {
        promises.push(
          pool
            .run(async () => {
              active += 1
              maxActive = Math.max(maxActive, active)
              await new Promise<void>((resolve) => timers.push({ at: tick + task.duration, resolve }))
              active -= 1
              if (task.throws) throw new Error(`task ${task.index}`)
              return task.index
            })
            .then(
              (value) => {
                expect(value).toBe(task.index)
                outcomes.set(task.index, 'ok')
              },
              (error: Error) => {
                expect(error.message).toBe(`task ${task.index}`)
                outcomes.set(task.index, 'threw')
              }
            )
            .finally(() => settled.set(task.index, (settled.get(task.index) ?? 0) + 1))
        )
      }

      while (settled.size < n && tick < 10_000) {
        for (const task of tasks) if (task.offset === tick) submit(task)
        await flush()
        for (let index = timers.length - 1; index >= 0; index -= 1) {
          if (timers[index].at <= tick) timers.splice(index, 1)[0].resolve()
        }
        await flush()
        await flush()
        tick += 1
      }
      await Promise.all(promises)

      const context = `case ${caseIndex}: n=${n} allAtOnce=${allAtOnce}`
      expect({ context, maxActive: maxActive <= OPENSPEC_POOL_SIZE }).toEqual({ context, maxActive: true })
      expect({ context, settled: settled.size }).toEqual({ context, settled: n })
      for (const count of settled.values()) expect(count).toBe(1)
      for (const task of tasks) expect(outcomes.get(task.index)).toBe(task.throws ? 'threw' : 'ok')
      expect(pool.activeCount()).toBe(0)
      expect(pool.startedCount()).toBe(n)
      if (allAtOnce) {
        expect({ context, peak: pool.takePeak() }).toEqual({ context, peak: Math.min(OPENSPEC_POOL_SIZE, n) })
      }
    }
  })

  // FIFO order only: the one-microtask window between a release and the
  // waiter waking is not reachable from here, so a waiter that skips the
  // handoff survives this test (recorded in the change's result).
  test('a released slot goes to the oldest waiter before a newcomer submitted on release', async () => {
    const pool = new ConcurrencyPool(1)
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const tracked = (name: string, hold?: Promise<void>) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      if (hold) await hold
      await flush()
      order.push(name)
      active -= 1
    }
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    let third: Promise<void> | undefined
    // The newcomer is submitted the moment the first caller sees its result.
    const first = pool.run(tracked('first', hold)).then(() => {
      third = pool.run(tracked('third'))
    })
    const second = pool.run(tracked('second'))
    await flush()
    release()
    await first
    await Promise.all([second, third])
    expect(order).toEqual(['first', 'second', 'third'])
    expect(maxActive).toBe(1)
    expect(pool.takePeak()).toBe(1)
  })
})

describe('pooled runner QT1', () => {
  let stubDir = ''
  let savedPath: string | undefined

  beforeAll(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-openspec-stub-'))
    const stub = path.join(stubDir, 'openspec')
    fs.writeFileSync(stub, '#!/bin/sh\nsleep 0.3\necho \'{"changes":[]}\'\n')
    fs.chmodSync(stub, 0o755)
    savedPath = process.env.PATH
    process.env.PATH = `${stubDir}${path.delimiter}${savedPath ?? ''}`
  })

  afterAll(() => {
    process.env.PATH = savedPath
    fs.rmSync(stubDir, { recursive: true, force: true })
  })

  // @covers: openspec-visibility › Bound concurrent OpenSpec discovery › A queued run
  test('QT1: a run queued behind a full pool for longer than its timeout still succeeds when its process answers in time', async () => {
    const pool = new ConcurrencyPool(1)
    const runner = createPooledOpenspecRunner(pool, runOpenspecList)
    let release!: () => void
    const blocker = pool.run(() => new Promise<void>((resolve) => (release = resolve)))
    const startedAt = performance.now()
    const queued = runner({ cwd: stubDir, timeoutMs: 1_000 })
    // Hold the only slot for 1.5 s, longer than the 1 s timeout.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    release()
    await blocker
    const result = await queued
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_500)
    expect(result).toEqual({ ok: true, exitCode: 0, stdout: '{"changes":[]}\n', stderr: '' })
  })
})
