// Ownership of Kawai's Claude composition (task 6.1, A5/A10): createChatDriver
// → claudeRuntime.ts → the public package factory over a scripted query.
// "The process ended" is the scripted query's own close; failures are the
// objects this test's callbacks threw or rejected with.
// - The identity callback's returned promise is the package's persistence
//   barrier and owned: a held one holds settled(); a rejected one reaches
//   settled() as the original object (inside the package stop's causes), once.
// - A synchronous callback throw reaches settled() once; concurrent waits
//   share one report and a later wait reports nothing again.
// - The persistence runs outside the package's callback ancestry: work it
//   starts can send later (outsideRuntime).
// - A delivery opens its turn synchronously in deliver() (the mailbox records
//   the work right after, deliveredTurns.ts); the package's turn shows under
//   that id to its end, and an interrupt before the package opened it closes
//   the opened turn.
import { afterEach, describe, expect, test } from 'bun:test'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatEvent } from '../../shared/chat'
import type { ChatQueryFactory } from '../chat/provider/claudeDriverTypes'
import { createChatDriver } from '../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../chat/provider/driver'

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
  closed: boolean
}

/** One scripted CLI per spawn: frames the test pushes, prompts it reads, its close. */
function scripted(scripts: Script[]): ChatQueryFactory {
  return ({ prompt }) => {
    const queue: SDKMessage[] = []
    let wake: (() => void) | null = null
    const script: Script = {
      prompts: [],
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

interface Hooks {
  onSdkSessionId?: (driver: Adapter, id: string) => unknown
  onModel?: (driver: Adapter) => unknown
}

function adapter(hooks: Hooks = {}) {
  const scripts: Script[] = []
  const events: ChatEvent[] = []
  const box: { driver?: Adapter } = {}
  const driver = createChatDriver({
    runtime: 'claude',
    options: {
      sessionId: 'chat-claude-ownership',
      projectPath: '/tmp',
      queryFactory: scripted(scripts),
      onEvent: (event) => void events.push(event),
      onStatus: () => {},
      ...(hooks.onSdkSessionId ? { onSdkSessionId: (id: string) => hooks.onSdkSessionId!(box.driver!, id) as void } : {}),
      ...(hooks.onModel ? { onModel: () => hooks.onModel!(box.driver!) as void } : {}),
    },
  }) as Adapter
  box.driver = driver
  live.push(driver)
  return { driver, scripts, events }
}

async function until(probe: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function outcome(h: ReturnType<typeof adapter>): Promise<{ resolved: boolean; closed: boolean; error?: unknown }> {
  try {
    await h.driver.settled()
    return { resolved: true, closed: h.scripts.every((s) => s.closed) }
  } catch (error) {
    return { resolved: false, closed: h.scripts.every((s) => s.closed), error }
  }
}

const causes = (error: unknown) => (error instanceof AgentRuntimeError ? error.causes : [])
const init = { type: 'system', subtype: 'init', model: 'claude-test', tools: [], slash_commands: [] }

describe('Claude adapter ownership through the public factory', () => {
  test('a held identity persistence holds settled(); its rejection is reported once as the original object', async () => {
    let release!: (value?: unknown) => void
    const held = new Promise((resolve) => (release = resolve))
    const h = adapter({ onSdkSessionId: () => held })
    h.driver.start()
    await until(() => h.scripts.length === 1)
    h.scripts[0]!.push(init)
    await new Promise((resolve) => setTimeout(resolve, 50))
    h.driver.kill()
    const order: string[] = []
    const waiting = outcome(h).then((o) => (order.push('settled'), o))
    await new Promise((resolve) => setTimeout(resolve, 100))
    order.push('release')
    release()
    expect((await waiting).resolved).toBe(true)
    expect(order).toEqual(['release', 'settled'])

    const boom = new Error('session store down')
    const r = adapter({ onSdkSessionId: () => Promise.reject(boom) })
    r.driver.start()
    await until(() => r.scripts.length === 1)
    r.scripts[0]!.push(init)
    await new Promise((resolve) => setTimeout(resolve, 50))
    r.driver.kill()
    const first = await outcome(r)
    expect([first.resolved, first.closed, causes(first.error).includes(boom)]).toEqual([false, true, true])
    expect(await outcome(r)).toEqual({ resolved: true, closed: true })
  })

  test('a synchronous callback throw reaches settled() once; concurrent waits share one report', async () => {
    const boom = new Error('model observer bug')
    const h = adapter({ onModel: () => { throw boom } })
    h.driver.start()
    await until(() => h.scripts.length === 1)
    h.scripts[0]!.push(init)
    await new Promise((resolve) => setTimeout(resolve, 50))
    h.driver.kill()
    const [a, b] = await Promise.all([outcome(h), outcome(h)])
    expect(a.error).toBe(b.error)
    expect([a.resolved, a.closed, causes(a.error).filter((cause) => cause === boom).length]).toEqual([false, true, 1])
    expect(await outcome(h)).toEqual({ resolved: true, closed: true })
  })

  test('work the identity persistence starts sends later, outside the callback ancestry', async () => {
    let later: Promise<void> | null = null
    const h = adapter({
      // A host side effect that outlives the callback (as the mail dispatcher's loop does).
      onSdkSessionId: (driver) => void (later = new Promise<void>((resolve) => setTimeout(() => { driver.send('from later work'); resolve() }, 20))),
    })
    h.driver.start()
    await until(() => h.scripts.length === 1)
    h.scripts[0]!.push(init)
    await until(() => later !== null)
    await later
    await until(() => h.scripts[0]!.prompts.length === 1)
    expect(h.scripts[0]!.prompts[0]!.message.content).toBe('from later work')
    expect(h.events.filter((e) => e.type === 'error')).toEqual([])
  })

  test('a delivery opens its turn in deliver(); the package turn shows under that id to its end', async () => {
    const h = adapter()
    h.driver.start()
    await until(() => h.scripts.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    h.driver.deliver({ messageId: 'm-1', senderKind: 'agent', senderSession: 'chat-lead', body: 'do it' } as never)
    // Synchronously, before deliver() returned.
    const opened = h.events.map((e) => [e.type, (e as { turnId?: string }).turnId])
    expect(opened.map(([type]) => type)).toEqual(['turn_started', 'peer_message'])
    const turnId = opened[0]![1]!
    expect(opened[1]![1]).toBe(turnId)
    await until(() => h.scripts[0]!.prompts.length === 1)
    const uuid = String(h.scripts[0]!.prompts[0]!.uuid)
    h.scripts[0]!.push(init)
    h.scripts[0]!.push({ type: 'assistant', message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
    h.scripts[0]!.push({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: { input_tokens: 1, output_tokens: 1 }, user_message_uuid: uuid, user_message_uuids: [uuid] })
    await until(() => h.events.some((e) => e.type === 'turn_completed'))
    // One turn start (the package's own start was absorbed), every event under the opened id.
    expect(h.events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
    expect(new Set(h.events.filter((e) => 'turnId' in e).map((e) => (e as { turnId: string }).turnId))).toEqual(new Set([turnId]))
    expect(h.events.filter((e) => e.type === 'user_message')).toEqual([])
  })

  test('an interrupt before the package opened a delivery closes the opened turn and withdraws its send', async () => {
    const h = adapter()
    h.driver.deliver({ messageId: 'm-2', senderKind: 'agent', senderSession: 'chat-lead', body: 'stop me' } as never)
    const turnId = (h.events[0] as { turnId: string }).turnId
    await h.driver.interrupt()
    await until(() => h.scripts.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.events.map((e) => [e.type, (e as { turnId?: string }).turnId])).toEqual([
      ['turn_started', turnId], ['peer_message', turnId], ['turn_interrupted', turnId],
    ])
    expect(h.scripts[0]!.prompts).toEqual([])
  })
})
