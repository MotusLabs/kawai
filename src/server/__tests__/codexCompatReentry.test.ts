// @reads: packages/agent-runtime/__tests__/fixtures/**
// Reviewer reproducers for task-752c9e4c (findings-9ef4b6a8 F1/F2, probe
// /tmp/k752-review-boundaries.test.ts SHA 1b9460ac), through Kawai's
// production composition (createChatDriver → codexRuntime.ts → the public
// package factory) and the package's owned fake app-server over stdio.
// - F1: a host send whose own getEffort or onStatus callback throws reaches
//   the caller as that original error and is refused before any native
//   turn; its bookkeeping is released, so a later valid send goes through
//   with its catalog skill and the status settles back to waiting, and a send
//   the throwing callback made itself is unaffected.
// - F2: a kill from the turn_started publication leaves the activity null:
//   the outer turn_started cannot revive the activity after the nested stop.
// Every test kills the adapter, joins settled() and only then removes its root.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import type { SessionStatus } from '../../shared/types'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { codexRoot, type CodexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'

type Adapter = ReturnType<typeof createChatDriver> & { settled(): Promise<void> }

const DEPLOY = { name: 'deploy', path: '/skills/deploy/SKILL.md', description: 'deploy', scope: 'repo', enabled: true }
const text = (t: string) => ({ type: 'text', text: t, text_elements: [] })

async function until(probe: () => boolean) {
  const end = Date.now() + 4000
  while (!probe()) {
    if (Date.now() > end) throw new Error('probe did not reach setup boundary')
    await Bun.sleep(5)
  }
}

const turnStarts = (root: CodexRoot) => root.received().filter((m) => m.method === 'turn/start')

/** Kill, join settled() (its report returned, never swallowed silently), then remove the root. */
async function teardown(driver: Adapter, root: CodexRoot): Promise<unknown> {
  try {
    driver.kill()
    return await driver.settled().then(() => null, (error: unknown) => error)
  } finally {
    fs.rmSync(root.root, { recursive: true, force: true })
  }
}

interface Hooks { getEffort?: () => 'low'; onStatus?: (status: SessionStatus) => void }

function open(root: CodexRoot, sessionId: string, hooks: Hooks, onEvent: (event: { type: string }) => void = () => {}): Adapter {
  fs.writeFileSync(`${root.home}/skills.json`, JSON.stringify({ skills: [DEPLOY] }))
  return createChatDriver({ runtime: 'codex', options: {
    sessionId, projectPath: `${root.root}/work`, executable: root.wrapper, codexHome: root.home,
    network: false, serverEnv: { PATH: process.env.PATH ?? '', HOME: root.root },
    withheldCredentials: () => new Set(), wire: { record() {} }, claimRateLimitsRead: () => false,
    ...(hooks.getEffort ? { getEffort: hooks.getEffort } : {}),
    onStatus: (status: SessionStatus) => hooks.onStatus?.(status),
    onEvent,
  } as never }) as Adapter
}

async function throwingSend(hook: 'getEffort' | 'onStatus') {
  const root = codexRoot()
  const boom = new Error(`${hook} stopped send preparation`)
  let armed = false
  const driver = open(root, `review-${hook}`, {
    getEffort() {
      if (armed && hook === 'getEffort') {
        armed = false
        throw boom
      }
      return 'low'
    },
    onStatus(status) {
      if (armed && hook === 'onStatus' && status === 'working') {
        armed = false
        throw boom
      }
    },
  })
  let report: unknown = 'not joined'
  try {
    driver.start()
    await until(() => driver.getCommandState().status === 'ready')
    armed = true
    let failure: unknown
    try {
      driver.send('should not be submitted')
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(boom)
    // Once ready, admission runs in microtasks; the owned fake records the
    // actual native request. This finite observation is not a Bun timeout.
    await Bun.sleep(150)
    expect({ nativeTurnsAfterPreparationThrow: turnStarts(root).length }).toEqual({ nativeTurnsAfterPreparationThrow: 0 })
  } finally {
    armed = false
    report = await teardown(driver, root)
  }
  // The refusal is the caller's alone: settled() reports nothing for it.
  expect(report).toBeNull()
}

test('a throwing getEffort refuses the host send before any native turn', () => throwingSend('getEffort'))

test('a throwing onStatus refuses the host send before any native turn', () => throwingSend('onStatus'))

async function refusedThenValid(hook: 'getEffort' | 'onStatus') {
  const root = codexRoot()
  const boom = new Error(`${hook} stopped send preparation`)
  let armed = false
  const statuses: SessionStatus[] = []
  const driver = open(root, `refused-then-valid-${hook}`, {
    getEffort() {
      if (armed && hook === 'getEffort') {
        armed = false
        throw boom
      }
      return 'low'
    },
    onStatus(status) {
      statuses.push(status)
      if (armed && hook === 'onStatus' && status === 'working') {
        armed = false
        throw boom
      }
    },
  })
  let report: unknown = 'not joined'
  try {
    driver.start()
    await until(() => driver.getCommandState().status === 'ready')
    armed = true
    expect(() => driver.send('/deploy refused')).toThrow(boom)
    await until(() => statuses.at(-1) === 'waiting')
    driver.send('/deploy accepted')
    await until(() => turnStarts(root).length === 1 && statuses.at(-1) === 'waiting')
    const start = turnStarts(root)[0]!.params
    expect({ input: start.input, effort: start.effort, pending: driver.getPendingRequests().length }).toEqual({
      input: [text('/deploy accepted'), { type: 'skill', name: 'deploy', path: DEPLOY.path }], effort: 'low', pending: 0,
    })
  } finally {
    armed = false
    report = await teardown(driver, root)
  }
  expect(report).toBeNull()
}

test('after a throwing getEffort refused a send, the status settles to waiting and the next send carries its own skill and effort', () => refusedThenValid('getEffort'))

test('after a throwing onStatus refused a send, the status settles to waiting and the next send carries its own skill and effort', () => refusedThenValid('onStatus'))

test('a send the throwing getEffort made itself before throwing still opens its own turn', async () => {
  const root = codexRoot()
  const boom = new Error('getEffort stopped send preparation')
  let armed = false
  let driver!: Adapter
  driver = open(root, 'nested-before-throw', {
    getEffort() {
      if (armed) {
        armed = false
        driver.send('/deploy nested')
        throw boom
      }
      return 'low'
    },
  })
  let report: unknown = 'not joined'
  try {
    driver.start()
    await until(() => driver.getCommandState().status === 'ready')
    armed = true
    expect(() => driver.send('/deploy outer')).toThrow(boom)
    await until(() => turnStarts(root).length === 1)
    await Bun.sleep(150)
    expect(turnStarts(root).map((m) => m.params.input)).toEqual([[text('/deploy nested'), { type: 'skill', name: 'deploy', path: DEPLOY.path }]])
  } finally {
    armed = false
    report = await teardown(driver, root)
  }
  expect(report).toBeNull()
})

test('a kill from turn_started publication leaves terminal activity null', async () => {
  const root = codexRoot()
  const activity: Array<string | null> = []
  let entered = false
  let driver!: Adapter
  driver = createChatDriver({ runtime: 'codex', options: {
    sessionId: 'review-activity-stop', projectPath: `${root.root}/work`, executable: root.wrapper, codexHome: root.home,
    network: false, serverEnv: { PATH: process.env.PATH ?? '', HOME: root.root },
    withheldCredentials: () => new Set(), wire: { record() {} }, claimRateLimitsRead: () => false,
    onStatus() {}, onActivity(value: { phase: string } | null) { activity.push(value?.phase ?? null) },
    onEvent(event: { type: string }) {
      if (event.type === 'turn_started' && !entered) {
        entered = true
        driver.kill()
      }
    },
  } as never }) as Adapter
  try {
    driver.send('/hold')
    await until(() => entered)
    await driver.settled().catch(() => {})
    expect({ terminalActivity: activity.at(-1) }).toEqual({ terminalActivity: null })
  } finally {
    await teardown(driver, root)
  }
})
