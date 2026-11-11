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

function adapter(record?: Record_) {
  const scripts: Script[] = []
  const events: ChatEvent[] = []
  const statuses: string[] = []
  const records: { messageUuid: string; turnId: string }[] = []
  const driver = createChatDriver({
    runtime: 'claude',
    options: {
      sessionId: 'chat-claude-queued',
      projectPath: '/tmp',
      queryFactory: scripted(scripts),
      onEvent: (event) => void events.push(event),
      onStatus: (status) => void statuses.push(status),
      recordWorkspaceContext: (input) => {
        records.push({ messageUuid: input.messageUuid, turnId: input.turnId })
        return (record?.(input) ?? { ok: true }) as never
      },
    },
  }) as Adapter
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
    expect(h.records.at(-1)!.messageUuid).toBe(row.messageUuid!)
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
