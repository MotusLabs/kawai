// The first real Claude driver path (tasks 2.2/2.4): the pinned SDK's
// query() running on the owned spawner, through the shared lifecycle core.
// Every generation's message loop is an owned job that completes only at the
// leader's actual exit; start resolves on the CLI's initialize response;
// stop closes the input, terminates every owned generation and joins every
// owned job before its receipt. Profiles, permissions, tools, requests,
// resume and the full event set arrive in tasks 3-5; this module is the
// composition they extend, not the final public driver.

import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { InterruptReceipt, ProcessExitFact, ProcessExitReceipt, SubmitOptions, TurnHandle, TurnOutcome, TurnResult } from '../contract.js'
import { AgentRuntimeError, type AgentErrorInfo } from '../errors.js'
import { EventStream } from '../eventStream.js'
import type { AgentCallbacks, LaunchInput, WireRecorder } from '../options.js'
import { DriverLifecycle } from '../lifecycle/lifecycle.js'
import { createOwnedClaudeSpawn } from '../process/claudeSpawn.js'
import { resolveExecutable, resolveLaunch } from '../process/launch.js'
import type { LeaderExit, OwnedProcess, TerminateOptions } from '../process/ownedProcess.js'
import { PromptQueue } from './promptQueue.js'

export interface ClaudeSessionOptions {
  launch: LaunchInput
  callbacks: AgentCallbacks
  wire?: WireRecorder
  /** SDK options supplied by the profile and permission layers (tasks 3.x). */
  sdkOptions?: Partial<Options>
  /** Termination bounds for stop (defaults: the owned spawner's). */
  terminate?: TerminateOptions
}

interface Turn {
  turnId: string
  messageUuid: string
  text: string
  settled: boolean
  finalText: string | null
  model: string | null
  resolve(result: TurnResult): void
  result: Promise<TurnResult>
}

interface Generation {
  number: number
  query: Query
  input: PromptQueue<SDKUserMessage>
  owned: OwnedProcess | null
  /** Set by stop before it closes the input: read failures after this are the stop's own. */
  stopRequested: boolean
}

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

async function loadSdk(): Promise<SdkModule> {
  try {
    return await import('@anthropic-ai/claude-agent-sdk')
  } catch (error) {
    throw new AgentRuntimeError({ category: 'dependency', message: 'the optional peer @anthropic-ai/claude-agent-sdk is not installed' }, [error])
  }
}

export class ClaudeSession {
  readonly lifecycle: DriverLifecycle
  private readonly events: EventStream
  private readonly generations: Generation[] = []
  /** Open turns in FIFO order: the active turn first, then queued ones (L21). */
  private open: Turn[] = []
  private readonly byUuid = new Map<string, Turn>()

  constructor(private readonly options: ClaudeSessionOptions) {
    this.events = new EventStream((event) => options.callbacks.onEvent(event))
    this.lifecycle = new DriverLifecycle({
      continuations: new Set(['queue']),
      ...(options.callbacks.onState ? { onState: options.callbacks.onState } : {}),
    })
  }

  get state() {
    return this.lifecycle.state
  }

  start(): Promise<void> {
    return this.lifecycle.start((generation) => this.spawnGeneration(generation))
  }

  private current(): Generation | null {
    return this.generations.at(-1) ?? null
  }

  private async spawnGeneration(number: number): Promise<void> {
    const launch = resolveLaunch(this.options.launch)
    const executable = launch.executablePath ?? resolveExecutable(launch, 'claude')
    const { query } = await loadSdk()
    const input = new PromptQueue<SDKUserMessage>()
    const generation: Generation = { number, query: null as unknown as Query, input, owned: null, stopRequested: false }
    generation.query = query({
      prompt: input,
      options: {
        settingSources: [],
        ...this.options.sdkOptions,
        cwd: launch.cwd,
        pathToClaudeCodeExecutable: executable,
        // Ignored by the owned spawner (I3); passed so the SDK computes nothing from process.env.
        env: { ...launch.childEnv },
        spawnClaudeCodeProcess: createOwnedClaudeSpawn({
          launch,
          generation: number,
          ...(this.options.wire ? { recorder: this.options.wire } : {}),
          onSpawn: (owned) => {
            generation.owned = owned
          },
        }),
      },
    })
    this.generations.push(generation)
    void this.lifecycle.jobs.run(`generation:${number}`, () => this.consume(generation))
    try {
      await generation.query.initializationResult()
    } catch (error) {
      // The generation's own job reports the exit; start reports why it failed.
      const exit = generation.owned?.exited
      if (exit?.kind === 'spawn-failed') throw new AgentRuntimeError({ category: 'dependency', message: 'the Claude Code executable could not be started' }, [error])
      throw new AgentRuntimeError({ category: 'transport', message: 'the Claude Code process did not initialize' }, [error])
    }
  }

  /** The generation's owned job: read every message, then wait for the ACTUAL exit. */
  private async consume(generation: Generation): Promise<void> {
    let failure: unknown = null
    try {
      for await (const message of generation.query) this.handle(generation, message)
    } catch (error) {
      failure = error
    }
    const exit = generation.owned ? await generation.owned.leaderExit : null
    this.generationEnded(generation, exit)
    // A read failure caused by our own stop, or already reported as the unexpected exit, is not a stop failure.
    if (failure !== null && !generation.stopRequested && this.lifecycle.state !== 'exited') throw failure
  }

  private generationEnded(generation: Generation, exit: LeaderExit | null): void {
    if (this.lifecycle.processExit(generation.number) !== 'unexpected') return
    const code = exit?.kind === 'exited' ? exit.code : null
    const signal = exit?.kind === 'exited' ? exit.signal : null
    const error: AgentErrorInfo = { category: 'transport', message: 'the agent process exited unexpectedly' }
    this.events.emit({ type: 'error', error })
    for (const turn of this.takeOpen()) this.settle(turn, 'process-ended', error, 'process_ended')
    this.options.callbacks.onProcessEnd?.({ generation: generation.number, code, signal, reason: exit?.kind === 'spawn-failed' ? 'spawn failed' : null })
  }

  private handle(generation: Generation, message: SDKMessage): void {
    if (generation !== this.current()) return
    if (message.type === 'assistant') {
      const turn = this.open[0]
      if (!turn) return
      const text = message.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (text) turn.finalText = text
      turn.model = message.message.model ?? turn.model
      return
    }
    if (message.type === 'result') {
      const uuid = (message as { user_message_uuid?: string }).user_message_uuid
      const turn = uuid ? this.byUuid.get(uuid) : this.open[0]
      if (!turn || turn.settled || turn !== this.open[0]) return
      if (!this.lifecycle.result(turn.turnId)) return
      this.open.shift()
      const failed = message.subtype !== 'success' || message.is_error
      const error: AgentErrorInfo | null = failed ? { category: 'provider', message: `the turn ended with ${message.subtype}` } : null
      this.settle(turn, failed ? 'failed' : 'success', error, message.subtype)
      const next = this.open[0]
      if (next) this.openTurn(next)
    }
  }

  async send(text: string, submit: SubmitOptions = {}): Promise<TurnHandle> {
    const admission = await this.lifecycle.admitSend(submit.continuation)
    const messageUuid = submit.messageUuid ?? crypto.randomUUID()
    let resolve!: (result: TurnResult) => void
    const result = new Promise<TurnResult>((r) => {
      resolve = r
    })
    const turn: Turn = { turnId: crypto.randomUUID(), messageUuid, text, settled: false, finalText: null, model: null, resolve, result }
    const generation = this.current()!
    const pushed = generation.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: messageUuid,
      session_id: '',
    } as SDKUserMessage)
    if (!pushed) throw new AgentRuntimeError({ category: 'stopped', message: 'the driver is stopped' })
    this.open.push(turn)
    this.byUuid.set(messageUuid, turn)
    if (admission === 'new-turn') this.openTurn(turn)
    return { turnId: turn.turnId, messageUuid, result }
  }

  private openTurn(turn: Turn): void {
    this.lifecycle.beginTurn(turn.turnId)
    this.events.emit({ type: 'turn_started', turnId: turn.turnId })
    this.events.emit({ type: 'user_message', turnId: turn.turnId, text: turn.text, messageUuid: turn.messageUuid })
  }

  private takeOpen(): Turn[] {
    const open = this.open
    this.open = []
    return open
  }

  private settle(turn: Turn, outcome: TurnOutcome, error: AgentErrorInfo | null, subtype: string): void {
    if (turn.settled) return
    turn.settled = true
    const result: TurnResult = {
      turnId: turn.turnId,
      messageUuid: turn.messageUuid,
      outcome,
      finalText: outcome === 'success' ? turn.finalText : null,
      model: turn.model,
      usage: null,
      toolCallCount: 0,
      compactionCount: 0,
      error,
    }
    if (outcome === 'interrupted') this.events.emit({ type: 'turn_interrupted', turnId: turn.turnId })
    else {
      this.events.emit({
        type: 'turn_completed', turnId: turn.turnId, subtype, isError: outcome !== 'success', usage: null,
        finalText: result.finalText, totalCostUsd: null, providerCostUsd: null, numTurns: null, terminalReason: null,
      })
    }
    this.options.callbacks.onTurnResult?.(result)
    turn.resolve(result)
  }

  /** L09/L10: settle the active and queued turns at once, then ask the CLI to stop the turn. */
  async interrupt(): Promise<InterruptReceipt> {
    const receipt = this.lifecycle.interrupt()
    const error: AgentErrorInfo = { category: 'stopped', message: 'the turn was interrupted' }
    const [active, ...queued] = this.takeOpen()
    if (active) this.settle(active, 'interrupted', error, 'interrupted')
    for (const turn of queued) {
      // Queued turns never started: they settle without a second turn_interrupted.
      turn.settled = true
      const result: TurnResult = { turnId: turn.turnId, messageUuid: turn.messageUuid, outcome: 'interrupted', finalText: null, model: null, usage: null, toolCallCount: 0, compactionCount: 0, error }
      this.options.callbacks.onTurnResult?.(result)
      turn.resolve(result)
    }
    const generation = this.current()
    if (generation && active) {
      const query = generation.query as Query & { interrupt(options?: { cancelQueued?: boolean }): Promise<unknown> }
      void this.lifecycle.jobs.run(`interrupt:${generation.number}`, () => query.interrupt({ cancelQueued: true }), { expectedCancellation: () => true })
    }
    return receipt
  }

  kill(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('kill', () => this.teardown('kill'))
  }

  shutdown(): Promise<ProcessExitReceipt> {
    return this.lifecycle.stop('shutdown', () => this.teardown('shutdown'))
  }

  /** Close every input, settle open turns as stopped (L11), terminate every owned generation. */
  private async teardown(mode: 'kill' | 'shutdown'): Promise<ProcessExitFact[]> {
    const error: AgentErrorInfo = { category: 'stopped', message: 'the driver was stopped' }
    for (const turn of this.takeOpen()) this.settle(turn, 'interrupted', error, 'interrupted')
    for (const generation of this.generations) {
      generation.stopRequested = true
      generation.input.end()
    }
    const bounds = this.options.terminate ?? {}
    if (mode === 'shutdown') {
      // Closed stdin is the graceful request; give each live leader the grace bound to exit.
      const grace = bounds.graceMs ?? 2000
      await Promise.all(this.generations.map((g) => (g.owned ? exitWithin(g.owned, grace) : undefined)))
    }
    const facts = await Promise.all(
      this.generations.flatMap((g) => (g.owned ? [g.owned.terminate(bounds)] : [])),
    )
    for (const generation of this.generations) {
      try {
        generation.query.close()
      } catch {
        // The transport is already closed.
      }
    }
    return facts.sort((a, b) => a.generation - b.generation)
  }
}

/** Wait up to `ms` for the leader's exit; the timer never outlives it. */
async function exitWithin(owned: OwnedProcess, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([owned.leaderExit, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  } finally {
    clearTimeout(timer)
  }
}
