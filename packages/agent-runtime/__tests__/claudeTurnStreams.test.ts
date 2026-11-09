// I6 over seeded streams (task 4.1; reference model from correction A1). Each
// stream drives the production ClaudeSession, on a controlled query, with
// sends, queued sends, results, merged results, stale, duplicate, unknown and
// queued-only results, UUID-less results, inits, text, task notifications,
// interrupts and restarts.
//
// An independent reference (oracles/claudeTurnModel.ts) chooses each
// result's uuids and states the expected outcome. After every input the
// driver must match it exactly: every reported settlement (turn and
// outcome), the order turns opened, admission (busy or sent), interrupt
// receipts and the driver state. After the stop, every handle must resolve
// with the turn and outcome the reference names. Events stay lossless,
// unique and ordered.
import { describe, expect, test } from 'bun:test'
import type { TurnHandle, TurnResult } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { AgentEvent } from '../src/events.js'
import { driver, type Driver } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'
import { ClaudeTurnModel } from './oracles/claudeTurnModel.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

type Op = 'send' | 'queue' | 'result' | 'merged' | 'empty' | 'queuedOnly' | 'stale' | 'duplicate' | 'unknown' | 'init' | 'text' | 'task' | 'interrupt' | 'restart'
const OPS: Op[] = ['send', 'send', 'queue', 'result', 'result', 'merged', 'empty', 'queuedOnly', 'stale', 'duplicate', 'unknown', 'init', 'text', 'task', 'interrupt', 'restart']

/** The driver's turn keys: a prompted turn's id, or native#k for the k-th agent-started turn. */
function keys(f: Driver, handles: TurnHandle[]): (turnId: string) => string {
  const prompted = new Set(handles.map((h) => h.turnId))
  const natives = new Map<string, string>()
  for (const event of f.events) {
    if (event.type !== 'turn_started' || prompted.has(event.turnId) || natives.has(event.turnId)) continue
    natives.set(event.turnId, `native#${natives.size + 1}`)
  }
  return (turnId) => natives.get(turnId) ?? turnId
}

async function stream(seed: number): Promise<string[]> {
  let state = seed >>> 0
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) >>> 0
    return (state >>> 8) % n
  }
  const model = new ClaudeTurnModel()
  const reported: TurnResult[] = []
  // A fresh launch: each stream's init reports its own new identity.
  const f: Driver = driver({ resume: null, onTurnResult: (result) => reported.push(result) })
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  const handles: TurnHandle[] = []
  const pushed: { uuid: string }[] = []
  const violations: string[] = []
  const compare = (step: string) => {
    const key = keys(f, handles)
    const actual = JSON.stringify(reported.map((r) => [key(r.turnId), r.outcome]))
    if (actual !== JSON.stringify(model.completions)) violations.push(`${step}: settled ${actual}, expected ${JSON.stringify(model.completions)}`)
    const opened = JSON.stringify(f.events.filter((e) => e.type === 'turn_started').map((e) => key((e as Extract<AgentEvent, { type: 'turn_started' }>).turnId)))
    if (opened !== JSON.stringify(model.opened)) violations.push(`${step}: opened ${opened}, expected ${JSON.stringify(model.opened)}`)
    if (f.d.state !== model.state) violations.push(`${step}: state ${f.d.state}, expected ${model.state}`)
  }
  const length = 8 + next(25)
  for (let i = 0; i < length && violations.length === 0; i++) {
    const op = OPS[next(OPS.length)]!
    const q = f.q()
    const result = (uuids: string[], failed = false) => {
      const frame = frames.result(uuids, `r${i}`, failed ? 'error_during_execution' : 'success', failed) as unknown as { uuid: string }
      pushed.push(frame)
      model.result(frame.uuid, uuids, failed)
      q.push(frame as never)
    }
    if (op === 'send' || op === 'queue') {
      let handle: TurnHandle | null = null
      try {
        handle = await f.d.send(`m${i}`, op === 'queue' ? { continuation: 'queue' } : {})
      } catch (error) {
        if (!(error instanceof AgentRuntimeError) || error.category !== 'busy') throw error
      }
      if (handle) handles.push(handle)
      // Admission must agree: the reference records the send only when it, too, admits it.
      const expected = handle ? model.send(handle.turnId, handle.messageUuid, op === 'queue') : model.state === 'active' && op === 'send' ? 'busy' : 'sent'
      if ((handle ? 'sent' : 'busy') !== expected) violations.push(`${i} ${op}: ${handle ? 'sent' : 'busy'}, expected ${expected}`)
    } else if (op === 'result' || op === 'merged') {
      const unread = model.unread()
      result(op === 'merged' ? unread : unread.slice(0, 1), next(4) === 0)
    } else if (op === 'empty') result([])
    else if (op === 'queuedOnly') {
      const queued = model.queuedPrompt()
      if (queued) result([queued])
    } else if (op === 'stale') {
      const finished = model.finished()
      if (finished.length > 0) result([finished[next(finished.length)]!])
    } else if (op === 'duplicate') {
      // The very same frame again, possibly from an earlier generation.
      const old = pushed[next(pushed.length || 1)]
      if (old) {
        model.result(old.uuid, [], false)
        q.push(old as never)
      }
    } else if (op === 'unknown') result([crypto.randomUUID()])
    else if (op === 'init') {
      model.init()
      q.push(frames.init(`sess-${seed}`))
    } else if (op === 'text') q.push(frames.text(`t${i}`))
    else if (op === 'task') q.push(frames.taskNotification(`task-${i}`))
    else if (op === 'interrupt') {
      const expected = model.interrupt()
      const receipt = await f.d.interrupt()
      if (receipt.outcome !== expected) violations.push(`${i}: interrupt ${receipt.outcome}, expected ${expected}`)
    } else if (op === 'restart') {
      q.exit()
      while (f.d.state !== 'exited') await tick()
      model.restart()
      const again = f.d.start()
      while (f.queries.at(-1) === q) await tick()
      f.q().ready()
      await again
    }
    await f.q().drain()
    compare(`${i} ${op}`)
  }
  model.stop()
  await f.d.kill()
  compare('stop')
  const key = keys(f, handles)
  for (const handle of handles) {
    const result = await handle.result
    const expected = JSON.stringify(model.handles.get(handle.turnId))
    const actual = JSON.stringify([key(result.turnId), result.outcome])
    if (actual !== expected) violations.push(`handle ${handle.turnId}: ${actual}, expected ${expected}`)
  }

  const ids = new Set<string>()
  const lastSequence = new Map<string, number>()
  for (const event of f.events) {
    if (JSON.stringify(JSON.parse(JSON.stringify(event))) !== JSON.stringify(event)) violations.push(`not lossless: ${event.type}`)
    if (ids.has(event.id)) violations.push(`duplicate id ${event.id}`)
    ids.add(event.id)
    const previous = lastSequence.get(event.streamId) ?? 0
    if (event.sequence !== previous + 1) violations.push(`sequence ${previous} -> ${event.sequence}`)
    lastSequence.set(event.streamId, event.sequence)
  }
  return violations
}

describe('Claude driver: I6 over seeded streams', () => {
  // 0xA606, 300 streams, in six slices so each test stays within its timeout.
  for (let slice = 0; slice < 6; slice++) {
    test(`I6: every settlement, opening and handle matches the reference, and events are lossless, unique and ordered (streams ${slice * 50}-${slice * 50 + 49})`, async () => {
      const failures: string[] = []
      for (let i = slice * 50; i < slice * 50 + 50; i++) {
        const violations = await stream(0xa606 + i * 7919)
        if (violations.length > 0) failures.push(`stream ${i}: ${violations.join('; ')}`)
      }
      expect(failures).toEqual([])
    })
  }
})
