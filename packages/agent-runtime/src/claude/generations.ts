// One Claude process generation and the provider controls that act on it
// (task 4.1, split from the session core). A generation is one query() on
// one owned process. It records whether its message stream ended and when
// its end was classified. Termination waits for each owned leader's actual
// exit. A shutdown first gives a leader with closed stdin its grace bound.
// The task controls and interrupt go through the SDK's runtime methods. Some
// of those are undeclared or take undeclared options in 0.3.289.
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProcessExitFact, TaskOutput } from '../contract.js'
import { AgentRuntimeError } from '../errors.js'
import type { OwnedProcess, TerminateOptions } from '../process/ownedProcess.js'
import { PromptQueue } from './promptQueue.js'

export type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

export interface Generation {
  number: number
  query: Query
  input: PromptQueue<SDKUserMessage>
  owned: OwnedProcess | null
  /** Set by stop before it closes the input: read failures after this are the stop's own. */
  stopRequested: boolean
  /** The message stream ended (the process exited or the transport closed). */
  readEnded: boolean
  /** Settles once the generation's end has been classified. */
  ended: Promise<void>
  markEnded(): void
}

export function newGeneration(number: number): Generation {
  let markEnded!: () => void
  const ended = new Promise<void>((resolve) => (markEnded = resolve))
  return { number, query: null as unknown as Query, input: new PromptQueue<SDKUserMessage>(), owned: null, stopRequested: false, readEnded: false, ended, markEnded }
}

export async function loadSdk(): Promise<SdkModule> {
  try {
    return await import('@anthropic-ai/claude-agent-sdk')
  } catch (error) {
    throw new AgentRuntimeError({ category: 'dependency', message: 'the optional peer @anthropic-ai/claude-agent-sdk is not installed' }, [error])
  }
}

/** The SDK's runtime interrupt takes `{ cancelQueued }` (SDK 0.3.289); its d.ts declares no parameter. */
type InterruptWithOptions = (options?: { cancelQueued?: boolean }) => Promise<{ cancelled?: string[] } | undefined>

/** Interrupt the CLI's turn and cancel what it queued; resolves to the cancelled prompt UUIDs. */
export async function interruptGeneration(generation: Generation): Promise<string[]> {
  const interrupt = generation.query.interrupt as unknown as InterruptWithOptions
  const ack = await interrupt.call(generation.query, { cancelQueued: true })
  return Array.isArray(ack?.cancelled) ? ack.cancelled : []
}

type TaskOutputQuery = { getTaskOutput?: (id: string) => Promise<{ output: string; total_bytes: number; truncated: boolean }> }

/** The CLI's get_task_output control (undeclared in sdk.d.ts); null when absent or refused. */
export async function readTaskOutput(query: Query, taskId: string): Promise<TaskOutput | null> {
  const read = (query as TaskOutputQuery).getTaskOutput
  if (typeof read !== 'function') return null
  try {
    const out = await read.call(query, taskId)
    return { output: out.output, totalBytes: out.total_bytes, truncated: out.truncated }
  } catch {
    return null
  }
}

export async function stopQueryTask(query: Query, taskId: string): Promise<boolean> {
  try {
    await query.stopTask(taskId)
    return true
  } catch {
    return false
  }
}

/** End every generation's input, then terminate each owned process and close each query. */
export async function terminateGenerations(generations: readonly Generation[], mode: 'kill' | 'shutdown', bounds: TerminateOptions): Promise<ProcessExitFact[]> {
  for (const generation of generations) {
    generation.stopRequested = true
    generation.input.end()
  }
  if (mode === 'shutdown') {
    // Closed stdin is the graceful request; give each live leader the grace bound to exit.
    const grace = bounds.graceMs ?? 2000
    await Promise.all(generations.map((g) => (g.owned ? exitWithin(g.owned, grace) : undefined)))
  }
  const facts = await Promise.all(generations.flatMap((g) => (g.owned ? [g.owned.terminate(bounds)] : [])))
  for (const generation of generations) {
    try {
      generation.query.close()
    } catch {
      // The transport is already closed.
    }
  }
  return facts.sort((a, b) => a.generation - b.generation)
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
