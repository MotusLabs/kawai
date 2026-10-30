// Agent starts await the async history load (bounded-history-capture D1,
// Table S S1–S4, property P2): send, start, and the mailbox's prepare read a
// chat's history once through the streamed async replay — never the
// synchronous whole-file read — and start the driver only after it; a memo
// already taken is not read again; a send racing prepare's load shares it,
// so one driver starts and the earlier conversation shows once; a kill
// during the load writes no memo and the starter reports the session gone —
// for prepare, the real dispatcher logs its failure and the mail dies unpushed.
// The synchronous guard left in getSnapshot logs when it reads the file.
// S5–S6 (the Codex retry rule) live in codexStartHistoryLoad.integration.test.ts.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase } from '../db'
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

const texts = (events: ChatEvent[]) => events.flatMap(event =>
  event.type === 'user_message' ? [event.text] : event.type === 'peer_message' ? [event.body] : [])

/** One invocation owns its continuations until teardown has drained them. */
function createOwner() {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-start-history-')))
  const project = path.join(tempDir, 'proj')
  const configDir = path.join(tempDir, 'claude')
  fs.mkdirSync(project)
  // A repository, so its team answer is cached: a plain directory's is not,
  // and every mail and dispatcher pass would spawn git again.
  const init = spawnSync('git', ['init', '-q', project], { env: cleanGitEnv() })
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`)
  process.env.CLAUDE_CONFIG_DIR = configDir
  const db = initDatabase({ path: ':memory:' })
  let manager: ChatSessionManager | null = null
  let spawns = 0
  let cancelled = false
  let concurrent = 0
  const restores: Array<{ mockRestore(): void }> = []
  const releases = new Set<() => void>()
  const pending = new Set<Promise<unknown>>()

  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation)
    const forget = () => { pending.delete(operation) }
    void operation.then(forget, forget)
    return operation
  }
  const restoreSpies = () => {
    for (const spy of restores.splice(0)) spy.mockRestore()
  }

  /** Built after seeding: the manager registers persisted rows when it starts. */
  const boot = () => track((async () => {
    const created = new ChatSessionManager({
      db, registry: new SessionRegistry(), onEvent: () => {}, profileCatalogHome: tempDir, authCheck: () => true,
      queryFactory: params => { spawns += 1; return fixtureQueryFactory(params) }, isDirectory: () => true,
    })
    manager = created
    await created.whenRestored()
    return created
  })())
  const internals = () => manager as unknown as Internals
  /** An idle chat with an SDK id whose transcript holds one earlier exchange. */
  const seeded = () => {
    const sdkSessionId = crypto.randomUUID()
    const dir = path.join(configDir, 'projects', 'proj')
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
    let releaseGate: (() => void) | undefined
    const gate = options.held ? new Promise<void>(resolve => { releaseGate = resolve }) : Promise.resolve()
    const release = () => { releaseGate?.(); releases.delete(release) }
    // A body resuming during cleanup must not introduce a new held gate.
    if (options.held && !cancelled) releases.add(release)
    else release()
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
    return { counts, release }
  }
  const eventually = (check: () => boolean) => track((async () => {
    for (let i = 0; i < 300 && !cancelled && !check(); i += 1) await Bun.sleep(10)
    if (!cancelled) expect(check()).toBe(true)
  })())
  /** Direct human mail to the chat: delivery runs the mailbox's prepare. */
  /** Pushed into the driver: receipt needs a transcript row the fixture never writes. */
  const pushed = (id: string) => manager!.mailbox.store.get(id)?.pushedAt != null
  const mail = (sessionId: string, body: string) => track((async () => {
    const team = await resolveTeam(project)
    return manager!.mailbox.send({ kind: 'human', team }, { to_kind: 'session', to_id: sessionId, body })
  })())

  /** Other starters running beside this one in a P2 sequence. */
  const starters: Record<string, (sessionId: string) => Promise<unknown>> = {
    send: sessionId => track(manager!.send(sessionId, 'next question')),
    start: sessionId => track(manager!.start(sessionId)),
    prepare: sessionId => track((async () => {
      const sent = await mail(sessionId, 'mail body')
      await manager!.dispatcher.settled()
      // Alone, the mail is pushed; behind another starter's turn it waits,
      // but its pass (and so prepare) has run either way.
      if (concurrent === 0) await eventually(() => pushed(sent.id))
    })()),
  }

  const cleanup = async () => {
    cancelled = true
    for (const release of releases) release()
    // A rejected Promise.all may leave siblings that create more owned work.
    while (pending.size > 0) await Promise.allSettled(pending)
    await manager?.dispatcher.settled()
    concurrent = 0
    manager?.shutdown()
    restoreSpies()
    db.close()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  return {
    boot, seeded, watch, eventually, mail, starters, internals, track, restores, restoreSpies, cleanup,
    get spawns() { return spawns },
    get cancelled() { return cancelled },
    set concurrent(value: number) { concurrent = value },
  }
}

describe('agent starts await the async history load', () => {
  let owner: ReturnType<typeof createOwner>
  beforeEach(() => { owner = createOwner() })
  afterEach(() => owner.cleanup())
  const owned = (body: (invocation: typeof owner) => Promise<void>) => () => {
    const invocation = owner
    return invocation.track(body(invocation))
  }

  for (const name of ['send', 'start', 'prepare']) {
    // @covers: chat-sessions › Agent starts load history without blocking the server › Mail delivery to a chat with a very large history
    test(`S1 ${name} reads the history once, asynchronously, before the driver starts`, owned(async invocation => {
      const { seeded, boot, watch, eventually, internals, starters } = invocation
      const run = starters[name]
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
    }))

    test(`S2 ${name} with the memo present reads nothing`, owned(async invocation => {
      const { seeded, boot, watch, internals, starters, track } = invocation
      const run = starters[name]
      const { sessionId, file } = seeded()
      const manager = await boot()
      await track(manager.loadHistory(sessionId))
      const reads = watch(file)
      await run(sessionId)
      expect(internals().drivers.has(sessionId)).toBe(true)
      expect(reads.counts).toEqual({ opens: 0, syncReads: 0 })
    }))
  }

  // @covers: chat-sessions › Agent starts load history without blocking the server › A message sent while the history is loading
  test('S3 a send while prepare’s load is in flight shares it: one read, one driver, the history once', owned(async invocation => {
    const { seeded, boot, watch, mail, eventually, track } = invocation
    const { sessionId, file } = seeded()
    const manager = await boot()
    const reads = watch(file, { held: true })
    const sent = await mail(sessionId, 'mail body')
    await eventually(() => reads.counts.opens === 1)
    const sending = track(manager.send(sessionId, 'next question'))
    await Bun.sleep(30)
    reads.release()
    expect(await sending).toEqual({ ok: true })
    // The send's turn now holds the chat (the fixture raises a card), so the
    // mail waits its turn; prepare's load already ran, shared with the send.
    await manager.dispatcher.settled()
    expect(manager.mailbox.store.get(sent.id)?.state).toBe('queued')
    expect(reads.counts).toEqual({ opens: 1, syncReads: 0 })
    expect(invocation.spawns).toBe(1)
    const shown = texts(manager.getSnapshot(sessionId)!.events)
    expect(shown.filter(text => text === 'earlier question')).toHaveLength(1)
    expect(shown.indexOf('earlier question')).toBeLessThan(shown.indexOf('next question'))
  }))

  for (const name of ['send', 'start'] as const) {
    test(`S4 a kill during ${name}’s load writes no memo and ${name} reports the session gone`, owned(async invocation => {
      const { seeded, boot, watch, eventually, internals, track } = invocation
      const { sessionId, file } = seeded()
      const manager = await boot()
      const reads = watch(file, { held: true })
      const running = track((name === 'send' ? manager.send(sessionId, 'next') : manager.start(sessionId)) as Promise<{ ok: boolean; error?: string }>)
      await eventually(() => reads.counts.opens === 1)
      expect(manager.kill(sessionId)).toBe(true)
      reads.release()
      const result = await running
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Unknown chat session')
      expect(internals().snapshotHistory.has(sessionId)).toBe(false)
      expect(internals().drivers.has(sessionId)).toBe(false)
      expect(invocation.spawns).toBe(0)
    }))
  }

  test('S4 a kill during prepare’s load writes no memo, starts no driver, and the mail dies unpushed', owned(async invocation => {
    const { seeded, boot, watch, mail, eventually, internals, restores } = invocation
    const { sessionId, file } = seeded()
    const manager = await boot()
    const warn = spyOn(logger, 'warn')
    restores.push(warn)
    const reads = watch(file, { held: true })
    const sent = await mail(sessionId, 'mail body')
    // The dispatcher's pass is inside prepare, waiting on the held load.
    await eventually(() => reads.counts.opens === 1)
    expect(manager.mailbox.store.get(sent.id)?.state).toBe('queued')
    expect(manager.kill(sessionId)).toBe(true)
    reads.release()
    await manager.dispatcher.settled()
    // Prepare's own failure, reported by the real dispatcher: the recipient
    // went away while its history loaded, so no driver was started for it.
    const failures = warn.mock.calls.filter(call => call[0] === 'team_mailbox_dispatch_failed')
      .map(call => String((call[1] as { error: unknown }).error))
    expect(failures).toEqual(['Error: Recipient disappeared'])
    const row = manager.mailbox.store.get(sent.id)
    expect([row?.state, row?.reason, row?.claimedBy ?? null, row?.pushedAt ?? null]).toEqual(['dead', 'killed-recipient', null, null])
    expect(internals().snapshotHistory.has(sessionId)).toBe(false)
    expect(internals().drivers.has(sessionId)).toBe(false)
    expect(invocation.spawns).toBe(0)
    expect(reads.counts).toEqual({ opens: 1, syncReads: 0 })
  }))

  // @covers: chat-sessions › Agent starts load history without blocking the server › History is unchanged
  test('P2 seeded concurrent starters never read a history file synchronously', owned(async invocation => {
    const { seeded, boot, watch, starters, restoreSpies } = invocation
    const chats = Array.from({ length: 30 }, () => seeded())
    const manager = await boot()
    const pick = lcg(0x57a7)
    const names = Object.keys(starters)
    let completed = 0
    for (let sequence = 0; sequence < 30; sequence += 1) {
      if (invocation.cancelled) break
      const { sessionId, file } = chats[sequence]
      const reads = watch(file)
      const order = Array.from({ length: 1 + pick(4) }, () => names[pick(names.length)])
      invocation.concurrent = order.length - 1
      await Promise.all(order.map(name => starters[name](sessionId)))
      invocation.concurrent = 0
      const context = `sequence ${sequence}: ${order.join(', ')}`
      expect([context, reads.counts]).toEqual([context, { opens: 1, syncReads: 0 }])
      expect([context, texts(manager.getSnapshot(sessionId)!.events).filter(t => t === 'earlier question').length]).toEqual([context, 1])
      completed += 1
      restoreSpies()
    }
    expect(completed).toBe(30)
  }))

  test('the synchronous guard logs when a caller skipped the await', owned(async invocation => {
    const { seeded, boot, restores } = invocation
    const { sessionId } = seeded()
    const manager = await boot()
    const debug = spyOn(logger, 'debug')
    restores.push(debug)
    // getSnapshot without a prior loadHistory: the guard reads the file.
    expect(texts(manager.getSnapshot(sessionId)!.events)).toEqual(['earlier question'])
    const logged = debug.mock.calls.filter(call => call[0] === 'chat_history_sync_capture')
    expect(logged).toEqual([['chat_history_sync_capture', { sessionId, runtime: 'claude' }]])
  }))
})
