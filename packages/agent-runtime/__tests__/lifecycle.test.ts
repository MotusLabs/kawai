// The lifecycle core against the committed oracle table (task 2.2): every
// one of the 56 state/operation pairs is driven through DriverLifecycle and
// checked against its row (L01-L20, L24-L26; U01/U02 are unreachable). Then
// the terminal stop: concurrent callers, late admitted jobs, preserved
// failures, expected cancellations and the self-join refusal (L11-L12/I1).
// Control M-join: a generation completing at stdout EOF instead of actual exit.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { AgentRuntimeError } from '../src/errors.js'
import type { DriverState, ProcessExitFact } from '../src/contract.js'
import { DriverLifecycle } from '../src/lifecycle/lifecycle.js'
import { runGeneration } from '../src/lifecycle/generation.js'
import { resolveLaunch } from '../src/process/launch.js'
import { spawnOwned } from '../src/process/ownedProcess.js'
import { LIFECYCLE_ROWS, expandPairs, type LifecycleOperation, type LifecycleState } from './oracles/lifecycleInputs.js'

interface Deferred<T = void> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const pending = async (promise: Promise<unknown>) => {
  let done = false
  void promise.then(() => (done = true), () => (done = true))
  await tick()
  return !done
}
async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<AgentRuntimeError> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    return error as AgentRuntimeError
  }
  throw new Error('expected a rejection')
}

interface Fixture {
  lc: DriverLifecycle
  states: DriverState[]
  init: Deferred
  initCalls: number
  teardown: Deferred<ProcessExitFact[]>
  starting: Promise<void> | null
}

/** Drive a fresh lifecycle into `state` through public operations only. */
async function inState(state: LifecycleState): Promise<Fixture> {
  const states: DriverState[] = []
  const lc = new DriverLifecycle({ continuations: new Set(['queue']), onState: (s) => states.push(s) })
  const f: Fixture = { lc, states, init: deferred(), initCalls: 0, teardown: deferred<ProcessExitFact[]>(), starting: null }
  const start = () => {
    f.starting = lc.start(() => {
      f.initCalls += 1
      return f.init.promise
    })
    f.starting.catch(() => {})
    return f.starting
  }
  if (state === 'unstarted') return f
  start()
  if (state === 'starting') return f
  f.init.resolve()
  await f.starting
  if (state === 'idle') return f
  if (state === 'active') {
    await lc.admitSend()
    lc.beginTurn('t1')
    return f
  }
  if (state === 'exited') {
    lc.processExit(lc.generation)
    return f
  }
  const stop = lc.stop('kill', () => f.teardown.promise)
  stop.catch(() => {})
  if (state === 'stopping') return f
  f.teardown.resolve([])
  await stop
  return f
}

type Check = (f: Fixture, state: LifecycleState) => Promise<void>

const CHECKS: Record<string, Check> = {
  L01: async (f) => {
    const start = f.lc.start(async () => {})
    expect(f.lc.state).toBe('starting')
    await start
    expect(f.lc.state).toBe('idle')
    expect(f.lc.generation).toBe(1)
  },
  L02: async (f) => {
    await f.lc.start(async () => {})
    expect(f.lc.generation).toBe(2)
    expect(f.lc.state).toBe('idle')
  },
  L03: async (f) => {
    expect(f.lc.start(async () => {})).toBe(f.starting!)
    expect(f.initCalls).toBe(1)
  },
  L04: async (f, state) => {
    let called = false
    await f.lc.start(async () => void (called = true))
    expect(called).toBe(false)
    expect(f.lc.state).toBe(state)
  },
  L05: async (f, state) => {
    expect((await rejection(f.lc.admitSend())).category).toBe('not-ready')
    expect(f.lc.state).toBe(state)
  },
  L06: async (f) => {
    const send = f.lc.admitSend()
    expect(await pending(send)).toBe(true)
    f.init.resolve()
    expect(await send).toBe('new-turn')
  },
  L07: async (f) => {
    expect(await f.lc.admitSend()).toBe('new-turn')
    f.lc.beginTurn('t2')
    expect(f.lc.state).toBe('active')
  },
  L08: async (f) => {
    expect((await rejection(f.lc.admitSend())).category).toBe('busy')
    expect(f.lc.activeTurnId).toBe('t1')
  },
  L09: async (f, state) => {
    expect(f.lc.interrupt()).toEqual({ outcome: 'no-active-turn', processExit: false })
    expect(f.lc.state).toBe(state)
  },
  L10: async (f, state) => {
    if (state === 'starting') {
      const waiting = f.lc.admitSend()
      expect(f.lc.interrupt()).toEqual({ outcome: 'requested', processExit: false })
      f.init.resolve()
      const error = await rejection(waiting)
      expect([error.category, error.code]).toEqual(['not-ready', 'interrupted'])
    } else {
      expect(f.lc.interrupt()).toEqual({ outcome: 'requested', processExit: false })
      expect(f.lc.state).toBe('idle')
      expect(f.lc.activeTurnId).toBeNull()
    }
  },
  L11: async (f) => {
    const teardown = deferred<ProcessExitFact[]>()
    const stop = f.lc.stop('shutdown', () => teardown.promise)
    expect(f.lc.state).toBe('stopping')
    expect((await rejection(f.lc.admitSend())).category).toBe('stopped')
    expect(await pending(stop)).toBe(true)
    f.init.resolve()
    teardown.resolve([{ generation: 1, state: 'never-started' }])
    expect(await stop).toEqual({ scope: 'agent-processes', mode: 'shutdown', processes: [{ generation: 1, state: 'never-started' }], js: 'settled' })
    expect(f.lc.state).toBe('stopped')
  },
  L12: async (f, state) => {
    let second = false
    const again = f.lc.stop('shutdown', async () => {
      second = true
      return []
    })
    if (state === 'stopping') f.teardown.resolve([])
    expect((await again).mode).toBe('kill')
    expect(second).toBe(false)
  },
  L13: async (f, state) => {
    expect((await rejection(f.lc.start(async () => {}))).category).toBe('stopped')
    expect((await rejection(f.lc.admitSend())).category).toBe('stopped')
    expect((await rejection(() => f.lc.interrupt())).category).toBe('stopped')
    expect(f.lc.state).toBe(state)
  },
  L14: async (f) => {
    expect(f.lc.processExit(f.lc.generation)).toBe('unexpected')
    expect(f.lc.state).toBe('exited')
    expect(f.lc.processExit(f.lc.generation)).toBe('ignored')
  },
  L15: async (f) => {
    expect(f.lc.processExit(f.lc.generation)).toBe('stopping')
    expect(f.lc.state).toBe('stopping')
  },
  L16: async (f, state) => {
    expect(f.lc.processExit(f.lc.generation)).toBe('ignored')
    expect(f.lc.state).toBe(state)
  },
  L17: async (f) => {
    expect(f.lc.ready(f.lc.generation)).toBe(true)
    expect(f.lc.state).toBe('idle')
  },
  L18: async (f, state) => {
    expect(f.lc.ready(f.lc.generation)).toBe(false)
    expect(f.lc.state).toBe(state)
  },
  L19: async (f) => {
    expect(f.lc.result('t1')).toBe(true)
    expect(f.lc.state).toBe('idle')
    expect(f.lc.result('t1')).toBe(false)
  },
  L20: async (f, state) => {
    expect(f.lc.result('t1')).toBe(false)
    expect(f.lc.state).toBe(state)
  },
  L24: async (f) => {
    expect(f.lc.native('n1')).toBe('open')
    expect([f.lc.state, f.lc.activeTurnId]).toEqual(['active', 'n1'])
  },
  L25: async (f) => {
    expect(f.lc.native('n2')).toBe('bind')
    expect(f.lc.activeTurnId).toBe('t1')
  },
  L26: async (f, state) => {
    expect(f.lc.native('n3')).toBe('ignored')
    expect(f.lc.state).toBe(state)
  },
}

describe('lifecycle table (56 pairs)', () => {
  const rows = new Map(LIFECYCLE_ROWS.map((row) => [row.id, row]))
  for (const [pair, [rowId]] of expandPairs(LIFECYCLE_ROWS)) {
    const [state, operation] = pair.split('+') as [LifecycleState, LifecycleOperation]
    if (rows.get(rowId!)?.unreachable) continue
    test(`${rowId} ${state}+${operation}`, async () => {
      const f = await inState(state)
      await CHECKS[rowId!]!(f, state)
    })
  }

  test('every reachable row has a check', () => {
    const reachable = LIFECYCLE_ROWS.filter((row) => !row.unreachable).map((row) => row.id)
    expect(reachable.filter((id) => !CHECKS[id])).toEqual([])
  })
})

describe('continuations (L21, L23)', () => {
  test('a queued submission keeps the driver active until its own result', async () => {
    const f = await inState('active')
    expect(await f.lc.admitSend('queue')).toBe('queue')
    expect(f.lc.result('t1')).toBe(true)
    expect(f.lc.state).toBe('active')
    f.lc.beginTurn('t2')
    expect(f.lc.result('t2')).toBe(true)
    expect(f.lc.state).toBe('idle')
    expect(f.states.filter((s) => s === 'idle')).toHaveLength(2) // after start and after t2 only
  })

  test('an unsupported continuation is refused', async () => {
    const f = await inState('active')
    expect((await rejection(f.lc.admitSend('steer'))).category).toBe('unsupported')
  })
})

describe('terminal stop and owned jobs (L11-L12, I1)', () => {
  test('a failed start restores the prior state and the shared promise rejects', async () => {
    const f = await inState('starting')
    f.init.reject(new Error('auth refused'))
    expect((await rejection(f.starting!)).message).toBe('auth refused')
    expect(f.lc.state).toBe('unstarted')
    // A rejected start promise is no proof anyone observed it: the later stop still reports the failure.
    const stop = await rejection(f.lc.stop('kill', async () => []))
    expect(stop.category).toBe('stop')
    expect((stop.causes as Error[]).map((c) => c.message)).toEqual(['auth refused'])
  })

  test('an unobserved failed start is reported by the stop together with a teardown failure', async () => {
    const lc = new DriverLifecycle({ continuations: new Set() })
    const typed = new AgentRuntimeError({ category: 'transport', message: 'did not initialize' }, [new Error('pipe closed')])
    void lc.start(async () => {
      throw typed
    })
    await tick()
    const error = await rejection(lc.stop('kill', async () => {
      throw new Error('kill unsupported')
    }))
    expect(error.category).toBe('stop')
    // Original and cleanup failures are both kept; the typed rejection keeps its underlying cause.
    expect(error.causes.map((c) => (c as Error).message)).toEqual(['kill unsupported', 'did not initialize'])
    expect((error.causes[1] as AgentRuntimeError).causes.map((c) => (c as Error).message)).toEqual(['pipe closed'])
  })

  test('only the cancellation the driver minted for this stop is excluded; any other start failure during stop is kept', async () => {
    for (const minted of [true, false]) {
      const lc = new DriverLifecycle({ continuations: new Set() })
      const init = deferred()
      const start = lc.start(() => init.promise)
      start.catch(() => {})
      const stop = lc.stop('kill', async () => {
        const underlying = new Error('process killed')
        // Same category and message either way: only lifecycle.cancelled() marks a stop's own cancellation.
        init.reject(minted ? lc.cancelled('the driver was stopped while starting', [underlying]) : new AgentRuntimeError({ category: 'stopped', message: 'the driver was stopped while starting' }, [underlying]))
        return []
      })
      expect((await rejection(start)).category).toBe('stopped')
      if (minted) expect((await stop).js).toBe('settled')
      else expect((await rejection(stop)).causes.map((c) => (c as Error).message)).toEqual(['the driver was stopped while starting'])
    }
  })

  test('a minted cancellation is not excluded when it is not the stop that saw it (a failure before stop is kept)', async () => {
    const lc = new DriverLifecycle({ continuations: new Set() })
    const minted = lc.cancelled('cancelled early')
    void lc.start(async () => {
      throw minted
    }).catch(() => {})
    await tick()
    expect((await rejection(lc.stop('kill', async () => []))).causes).toEqual([minted])
  })

  test('jobs admitted during the join are joined before the receipt', async () => {
    const f = await inState('idle')
    const late = deferred()
    const first = deferred()
    void f.lc.jobs.run('producer', async () => {
      await first.promise
      await tick() // admitted only after the join has taken its first snapshot
      void f.lc.jobs.run('late-handler', () => late.promise)
    })
    const stop = f.lc.stop('kill', async () => {
      first.resolve()
      return []
    })
    await tick()
    await tick()
    expect(f.lc.jobs.size).toBe(1) // only the late handler is still live
    expect(await pending(stop)).toBe(true)
    late.resolve()
    expect((await stop).js).toBe('settled')
  })

  test('a job failure fails the stop with the original error kept', async () => {
    const f = await inState('idle')
    const boom = new Error('tool handler crashed')
    void f.lc.jobs.run('tool', async () => {
      throw boom
    }).catch(() => {})
    const error = await rejection(f.lc.stop('kill', async () => []))
    expect(error.category).toBe('stop')
    expect(error.causes).toEqual([boom])
    expect(f.lc.state).toBe('stopping')
    expect(await rejection(f.lc.stop('shutdown', async () => []))).toBe(error)
  })

  test("the stop's own cancellation is not a failure", async () => {
    const f = await inState('idle')
    const cancelled = deferred()
    void f.lc.jobs.run('request', () => cancelled.promise, { expectedCancellation: (e) => e === 'cancelled' }).catch(() => {})
    const stop = f.lc.stop('kill', async () => {
      cancelled.reject('cancelled')
      return []
    })
    expect((await stop).processes).toEqual([])
  })

  test('a teardown failure fails the stop', async () => {
    const f = await inState('idle')
    const error = await rejection(f.lc.stop('kill', async () => {
      throw new Error('kill unsupported')
    }))
    expect([error.category, (error.causes[0] as Error).message]).toEqual(['stop', 'kill unsupported'])
  })

  test('stop from inside an owned job begins the stop but refuses that caller instead of self-joining', async () => {
    const f = await inState('idle')
    let inner: AgentRuntimeError | null = null
    const job = f.lc.jobs.run('tool-calls-kill', async () => {
      inner = await rejection(f.lc.stop('kill', async () => []))
    })
    await job
    expect(inner!.category).toBe('internal')
    expect((await f.lc.stop('kill', async () => [])).mode).toBe('kill')
    expect(f.lc.state).toBe('stopped')
    expect(await rejection(f.lc.jobs.run('joiner', () => f.lc.jobs.join()))).toMatchObject({ category: 'internal' })
  })

  test('a throwing onState never aborts stop; the failure is retained in the stop result', async () => {
    for (const at of ['stopping', 'stopped'] as const) {
      const sentinel = new Error(`onState threw at ${at}`)
      const lc = new DriverLifecycle({
        continuations: new Set(),
        onState: (state) => {
          if (state === at) throw sentinel
        },
      })
      await lc.start(async () => {})
      let tornDown = false
      const stop = lc.stop('kill', async () => {
        tornDown = true
        return []
      })
      const error = await rejection(stop)
      expect([at, error.category, error.causes.includes(sentinel), tornDown]).toEqual([at, 'stop', true, true])
      expect(lc.jobs.size).toBe(0)
    }
  })

  // Control M-join: completing the generation at stdout EOF reports an exit while the process lives.
  test('a generation job completes at actual exit, not when stdout reaches EOF', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-gen-')))
    const owned = spawnOwned({
      // The shell writes a line, closes its stdout (a real EOF) and keeps running.
      command: '/bin/sh',
      args: ['-c', 'echo ready; exec 1>&-; while :; do sleep 1; done'],
      launch: resolveLaunch({ cwd: root, childEnv: { PATH: '/usr/bin:/bin' }, homeDir: root, cacheDir: root, tempDir: root }),
      generation: 1,
    })
    const lc = new DriverLifecycle({ continuations: new Set() })
    let eof = false
    const generation = runGeneration(lc.jobs, owned, async (stdout) => {
      for await (const _ of stdout) {
      }
      eof = true
    })
    for (let i = 0; i < 200 && !eof; i++) await tick()
    expect(eof).toBe(true)
    expect(await pending(generation)).toBe(true)
    process.kill(owned.pid!, 0) // still alive after EOF
    const fact = await owned.terminate({ graceMs: 1000, killMs: 2000 })
    expect(fact.state).toBe('exited')
    expect(await generation).toMatchObject({ kind: 'exited', signal: 'SIGTERM' })
  })
})
