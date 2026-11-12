// The Claude compatibility corrections' fixture (task-98101592): Kawai's
// production composition, createChatDriver -> claudeRuntime.ts -> the
// accepted package, over one scripted CLI per spawn. Each script records the
// prompts it read, the argument of every interrupt call, and its close; its
// interrupt answers with what the test queued (a receipt or a rejection).
// Cleanup is reserved once per adapter at creation: kill, the adapter's
// settled() outcome, then every script's prompt reader (outside work the
// fixture started) — a test that asserts the outcome awaits the same promise
// the after-hook joins, so no stop reenters a second cleanup.
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatEvent } from '../../../shared/chat'
import type { ChatQueryFactory } from '../../chat/ChatSessionDriver'
import { createChatDriver } from '../../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../../chat/provider/driver'

export type Adapter = ChatAgentDriver & { settled(): Promise<void> }

export interface Script {
  push(message: Record<string, unknown>): void
  prompts: SDKUserMessage[]
  options: Options
  /** The argument of each interrupt call, in order (undefined = a plain interrupt). */
  interrupts: unknown[]
  /** What the next interrupt calls answer, oldest first; empty = an empty receipt. */
  answers: Array<{ cancelled: string[] } | Error>
  closed: boolean
  /** The script's prompt reader: ends when the package ends this generation's input. */
  reader: Promise<void>
}

export interface Outcome {
  resolved: boolean
  closed: boolean
  error?: unknown
}

function scripted(scripts: Script[]): ChatQueryFactory {
  return ({ prompt, options }) => {
    const queue: SDKMessage[] = []
    let wake: (() => void) | null = null
    const script: Script = {
      prompts: [],
      options: options as Options,
      interrupts: [],
      answers: [],
      closed: false,
      reader: Promise.resolve(),
      push: (message) => {
        queue.push({ uuid: crypto.randomUUID(), session_id: 's-1', ...message } as unknown as SDKMessage)
        wake?.()
      },
    }
    scripts.push(script)
    script.reader = (async () => {
      for await (const message of prompt) script.prompts.push(message)
    })()
    const stream = (async function* () {
      while (!script.closed) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        while (queue.length > 0) yield queue.shift()!
      }
    })()
    return Object.assign(stream, {
      interrupt: (argument?: unknown) => {
        script.interrupts.push(argument)
        const answer = script.answers.shift()
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? {})
      },
      close: () => {
        script.closed = true
        wake?.()
      },
    }) as unknown as Query
  }
}

/** Adapters created by this file's tests, each with its one reserved cleanup. */
const reserved: Array<() => Promise<Outcome>> = []

/** Run every reserved cleanup (the after-hook); a cleanup already run is joined, not repeated. */
export async function finishAll(): Promise<void> {
  for (const finish of reserved.splice(0)) await finish()
}

export function compatibilityAdapter(extra: Record<string, unknown> = {}) {
  const scripts: Script[] = []
  const events: ChatEvent[] = []
  const statuses: string[] = []
  const driver = createChatDriver({
    runtime: 'claude',
    options: {
      sessionId: 'chat-claude-compatibility',
      projectPath: '/tmp',
      queryFactory: scripted(scripts),
      onEvent: (event: ChatEvent) => void events.push(event),
      onStatus: (status: string) => void statuses.push(status),
      ...extra,
    } as never,
  }) as Adapter
  let finishing: Promise<Outcome> | null = null
  /** The one cleanup: kill, settled()'s outcome, then the prompt readers. */
  const finish = (): Promise<Outcome> => {
    finishing ??= (async () => {
      driver.kill()
      let outcome: Outcome
      try {
        await driver.settled()
        outcome = { resolved: true, closed: scripts.every((s) => s.closed) }
      } catch (error) {
        outcome = { resolved: false, closed: scripts.every((s) => s.closed), error }
      }
      await Promise.all(scripts.map((s) => s.reader))
      return outcome
    })()
    return finishing
  }
  reserved.push(finish)
  return { driver, scripts, events, statuses, finish }
}
export type Harness = ReturnType<typeof compatibilityAdapter>

export async function until(probe: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** The package stop's nested causes (the original objects), else none. */
export const causes = (error: unknown): readonly unknown[] => (error instanceof AgentRuntimeError ? error.causes : [])

export const CAPS = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1']

export const initFrame = (capabilities?: unknown) => ({
  type: 'system', subtype: 'init', model: 'claude-test', tools: [], slash_commands: [], ...(capabilities === undefined ? {} : { capabilities }),
})

/** A send whose prompt the CLI read and whose turn is open; returns the prompt. */
export async function busy(h: Harness, capabilities?: unknown, script = 0): Promise<SDKUserMessage> {
  const before = h.scripts[script]?.prompts.length ?? 0
  h.driver.send('long job')
  await until(() => (h.scripts[script]?.prompts.length ?? 0) === before + 1)
  h.scripts[script]!.push(initFrame(capabilities))
  await until(() => h.events.some((e) => e.type === 'turn_started'))
  await settle()
  return h.scripts[script]!.prompts.at(-1)!
}
