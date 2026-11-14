// The Claude compatibility corrections' fixture (task-98101592): Kawai's
// production composition, createChatDriver -> claudeRuntime.ts -> the
// accepted package, over one scripted CLI per spawn. Each script records the
// prompts it read, the argument of every interrupt call, and its close; its
// interrupt answers with what the test queued (a receipt or a rejection), its
// optional context probe with what the test's function returns, and exit()
// ends its stream as a CLI exit would.
// Cleanup invariant: each adapter has one cleanup promise, stored before any
// of its effects run (the body starts a microtask later), so a reentrant or
// overlapping finish() — from a test, a callback inside kill, or the
// after-hook — joins that promise and never runs a second body. The body is
// kill, the adapter's settled() outcome, then every script's prompt reader
// (outside work the fixture started). finishAll() joins every cleanup first
// and only then propagates each unasserted failure as the original object; a
// failure is suppressed only after failed() matched its exact raw causes by
// identity and count.
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect } from 'bun:test'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import type { ChatEvent } from '../../../shared/chat'
import type { ChatQueryFactory } from '../../chat/provider/claudeDriverTypes'
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
  /** End the stream as the CLI's own exit would (the scripted query owns no process). */
  exit(): void
  /** The script's prompt reader: ends when the package ends this generation's input. */
  reader: Promise<void>
}

export interface Outcome {
  resolved: boolean
  closed: boolean
  error?: unknown
}

/** The scripted CLI's getContextUsage answer for script `index`'s `call`-th probe (1-based); omitted = no probe control. */
export type ContextProbe = (index: number, call: number) => Promise<unknown>

function scripted(scripts: Script[], probe?: ContextProbe): ChatQueryFactory {
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
      exit: () => {
        script.closed = true
        wake?.()
      },
      push: (message) => {
        queue.push({ uuid: crypto.randomUUID(), session_id: 's-1', ...message } as unknown as SDKMessage)
        wake?.()
      },
    }
    const index = scripts.push(script) - 1
    let probes = 0
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
      ...(probe ? { getContextUsage: () => probe(index, (probes += 1)) } : {}),
    }) as unknown as Query
  }
}

/** One adapter's cleanup: its reserved promise, and whether a test asserted its failure exactly. */
interface Reservation {
  finish(): Promise<Outcome>
  asserted(): boolean
}

/** Adapters created by this file's tests, each with its one reserved cleanup. */
const reserved: Reservation[] = []

/**
 * Join every reserved cleanup (the after-hook), then rethrow what no test
 * asserted: a rejected cleanup body, or a settled() failure failed() did not
 * match. One failure is rethrown as itself; several as an AggregateError of
 * the originals. Nothing is retried or wrapped further.
 */
export async function finishAll(): Promise<void> {
  const entries = reserved.splice(0)
  const joined = await Promise.allSettled(entries.map((entry) => entry.finish()))
  const unasserted: unknown[] = []
  joined.forEach((result, index) => {
    if (result.status === 'rejected') unasserted.push(result.reason)
    else if (!result.value.resolved && !entries[index]!.asserted()) unasserted.push(result.value.error)
  })
  if (unasserted.length === 1) throw unasserted[0]
  if (unasserted.length > 1) throw new AggregateError(unasserted, 'unasserted compatibility-fixture cleanup failures')
}

/** Leaf causes of a settled() rejection: wrappers (AgentRuntimeError with causes, AggregateError) are opened, depth first. */
export function rawCauses(error: unknown): unknown[] {
  if (error instanceof AggregateError) return error.errors.flatMap((cause) => rawCauses(cause))
  if (error instanceof AgentRuntimeError && error.causes.length > 0) return error.causes.flatMap((cause) => rawCauses(cause))
  return [error]
}

export function compatibilityAdapter(extra: Record<string, unknown> = {}, probe?: ContextProbe) {
  const scripts: Script[] = []
  const events: ChatEvent[] = []
  const statuses: string[] = []
  const driver = createChatDriver({
    runtime: 'claude',
    options: {
      sessionId: 'chat-claude-compatibility',
      projectPath: '/tmp',
      queryFactory: scripted(scripts, probe),
      onEvent: (event: ChatEvent) => void events.push(event),
      onStatus: (status: string) => void statuses.push(status),
      ...extra,
    } as never,
  }) as Adapter
  let finishing: Promise<Outcome> | null = null
  let asserted = false
  let bodies = 0
  /** The one cleanup body: kill, settled()'s outcome, then the prompt readers. */
  const body = async (): Promise<Outcome> => {
    bodies += 1
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
  }
  /** Reserve the promise first; the body runs a microtask later, so any reentry joins it. */
  const finish = (): Promise<Outcome> => {
    if (finishing === null) finishing = Promise.resolve().then(body)
    return finishing
  }
  /** Finish, require a failure whose raw causes are exactly `expected` (identity, order, count), and only then mark it asserted. */
  const failed = async (expected: readonly unknown[]): Promise<Outcome> => {
    const outcome = await finish()
    const raw = rawCauses(outcome.error)
    expect([outcome.resolved, raw.length]).toEqual([false, expected.length])
    raw.forEach((cause, index) => expect(cause).toBe(expected[index]))
    asserted = true
    return outcome
  }
  reserved.push({ finish, asserted: () => asserted })
  return { driver, scripts, events, statuses, finish, failed, bodies: () => bodies }
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
