// Agent starts await the async history load (bounded-history-capture D1,
// Table S S1–S4, property P2): send, start, and the mailbox's prepare read a
// chat's history once through the streamed async replay — never the
// synchronous whole-file read — and start the driver only after it; a memo
// already taken is not read again; a send racing prepare's load shares it,
// so one driver starts and the earlier conversation shows once; a kill
// during the load writes no memo and the starter reports the session gone.
// The synchronous guard left in getSnapshot logs when it reads the file.
// S5–S6 (the Codex retry rule) live in codexStartHistoryLoad.integration.test.ts.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { initDatabase, type SessionDatabase } from '../db'
import { logger } from '../logger'
import { SessionRegistry } from '../SessionRegistry'
import { resolveTeam } from '../team/teamIdentity'

const transcript = () => [
  JSON.stringify({
    type: 'user', uuid: crypto.randomUUID(), timestamp: new Date(Date.now() - 60_000).toISOString(),
    message: { role: 'user', content: 'earlier question' },
  }),
  JSON.stringify({
    type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date(Date.now() - 59_000).toISOString(),
    message: { id: `msg-${crypto.randomUUID()}`, content: [{ type: 'text', text: 'earlier answer' }] },
  }),
].join('\n')

type Internals = {
  drivers: Map<string, unknown>
  snapshotHistory: Map<string, ChatEvent[]>
}

function lcg(seed: number) {
  let state = seed >>> 0
  return (n: number) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return (state >>> 16) % n
  }
}

describe('agent starts await the async history load', () => {
  let tempDir: string
  let project: string
  let db: SessionDatabase
  let manager: ChatSessionManager | null
  let spawns: number
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const restores: Array<{ mockRestore(): void }> = []

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-start-history-')))
    project = path.join(tempDir, 'proj')
    fs.mkdirSync(project)
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude')
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    spawns = 0
    manager = null
  })
  afterEach(() => {
    for (const spy of restores.splice(0)) spy.mockRestore()
    manager?.shutdown()
    db.close()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** Built after seeding: the manager registers persisted rows when it starts. */
  const boot = async () => {
    const created = new ChatSessionManager({
      db, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: tempDir, authCheck: () => true,
      queryFactory: params => { spawns += 1; return fixtureQueryFactory(params) }, isDirectory: () => true,
    })
    manager = created
    await created.whenRestored()
    return created
  }
  const internals = () => manager as unknown as Internals
  /** An idle chat with an SDK id whose transcript holds one earlier exchange. */
  const seeded = () => {
    const sdkSessionId = crypto.randomUUID()
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'proj')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${sdkSessionId}.jsonl`)
    fs.writeFileSync(file, transcript())
    const sessionId = `chat-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId, name: 'chat', projectPath: project, sdkSessionId,
      status: 'waiting', createdAt: now, lastActivityAt: now, nameSource: 'manual',
    })
    return { sessionId, file }
  }
  /** Counts async opens and sync whole-file reads of `file`; opens wait on the gate while held. */
  const watch = (file: string, options: { held?: boolean } = {}) => {
    let release!: () => void
    const gate = options.held ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
    const counts = { opens: 0, syncReads: 0 }
    const open = fsp.open.bind(fsp)
    restores.push(spyOn(fsp, 'open').mockImplementation((async (target: Parameters<typeof fsp.open>[0], ...rest: unknown[]) => {
      if (String(target) === file) { counts.opens += 1; await gate }
      return (open as (...args: unknown[]) => ReturnType<typeof fsp.open>)(target, ...rest)
    }) as typeof fsp.open))
    const readFileSync = fs.readFileSync.bind(fs)
    restores.push(spyOn(fs, 'readFileSync').mockImplementation(((target: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
      if (String(target) === file) counts.syncReads += 1
      return (readFileSync as (...args: unknown[]) => unknown)(target, ...rest)
    }) as typeof fs.readFileSync))
    return { counts, release: () => release?.() }
  }
  const eventually = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i += 1) await Bun.sleep(10)
    expect(check()).toBe(true)
  }
  /** Direct human mail to the chat: delivery runs the mailbox's prepare. */
  /** Pushed into the driver: receipt needs a transcript row the fixture never writes. */
  const pushed = (id: string) => manager!.mailbox.store.get(id)?.pushedAt != null
  const mail = async (sessionId: string, body: string) => {
    const team = await resolveTeam(project)
    return manager!.mailbox.send({ kind: 'human', team }, { to_kind: 'session', to_id: sessionId, body })
  }
  const texts = (events: ChatEvent[]) => events.flatMap(event =>
    event.type === 'user_message' ? [event.text] : event.type === 'peer_message' ? [event.body] : [])

  /** Other starters running beside this one in a P2 sequence. */
  let concurrent = 0
  const starters: Record<string, (sessionId: string) => Promise<unknown>> = {
    send: sessionId => manager!.send(sessionId, 'next question'),
    start: sessionId => manager!.start(sessionId),
    prepare: async sessionId => {
      const sent = await mail(sessionId, 'mail body')
      await manager!.dispatcher.settled()
      // Alone, the mail is pushed; behind another starter's turn it waits,
      // but its pass (and so prepare) has run either way.
      if (concurrent === 0) await eventually(() => pushed(sent.id))
    },
  }

  for (const [name, run] of Object.entries(starters)) {
    // @covers: chat-sessions › Agent starts load history without blocking the server › Mail delivery to a chat with a very large history
    test(`S1 ${name} reads the history once, asynchronously, before the driver starts`, async () => {
      const { sessionId, file } = seeded()
      await boot()
      const reads = watch(file, { held: true })
      const running = run(sessionId)
      await eventually(() => reads.counts.opens === 1)
      // The load is held: nothing has started a driver yet.
      await Bun.sleep(30)
      expect(internals().drivers.has(sessionId)).toBe(false)
      reads.release()
      await running
      expect(internals().drivers.has(sessionId)).toBe(true)
      expect(reads.counts).toEqual({ opens: 1, syncReads: 0 })
    })

    test(`S2 ${name} with the memo present reads nothing`, async () => {
      const { sessionId, file } = seeded()
      const manager = await boot()
      await manager.loadHistory(sessionId)
      const reads = watch(file)
      await run(sessionId)
      expect(internals().drivers.has(sessionId)).toBe(true)
      expect(reads.counts).toEqual({ opens: 0, syncReads: 0 })
    })
  }

  // @covers: chat-sessions › Agent starts load history without blocking the server › A message sent while the history is loading
  test('S3 a send while prepare’s load is in flight shares it: one read, one driver, the history once', async () => {
    const { sessionId, file } = seeded()
    const manager = await boot()
    const reads = watch(file, { held: true })
    const sent = await mail(sessionId, 'mail body')
    await eventually(() => reads.counts.opens === 1)
    const sending = manager.send(sessionId, 'next question')
    await Bun.sleep(30)
    reads.release()
    expect(await sending).toEqual({ ok: true })
    // The send's turn now holds the chat (the fixture raises a card), so the
    // mail waits its turn; prepare's load already ran, shared with the send.
    await manager.dispatcher.settled()
    expect(manager.mailbox.store.get(sent.id)?.state).toBe('queued')
    expect(reads.counts).toEqual({ opens: 1, syncReads: 0 })
    expect(spawns).toBe(1)
    const shown = texts(manager.getSnapshot(sessionId)!.events)
    expect(shown.filter(text => text === 'earlier question')).toHaveLength(1)
    expect(shown.indexOf('earlier question')).toBeLessThan(shown.indexOf('next question'))
  })

  for (const name of ['send', 'start'] as const) {
    test(`S4 a kill during ${name}’s load writes no memo and ${name} reports the session gone`, async () => {
      const { sessionId, file } = seeded()
      const manager = await boot()
      const reads = watch(file, { held: true })
      const running = (name === 'send' ? manager.send(sessionId, 'next') : manager.start(sessionId)) as Promise<{ ok: boolean; error?: string }>
      await eventually(() => reads.counts.opens === 1)
      expect(manager.kill(sessionId)).toBe(true)
      reads.release()
      const result = await running
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Unknown chat session')
      expect(internals().snapshotHistory.has(sessionId)).toBe(false)
      expect(internals().drivers.has(sessionId)).toBe(false)
      expect(spawns).toBe(0)
    })
  }

  // @covers: chat-sessions › Agent starts load history without blocking the server › History is unchanged
  test('P2 seeded concurrent starters never read a history file synchronously', async () => {
    const chats = Array.from({ length: 30 }, () => seeded())
    const manager = await boot()
    const pick = lcg(0x57a7)
    const names = Object.keys(starters)
    for (let sequence = 0; sequence < 30; sequence += 1) {
      const { sessionId, file } = chats[sequence]
      const reads = watch(file)
      const order = Array.from({ length: 1 + pick(4) }, () => names[pick(names.length)])
      concurrent = order.length - 1
      await Promise.all(order.map(name => starters[name](sessionId)))
      concurrent = 0
      const context = `sequence ${sequence}: ${order.join(', ')}`
      expect([context, reads.counts]).toEqual([context, { opens: 1, syncReads: 0 }])
      expect([context, texts(manager.getSnapshot(sessionId)!.events).filter(t => t === 'earlier question').length]).toEqual([context, 1])
      for (const spy of restores.splice(0)) spy.mockRestore()
    }
  })

  test('the synchronous guard logs when a caller skipped the await', async () => {
    const { sessionId } = seeded()
    const manager = await boot()
    const debug = spyOn(logger, 'debug')
    restores.push(debug)
    // getSnapshot without a prior loadHistory: the guard reads the file.
    expect(texts(manager.getSnapshot(sessionId)!.events)).toEqual(['earlier question'])
    const logged = debug.mock.calls.filter(call => call[0] === 'chat_history_sync_capture')
    expect(logged).toEqual([['chat_history_sync_capture', { sessionId, runtime: 'claude' }]])
  })
})
