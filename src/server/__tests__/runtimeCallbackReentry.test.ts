// A host callback that reaches its own driver's settled() (task 6.1 R12, F1/A5;
// reviewer reproducer findings-5ec176ed, SHA 8b3e9ed3; mechanism
// note-3893b594): while the callback's result is outstanding, the join it
// would wait on includes that result, so the adapter refuses it at once
// (AgentRuntimeError, category internal) instead of creating or reusing the
// shared join. Native teardown the callback admitted (kill) still runs, a
// genuine outside caller still joins every owned job, including the
// callback's own returned work, and callers outside the callback's live
// ancestry (a finished callback's later timer, another driver) are not
// refused. Public default compositions over a real-SDK fake CLI and actual
// Codex stdio, plus OwnedWork itself for nested ancestry.
import { expect, test } from 'bun:test'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import fs from 'node:fs'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { OwnedWork, outsideRuntime } from '../chat/provider/runtimeOwnership'
import { fakeClaudeHome } from '../../../packages/agent-runtime/__tests__/helpers/fakeClaudeHome'
import { codexRoot, pids, alive } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'

type Adapter = ReturnType<typeof createChatDriver> & { settled(): Promise<void> }
type Runtime = 'claude' | 'codex'

test('a host event returning its reentrant terminal join refuses or settles before rescue instead of joining itself', async () => {
  const root = codexRoot()
  let release!: () => void
  const rescue = new Promise<void>(r => { release = r })
  let entered = false
  let innerDone = false
  let inner: Promise<void> | undefined
  const driver = createChatDriver({ runtime: 'codex', options: {
    sessionId: 'review-reentry', projectPath: `${root.root}/work`, executable: root.wrapper,
    codexHome: root.home, network: false, serverEnv: { PATH: process.env.PATH ?? '', HOME: root.root },
    withheldCredentials: () => new Set(), wire: { record() {} },
    onEvent(event: {type: string}) {
      if (event.type !== 'turn_started' || entered) return
      entered = true
      driver.kill()
      inner = driver.settled().then(() => { innerDone = true }, () => { innerDone = true })
      // A release owned by finally breaks any cycle so this diagnostic can
      // assert the missing refusal without hanging a test or its teardown.
      return Promise.race([inner, rescue])
    }, onStatus() {},
  } as never }) as ReturnType<typeof createChatDriver> & {settled(): Promise<void>}
  try {
    driver.send('/hold')
    const end = Date.now() + 3000
    while (!entered && Date.now() < end) await Bun.sleep(5)
    expect(entered).toBe(true)
    const exitEnd = Date.now() + 3000
    const processEnded = () => pids(root.home).length > 0 && pids(root.home).every(pid => !alive(pid))
    while (!processEnded() && Date.now() < exitEnd) await Bun.sleep(5)
    expect(processEnded()).toBe(true)
    await Bun.sleep(150)
    const beforeRescue = innerDone
    release()
    await inner
    await driver.settled().catch(() => {})
    expect({ processEnded: processEnded(), terminalJoinSettledBeforeRescue: beforeRescue }).toEqual({ processEnded: true, terminalJoinSettledBeforeRescue: true })
  } finally {
    release()
    driver.kill()
    await inner
    await driver.settled().catch(() => {})
    fs.rmSync(root.root, {recursive: true, force: true})
  }
})

async function until(probe: () => boolean, what: string) {
  const end = Date.now() + 5000
  while (!probe()) {
    if (Date.now() > end) throw new Error(`setup did not reach: ${what}`)
    await Bun.sleep(5)
  }
}

/** A public default composition whose first turn_started runs `onTurn(driver)`. */
function composition(runtime: Runtime, onTurn: (driver: Adapter) => unknown) {
  const home = fakeClaudeHome()
  const launch = home.launch({ ANTHROPIC_API_KEY: 'test-only' })
  const codex = runtime === 'codex' ? codexRoot() : null
  let entered = false
  const callbacks = {
    onEvent: (event: { type: string }) => {
      if (event.type !== 'turn_started' || entered) return undefined
      entered = true
      return onTurn(driver)
    },
    onStatus: () => undefined,
  }
  const driver = (codex
    ? createChatDriver({ runtime: 'codex', options: {
        sessionId: 'reentry-codex', projectPath: `${codex.root}/work`, executable: codex.wrapper,
        codexHome: codex.home, network: false, serverEnv: { PATH: process.env.PATH ?? '', HOME: codex.root },
        withheldCredentials: () => new Set(), wire: { record() {} }, ...callbacks,
      } as never })
    : createChatDriver({ runtime: 'claude', options: {
        sessionId: 'reentry-claude', projectPath: launch.cwd,
        claudeExecutablePath: launch.executablePath ?? `${launch.childEnv.PATH!.split(':')[0]}/claude`,
        profileCatalogHome: launch.homeDir, getProviderEnv: () => ({ ...launch.childEnv }),
        ...callbacks,
      } as never })) as Adapter
  const cleanup = () => {
    fs.rmSync(home.root, { recursive: true, force: true })
    if (codex) fs.rmSync(codex.root, { recursive: true, force: true })
  }
  return { driver, entered: () => entered, hang: codex ? '/hold' : 'hang', cleanup }
}

const refusal = (error: unknown) => (error instanceof AgentRuntimeError ? `refused:${error.category}` : `other:${String(error)}`)

/** A synchronous settled() inside the callback is refused before the callback returns; an outside join then settles. */
async function syncReentry(runtime: Runtime): Promise<void> {
  let inside = null as string | null
  let refusedInCallback = false
  const c = composition(runtime, (driver) => {
    driver.kill()
    const join = driver.settled()
    void join.then(() => void (inside = 'resolved'), (error) => void (inside = refusal(error)))
    // The refusal is already decided: one microtask turn reports it.
    return Promise.resolve().then(() => void (refusedInCallback = inside !== null))
  })
  try {
    c.driver.send(c.hang)
    await until(c.entered, 'turn_started')
    const outside = await c.driver.settled().then(() => 'resolved', (error: unknown) => refusal(error))
    expect({ inside, refusedInCallback, outside }).toEqual({ inside: 'refused:internal', refusedInCallback: true, outside: 'resolved' })
  } finally {
    c.driver.kill()
    await c.driver.settled().catch(() => {})
    c.cleanup()
  }
}

test('public default claude composition refuses a settled() from inside its own live callback at once, and an outside settled() still joins', () => syncReentry('claude'))

test('public default codex composition refuses a settled() from inside its own live callback at once, and an outside settled() still joins', () => syncReentry('codex'))

/**
 * An async continuation of a still-pending callback is refused too, while an
 * outside settled() waits for the callback's returned work and reports its
 * raw rejection once.
 */
async function asyncReentry(runtime: Runtime): Promise<void> {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const boom = new Error('callback work after its refused join')
  let inside = null as string | null
  const c = composition(runtime, async (driver) => {
    await Bun.sleep(10)
    driver.kill()
    inside = await driver.settled().then(() => 'resolved', (error: unknown) => refusal(error))
    await gate
    throw boom
  })
  let outsideDone = false
  let outside: unknown
  let wait: Promise<void> | undefined
  try {
    c.driver.send(c.hang)
    await until(() => inside !== null, 'the continuation reached settled()')
    wait = c.driver.settled().then(() => void (outsideDone = true), (error) => void ((outsideDone = true), (outside = error)))
    await Bun.sleep(100)
    const pendingBeforeRelease = !outsideDone
    release()
    await wait
    const again = await c.driver.settled().then(() => null, (error: unknown) => error)
    expect({ inside, pendingBeforeRelease, rawOnce: outside === boom, again }).toEqual({ inside: 'refused:internal', pendingBeforeRelease: true, rawOnce: true, again: null })
  } finally {
    release()
    c.driver.kill()
    await (wait ?? c.driver.settled()).catch(() => {})
    await c.driver.settled().catch(() => {})
    c.cleanup()
  }
}

test('public default claude composition refuses a settled() from an async continuation of its pending callback, while an outside settled() joins that callback and reports its raw rejection once', () => asyncReentry('claude'))

test('public default codex composition refuses a settled() from an async continuation of its pending callback, while an outside settled() joins that callback and reports its raw rejection once', () => asyncReentry('codex'))

/** A timer a finished synchronous callback left behind is outside its ancestry: its kill + settled() joins normally. */
async function finishedFrame(runtime: Runtime): Promise<void> {
  let later: Promise<string> | undefined
  const c = composition(runtime, (driver) => {
    later = new Promise<string>((resolve) => {
      setTimeout(() => {
        driver.kill()
        void driver.settled().then(() => resolve('resolved'), (error: unknown) => resolve(refusal(error)))
      }, 20)
    })
    return undefined
  })
  try {
    c.driver.send(c.hang)
    await until(() => later !== undefined, 'turn_started')
    expect(await later).toBe('resolved')
  } finally {
    c.driver.kill()
    await c.driver.settled().catch(() => {})
    c.cleanup()
  }
}

test('public default claude composition lets a finished callback’s later timer join with kill + settled()', () => finishedFrame('claude'))

test('public default codex composition lets a finished callback’s later timer join with kill + settled()', () => finishedFrame('codex'))

test('OwnedWork refuses its own settled() under a live outer callback after a nested callback finished, and not another owner’s or outsideRuntime’s', async () => {
  const owned = new OwnedWork('nested')
  const other = new OwnedWork('other')
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const seen: Record<string, string> = {}
  const record = (key: string, join: Promise<void>) => join.then(() => void (seen[key] = 'resolved'), (error) => void (seen[key] = refusal(error)))
  const joins: Array<Promise<void>> = []
  owned.hosted('outer', () => {
    owned.hosted('inner', () => undefined)
    joins.push(record('afterInner', owned.settled()))
    joins.push(record('otherOwner', other.settled()))
    joins.push(record('outsideRuntime', outsideRuntime(() => owned.settled())))
    return gate
  })
  const outside = owned.settled()
  let outsideDone = false
  void outside.then(() => void (outsideDone = true))
  await Promise.all(joins.slice(0, 2))
  await Bun.sleep(20)
  const pendingBeforeRelease = !outsideDone
  release()
  await outside
  await Promise.all(joins)
  const actual: Record<string, unknown> = { ...seen, pendingBeforeRelease }
  expect(actual).toEqual({ afterInner: 'refused:internal', otherOwner: 'resolved', outsideRuntime: 'resolved', pendingBeforeRelease: true })
})

/**
 * A custom thenable the callback returns is adopted inside its ancestry: a
 * settled() its then() makes is refused at once. A finite rescue timer
 * resolves the thenable only if that refusal never came (a self-join).
 */
async function customThenable(runtime: Runtime): Promise<void> {
  let inside = null as string | null
  let rescued = false
  let rescue: ReturnType<typeof setTimeout> | undefined
  const c = composition(runtime, (driver) => ({
    // A custom thenable is the case under test.
    // oxlint-disable-next-line unicorn/no-thenable
    then(resolve: (value: unknown) => void) {
      rescue = setTimeout(() => {
        rescued = true
        resolve(undefined)
      }, 1500)
      driver.kill()
      driver.settled().then(
        () => void ((inside = 'resolved'), resolve(undefined)),
        (error: unknown) => void ((inside = refusal(error)), resolve(undefined)),
      )
    },
  }))
  try {
    c.driver.send(c.hang)
    await until(() => inside !== null || rescued, 'the thenable reached settled() or its rescue')
    const outside = await c.driver.settled().then(() => 'resolved', (error: unknown) => refusal(error))
    expect({ inside, rescued, outside }).toEqual({ inside: 'refused:internal', rescued: false, outside: 'resolved' })
  } finally {
    clearTimeout(rescue)
    c.driver.kill()
    await c.driver.settled().catch(() => {})
    c.cleanup()
  }
}

test('public default claude composition refuses a settled() made by the then() of a custom thenable its callback returned', () => customThenable('claude'))

test('public default codex composition refuses a settled() made by the then() of a custom thenable its callback returned', () => customThenable('codex'))

const selfRefusal = (error: unknown) => error instanceof AgentRuntimeError && error.category === 'internal' && error.message.includes('live host callback')

/** A callback whose result has a throwing then getter is finished: its later timer is not refused as a self-join. */
async function throwingThenGetter(runtime: Runtime): Promise<void> {
  let later: Promise<{ selfRefused: boolean }> | undefined
  const c = composition(runtime, (driver) => {
    later = new Promise((resolve) => {
      setTimeout(() => {
        driver.kill()
        driver.settled().then(() => resolve({ selfRefused: false }), (error: unknown) => resolve({ selfRefused: selfRefusal(error) }))
      }, 20)
    })
    // A throwing then getter is the case under test.
    // oxlint-disable-next-line unicorn/no-thenable
    return Object.defineProperty({}, 'then', {
      get() {
        throw new Error('then getter throws')
      },
    })
  })
  try {
    c.driver.send(c.hang)
    await until(() => later !== undefined, 'turn_started')
    expect(await later).toEqual({ selfRefused: false })
  } finally {
    c.driver.kill()
    await c.driver.settled().catch(() => {})
    c.cleanup()
  }
}

test('public default claude composition finishes a callback whose result has a throwing then getter, so its later timer joins', () => throwingThenGetter('claude'))

test('public default codex composition finishes a callback whose result has a throwing then getter, so its later timer joins', () => throwingThenGetter('codex'))
