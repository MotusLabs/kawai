// The executor's wake loop (plan-execution I2, N1): a failing tick is
// logged and the timer still rescheduled — never an unhandled rejection,
// which would exit the server — and a wake during a running tick runs
// exactly one more tick, however many wakes arrived. Startup never wakes (N6).
import { afterEach, expect, test } from 'bun:test'
import { ExecutionExecutor, type ExecutorDeps } from '../plans/execution/executor'

let executor: ExecutionExecutor | null = null
afterEach(() => executor?.close())

/** An executor whose tick is replaced; only the store's running read is real enough. */
function withTick(tick: (teamId: string) => Promise<void>, running = true): ExecutionExecutor {
  const store = { runningForTeam: () => (running ? [{ id: 'e1' }] : []) }
  const made = new ExecutionExecutor({ store, tickMs: 60_000 } as unknown as ExecutorDeps)
  ;(made as unknown as { tick: (teamId: string) => Promise<void> }).tick = tick
  return made
}

const timers = (made: ExecutionExecutor) => (made as unknown as { timers: Map<string, unknown> }).timers

test('a tick that throws is contained: no unhandled rejection, the loop settles, the timer is rescheduled', async () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    let ticks = 0
    executor = withTick(async () => {
      ticks += 1
      throw new Error('database is locked')
    })
    executor.wake('team')
    const settled = await Promise.race([executor.idle().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2_000))])
    expect(settled).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(rejections).toEqual([])
    expect(ticks).toBe(1)
    expect(timers(executor).has('team')).toBe(true)
    // The loop is not wedged: the next wake ticks again.
    executor.wake('team')
    await executor.idle()
    expect(ticks).toBe(2)
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('wakes during a running tick run exactly one more tick (N1)', async () => {
  let ticks = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  executor = withTick(async () => {
    ticks += 1
    if (ticks === 1) await gate
  })
  executor.wake('team')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(ticks).toBe(1)
  executor.wake('team')
  executor.wake('team')
  executor.wake('team')
  release()
  await executor.idle()
  expect(ticks).toBe(2)
  // A wake after the loop settled starts a fresh tick.
  executor.wake('team')
  await executor.idle()
  expect(ticks).toBe(3)
})

test('a wake never ticks inside the caller\'s synchronous work', async () => {
  let ticks = 0
  executor = withTick(async () => { ticks += 1 }, false)
  executor.wake('team')
  expect(ticks).toBe(0)
  await executor.idle()
  expect(ticks).toBe(1)
  // No running execution: no timer.
  expect(timers(executor).has('team')).toBe(false)
})

test('startup recovers and never wakes: no tick and no timer until the runtime wakes (N6)', async () => {
  let ticks = 0
  const store = { runningForTeam: () => [{ id: 'e1' }], markRunningEffectsUnknown: () => [], execution: () => null }
  executor = new ExecutionExecutor({ store, tickMs: 60_000 } as unknown as ExecutorDeps)
  ;(executor as unknown as { tick: (teamId: string) => Promise<void> }).tick = async () => { ticks += 1 }
  await executor.startup()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(ticks).toBe(0)
  expect(timers(executor).size).toBe(0)
})
