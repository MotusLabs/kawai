// A send queued behind the active Claude turn (task 6.1 R10, A4) through the
// production composition: createChatDriver -> claudeRuntime.ts -> the
// package, over a scripted CLI, plus the manager over the development
// fixture. The old driver showed such a send at once, under the active turn.
// When the CLI ran it as a later turn, that turn opened as resumed without a
// second row. When the CLI consumed it into the active turn's result, it
// opened nothing. Every send shows exactly one row. Terminal events and usage
// stay on the turn the CLI ran. A refused contextual send shows nothing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../shared/chat'
import type { WorkspaceMessageContext } from '../../shared/planWorkspace'
import type { ChatQueryFactory } from '../chat/ChatSessionDriver'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { createClaudeChatDriver } from '../chat/provider/claudeRuntime'
import { createClaudeRuntime, type CreateClaudeRuntime } from '../chat/provider/claudeRuntimeLaunch'
import type { ChatAgentDriver } from '../chat/provider/driver'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'

type Adapter = ChatAgentDriver & { settled(): Promise<void> }
const live: Adapter[] = []
afterEach(async () => {
  for (const driver of live.splice(0)) {
    driver.kill()
    await driver.settled().catch(() => {})
  }
})

interface Script {
  push(message: Record<string, unknown>): void
  prompts: SDKUserMessage[]
  options: Options
  closed: boolean
}

function scripted(scripts: Script[]): ChatQueryFactory {
  return ({ prompt, options }) => {
    const queue: SDKMessage[] = []
    let wake: (() => void) | null = null
    const script: Script = {
      prompts: [],
      options: options as Options,
      closed: false,
      push: (message) => {
        queue.push({ uuid: crypto.randomUUID(), session_id: 's-1', ...message } as unknown as SDKMessage)
        wake?.()
      },
    }
    scripts.push(script)
    void (async () => {
      for await (const message of prompt) script.prompts.push(message)
    })()
    const stream = (async function* () {
      while (!script.closed) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        while (queue.length > 0) yield queue.shift()!
      }
    })()
    return Object.assign(stream, {
      interrupt: () => Promise.resolve(),
      close: () => {
        script.closed = true
        wake?.()
      },
    }) as unknown as Query
  }
}

type Record_ = (input: { messageUuid: string; turnId: string }) => { ok: true } | { ok: false; message: string }

/** Production composition; `create` wraps the public package factory only when a case needs it. */
function adapter(record?: Record_, create?: CreateClaudeRuntime) {
  const scripts: Script[] = []
  const events: ChatEvent[] = []
  const statuses: string[] = []
  const records: { messageUuid: string; turnId: string }[] = []
  const options = {
    sessionId: 'chat-claude-queued',
    projectPath: '/tmp',
    queryFactory: scripted(scripts),
    onEvent: (event: ChatEvent) => void events.push(event),
    onStatus: (status: string) => void statuses.push(status),
    recordWorkspaceContext: (input: { messageUuid: string; turnId: string }) => {
      records.push({ messageUuid: input.messageUuid, turnId: input.turnId })
      return (record?.(input) ?? { ok: true }) as never
    },
  }
  const driver = (create ? createClaudeChatDriver(options as never, create) : createChatDriver({ runtime: 'claude', options: options as never })) as Adapter
  live.push(driver)
  return { driver, scripts, events, statuses, records }
}
type H = ReturnType<typeof adapter>

async function until(probe: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

const init = { type: 'system', subtype: 'init', model: 'claude-test', tools: [], slash_commands: [] }
const result = (uuids: string[], tokens: number) => ({
  type: 'result', subtype: 'success', is_error: false, result: `done ${tokens}`, num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  usage: { input_tokens: tokens, output_tokens: 1 }, user_message_uuid: uuids[0], user_message_uuids: uuids,
})

/** The visible trace: type, turn, and what identifies each row. */
function trace(h: H): unknown[] {
  return h.events.flatMap((e): unknown[][] => {
    if (e.type === 'turn_started') return [['turn_started', e.turnId, e.trigger?.kind ?? null]]
    if (e.type === 'user_message') return [['user_message', e.turnId, e.text, e.messageUuid]]
    if (e.type === 'turn_completed') return [['turn_completed', e.turnId, e.usage?.inputTokens ?? null]]
    if (e.type === 'turn_interrupted' || e.type === 'approval_request') return [[e.type, e.turnId]]
    return []
  })
}

/** Turn A open with an approval pending; returns A's turn id and prompt uuid. */
async function heldTurn(h: H): Promise<{ turnA: string; uuidA: string }> {
  h.driver.send('first')
  await until(() => h.scripts[0]?.prompts.length === 1)
  h.scripts[0]!.push(init)
  const turnA = (h.events.find((e) => e.type === 'turn_started') as { turnId: string }).turnId
  void h.scripts[0]!.options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'r' } as never)
  await until(() => h.events.some((e) => e.type === 'approval_request'))
  return { turnA, uuidA: String(h.scripts[0]!.prompts[0]!.uuid) }
}

async function queued(h: H, text: string): Promise<string> {
  const before = h.scripts[0]!.prompts.length
  h.driver.send(text)
  await until(() => h.scripts[0]!.prompts.length === before + 1)
  await settle()
  return String(h.scripts[0]!.prompts[before]!.uuid)
}

const approve = (h: H) => {
  const requestId = h.driver.getPendingRequests()[0]!.requestId
  expect(h.driver.resolveApproval(requestId, 'allow')).toEqual({ ok: true })
}

describe('a send queued behind the active Claude turn (R10)', () => {
  test('T1/T3: shown at once under the held turn; a separate CLI turn opens as resumed with no second row and its own result', async () => {
    const h = adapter()
    const { turnA, uuidA } = await heldTurn(h)
    const uuidB = await queued(h, 'second')
    expect(trace(h)).toEqual([
      ['turn_started', turnA, null], ['user_message', turnA, 'first', uuidA], ['approval_request', turnA], ['user_message', turnA, 'second', uuidB],
    ])
    expect(h.driver.getPendingRequests()).toHaveLength(1)
    expect(h.statuses.at(-1)).toBe('permission')
    approve(h)
    h.scripts[0]!.push(result([uuidA], 10))
    await until(() => h.events.filter((e) => e.type === 'turn_started').length === 2)
    h.scripts[0]!.push(init)
    h.scripts[0]!.push({ type: 'assistant', message: { id: 'a-b', role: 'assistant', content: [{ type: 'text', text: 'b done' }] } })
    h.scripts[0]!.push(result([uuidB], 20))
    await until(() => h.events.filter((e) => e.type === 'turn_completed').length === 2)
    await settle()
    const turnB = (h.events.filter((e) => e.type === 'turn_started')[1] as { turnId: string }).turnId
    expect(turnB).not.toBe(turnA)
    expect(trace(h).slice(4)).toEqual([['turn_completed', turnA, 10], ['turn_started', turnB, 'resumed'], ['turn_completed', turnB, 20]])
    const text = h.events.find((e) => e.type === 'assistant_text' && e.text === 'b done') as { turnId: string } | undefined
    expect(text?.turnId).toBe(turnB)
    expect(h.statuses.at(-1)).toBe('waiting')
  })

  test('T2/T4: a result naming queued prompts absorbs them (no turn events); repeated text keeps distinct rows; an unnamed one runs as resumed', async () => {
    const h = adapter()
    const { turnA, uuidA } = await heldTurn(h)
    const uuidB = await queued(h, 'same')
    const uuidC = await queued(h, 'same')
    expect(uuidB).not.toBe(uuidC)
    approve(h)
    h.scripts[0]!.push(result([uuidA, uuidB], 10))
    await until(() => h.events.filter((e) => e.type === 'turn_started').length === 2)
    h.scripts[0]!.push(init)
    h.scripts[0]!.push(result([uuidC], 30))
    await until(() => h.events.filter((e) => e.type === 'turn_completed').length === 2)
    await settle()
    const turnC = (h.events.filter((e) => e.type === 'turn_started')[1] as { turnId: string }).turnId
    expect(trace(h)).toEqual([
      ['turn_started', turnA, null], ['user_message', turnA, 'first', uuidA], ['approval_request', turnA],
      ['user_message', turnA, 'same', uuidB], ['user_message', turnA, 'same', uuidC],
      ['turn_completed', turnA, 10], ['turn_started', turnC, 'resumed'], ['turn_completed', turnC, 30],
    ])
  })

  test('T5-T7: an accepted queued context shows with its context; a refused or throwing record shows nothing and enqueues nothing', async () => {
    let mode: 'ok' | 'refuse' | 'throw' = 'ok'
    const h = adapter(() => {
      if (mode === 'throw') throw new Error('disk gone')
      return mode === 'refuse' ? { ok: false, message: 'No such plan.' } : { ok: true }
    })
    const { turnA } = await heldTurn(h)
    const context = { teamId: 't', planId: 'p', planTitle: 'Plan', version: { kind: 'revision', revision: 1 }, executionId: null, changeName: null, documentRefId: null } as unknown as WorkspaceMessageContext
    expect(await h.driver.sendWorkspaceContext!('with context', context)).toEqual({ ok: true })
    const row = h.events.filter((e) => e.type === 'user_message').at(-1) as Extract<ChatEvent, { type: 'user_message' }>
    expect([row.turnId, row.text, row.workspaceContext]).toEqual([turnA, 'with context', context])
    // Recorded under the active turn it shows in, with its own uuid (plan-workspace I2).
    expect(h.records.at(-1)).toEqual({ messageUuid: row.messageUuid!, turnId: turnA })
    const prompts = h.scripts[0]!.prompts.length
    const rows = h.events.filter((e) => e.type === 'user_message').length
    mode = 'refuse'
    expect(await h.driver.sendWorkspaceContext!('refused', context)).toEqual({ ok: false, error: 'No such plan. The message was not sent.' })
    mode = 'throw'
    expect(await h.driver.sendWorkspaceContext!('thrown', context)).toEqual({ ok: false, error: 'The plan context could not be recorded (disk gone); the message was not sent.' })
    await settle()
    expect(h.scripts[0]!.prompts.length).toBe(prompts)
    expect(h.events.filter((e) => e.type === 'user_message').length).toBe(rows)
    expect(h.events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
  })

  test('T8: an interrupt with a send queued closes the active turn once; the queued row stays and its turn never opens', async () => {
    const h = adapter()
    const { turnA, uuidA } = await heldTurn(h)
    const uuidB = await queued(h, 'second')
    await h.driver.interrupt()
    h.scripts[0]!.push(result([uuidA], 10))
    h.scripts[0]!.push(result([uuidB], 20))
    await settle()
    expect(trace(h)).toEqual([
      ['turn_started', turnA, null], ['user_message', turnA, 'first', uuidA], ['approval_request', turnA],
      ['user_message', turnA, 'second', uuidB], ['turn_interrupted', turnA],
    ])
  })

  test('T9: a kill with a send queued closes the active turn once and opens nothing later', async () => {
    const h = adapter()
    const { turnA, uuidA } = await heldTurn(h)
    const uuidB = await queued(h, 'second')
    h.driver.kill()
    await h.driver.settled().catch(() => {})
    await settle()
    expect(trace(h)).toEqual([
      ['turn_started', turnA, null], ['user_message', turnA, 'first', uuidA], ['approval_request', turnA],
      ['user_message', turnA, 'second', uuidB], ['turn_interrupted', turnA],
    ])
  })
})

describe('queued sends: original identity and order (R10)', () => {
  test('I2 two contextual messages in one active turn keep distinct contexts, both recorded under that turn', async () => {
    const h = adapter()
    const context = { teamId: '/repo/example/main', planId: 'plan-1', planTitle: 'Workspace roadmap', version: { kind: 'revision', revision: 2, contentHash: 'a'.repeat(64) }, executionId: null, changeName: 'plan-workspace', documentRefId: null } as unknown as WorkspaceMessageContext
    const sent = [h.driver.sendWorkspaceContext!('first message', context), h.driver.sendWorkspaceContext!('second message', context)]
    expect(await Promise.all(sent)).toEqual([{ ok: true }, { ok: true }])
    await settle()
    expect(h.events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
    const turnId = (h.events[0] as { turnId: string }).turnId
    const userEvents = h.events.filter((e) => e.type === 'user_message') as Extract<ChatEvent, { type: 'user_message' }>[]
    expect(userEvents.map((e) => [e.turnId, e.text, e.workspaceContext])).toEqual([[turnId, 'first message', context], [turnId, 'second message', context]])
    const uuids = userEvents.map((e) => e.messageUuid ?? '')
    expect(uuids[0]).not.toBe(uuids[1])
    expect(h.records.map((row) => row.turnId)).toEqual([turnId, turnId])
    expect(h.records.map((row) => row.messageUuid)).toEqual(uuids)
    expect(h.scripts[0]!.prompts.map((p) => String(p.uuid))).toEqual(uuids)
  })

  /**
   * The package composition with one change: the adapter gets each send's
   * handle only once the package has published `releaseAfter` (the result
   * that ends A), so A's result is handled between B's commit and the
   * adapter's resume.
   */
  function lateHandles(releaseAfter: (pkg: string[]) => boolean): { create: CreateClaudeRuntime; pkg: string[] } {
    const pkg: string[] = []
    const create: CreateClaudeRuntime = (options, queryFactory, wire) => {
      const onEvent = options.callbacks.onEvent
      const inner = createClaudeRuntime({ ...options, callbacks: { ...options.callbacks, onEvent: (event) => (pkg.push(`${event.type}${'turnId' in event ? ` ${event.turnId}` : ''}`), onEvent?.(event)) } }, queryFactory, wire)
      return new Proxy(inner, {
        get(target, key) {
          if (key !== 'send') {
            const value = Reflect.get(target, key) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (...args: Parameters<typeof inner.send>) => {
            const handle = await target.send(...args)
            pkg.push(`committed ${handle.turnId}`)
            if (target.state === 'active' && pkg.some((line) => line.startsWith('turn_started')) && pkg.filter((l) => l.startsWith('committed')).length > 1) await until(() => releaseAfter(pkg))
            pkg.push(`resumed ${handle.turnId}`)
            return handle
          }
        },
      })
    }
    return { create, pkg }
  }

  test('enqueue, then A\'s separate result, then the host resume: B stays on A before A completes; its CLI turn opens as resumed', async () => {
    const late = lateHandles((pkg) => pkg.some((line) => line.startsWith('turn_completed')))
    const h = adapter(undefined, late.create)
    const { turnA, uuidA } = await heldTurn(h)
    approve(h)
    h.driver.send('second')
    await until(() => h.scripts[0]!.prompts.length === 2)
    const uuidB = String(h.scripts[0]!.prompts[1]!.uuid)
    h.scripts[0]!.push(result([uuidA], 10))
    await until(() => late.pkg.some((line) => line.startsWith('resumed')) && late.pkg.filter((l) => l.startsWith('resumed')).length === 2)
    // The package handled A's result (and opened B) before the adapter had B's handle.
    const turnB = late.pkg.filter((l) => l.startsWith('committed')).at(-1)!.split(' ')[1]!
    expect(late.pkg.indexOf(`turn_completed ${turnA}`)).toBeLessThan(late.pkg.indexOf(`resumed ${turnB}`))
    expect(late.pkg.indexOf(`turn_started ${turnB}`)).toBeLessThan(late.pkg.indexOf(`resumed ${turnB}`))
    h.scripts[0]!.push(init)
    h.scripts[0]!.push(result([uuidB], 20))
    await until(() => h.events.filter((e) => e.type === 'turn_completed').length === 2)
    await settle()
    expect(trace(h)).toEqual([
      ['turn_started', turnA, null], ['user_message', turnA, 'first', uuidA], ['approval_request', turnA],
      ['user_message', turnA, 'second', uuidB], ['turn_completed', turnA, 10], ['turn_started', turnB, 'resumed'], ['turn_completed', turnB, 20],
    ])
    expect(h.statuses.at(-1)).toBe('waiting')
  })

  test('enqueue, then A\'s result absorbing B, then the host resume: B stays on A before A completes; no B turn; a later send is a plain turn', async () => {
    const late = lateHandles((pkg) => pkg.some((line) => line.startsWith('turn_completed')))
    const h = adapter(undefined, late.create)
    const { turnA, uuidA } = await heldTurn(h)
    approve(h)
    h.driver.send('second')
    await until(() => h.scripts[0]!.prompts.length === 2)
    const uuidB = String(h.scripts[0]!.prompts[1]!.uuid)
    h.scripts[0]!.push(result([uuidA, uuidB], 10))
    await until(() => late.pkg.filter((l) => l.startsWith('resumed')).length === 2)
    await settle()
    h.driver.send('third')
    await until(() => h.scripts[0]!.prompts.length === 3)
    const uuidC = String(h.scripts[0]!.prompts[2]!.uuid)
    h.scripts[0]!.push(init)
    h.scripts[0]!.push(result([uuidC], 30))
    await until(() => h.events.filter((e) => e.type === 'turn_completed').length === 2)
    await settle()
    const turnC = (h.events.filter((e) => e.type === 'turn_started')[1] as { turnId: string }).turnId
    expect(trace(h)).toEqual([
      ['turn_started', turnA, null], ['user_message', turnA, 'first', uuidA], ['approval_request', turnA],
      ['user_message', turnA, 'second', uuidB], ['turn_completed', turnA, 10],
      ['turn_started', turnC, null], ['user_message', turnC, 'third', uuidC], ['turn_completed', turnC, 30],
    ])
  })
})

describe('the manager over the development fixture (R10)', () => {
  let tempDir: string
  let db: SessionDatabase
  let manager: ChatSessionManager | null = null
  let priorHold: string | undefined
  beforeEach(() => {
    priorHold = process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
    process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = '0'
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-queued-send-')))
    fs.mkdirSync(path.join(tempDir, 'project'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
  })
  afterEach(async () => {
    if (manager) {
      manager.shutdown()
      await manager.retiredSettled()
      await manager.dispatcher.settled()
      manager = null
    }
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
    if (priorHold === undefined) delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
    else process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = priorHold
  })

  test('a send while an approval holds the turn shows at once under it, then runs as its own resumed turn with one row', async () => {
    const events: ChatEvent[] = []
    manager = new ChatSessionManager({
      db, registry: new SessionRegistry(), onEvent: (_id, event) => void events.push(event), profileCatalogHome: tempDir, authCheck: () => true,
      queryFactory: fixtureQueryFactory,
    })
    const created = await manager.createAvailableSession({ projectPath: path.join(tempDir, 'project') })
    if (!created.ok) throw new Error(created.error)
    const sessionId = created.session.id
    expect(await manager.send(sessionId, 'Show an approval')).toEqual({ ok: true })
    await until(() => events.some((e) => e.type === 'approval_request'))
    const turnA = (events.find((e) => e.type === 'approval_request') as { turnId: string }).turnId
    expect(await manager.send(sessionId, 'queued while held')).toEqual({ ok: true })
    await until(() => events.some((e) => e.type === 'user_message' && e.text === 'queued while held'), 2_000)
    const row = events.find((e) => e.type === 'user_message' && e.text === 'queued while held') as { turnId: string }
    expect(row.turnId).toBe(turnA)
    expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
    const requestId = (events.find((e) => e.type === 'approval_request') as { requestId: string }).requestId
    expect(manager.resolveApproval(sessionId, requestId, 'allow')).toEqual({ ok: true })
    await until(() => events.filter((e) => e.type === 'turn_completed').length === 2)
    await settle()
    const starts = events.filter((e) => e.type === 'turn_started') as Extract<ChatEvent, { type: 'turn_started' }>[]
    expect(starts.map((e) => e.trigger?.kind ?? null)).toEqual([null, 'resumed'])
    expect(events.filter((e) => e.type === 'user_message' && e.text === 'queued while held')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn_completed').map((e) => (e as { turnId: string }).turnId)).toEqual([turnA, starts[1]!.turnId])
  })
})
