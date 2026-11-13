// One Claude process generation and the provider controls that act on it
// (task 4.1, split from the session core). A generation is one query() on
// one owned process. It records whether its message stream ended and when
// its end was classified. Termination marks every owned process first, then
// cancels each query, then waits for each owned leader's actual exit. A
// shutdown first gives a leader with closed stdin its grace bound. The
// AbortErrors a stop's token excludes are kept per generation as
// projections. The stop's account weighs them against the generation's
// frozen native evidence.
// The task controls and interrupt go through the SDK's runtime methods. Some
// of those are undeclared or take undeclared options in 0.3.289. It also
// builds a generation's query options and classifies a failed start,
// including the CLI's refusal of a resume target (task 4.4, R10).
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProcessExitFact, TaskOutput } from '../contract.js'
import { AgentRuntimeError } from '../errors.js'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { WireRecorder } from '../options.js'
import { createOwnedClaudeSpawn } from '../process/claudeSpawn.js'
import type { ResolvedLaunch } from '../process/launch.js'
import { nativeCauses } from '../process/nativeVerdict.js'
import type { OwnedProcess, TerminateOptions } from '../process/ownedProcess.js'
import { PromptQueue } from './promptQueue.js'

export type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

export interface Generation {
  number: number
  query: Query
  input: PromptQueue<SDKUserMessage>
  owned: OwnedProcess | null
  /**
   * Whether the SDK asked this generation's owned spawner for a process.
   * `pending` after the joins means it never did: the default path always
   * installs the spawner, so no process exists. Under a queryFactory it is
   * the declared native-free test seam.
   */
  spawn: 'pending' | 'refused' | 'created'
  /** Stop-token AbortErrors excluded from the job ledger, accounted after the joins. */
  projections: unknown[]
  /** Its initialize failed: it never owns the conversation, though its process lives until stop. */
  retired: boolean
  /** The query's own cancel: only stop aborts it, with its stop token as the reason. */
  abort: AbortController
  /** The pinned SDK's AbortError: what the query's cancel path mints once `abort` fired. */
  abortError: SdkModule['AbortError']
  /** The message stream ended (the process exited or the transport closed). */
  readEnded: boolean
  /** The conversation this generation was launched to resume, captured before its query; null for a fresh one. */
  resumeTarget: string | null
  /** Its initialize response arrived. */
  initialized: boolean
  /** A resumed generation's first init named its target (G1); later inits may then change the identity. */
  identityConfirmed: boolean
  /** The error texts of result frames read before initialize: the CLI's startup-failure frames. */
  startupErrors: string[]
  /**
   * Whether its interrupts carry `cancelQueued` (interrupt_cancel_queued_v1):
   * true until an init reports a capabilities array, which then replaces it.
   */
  cancelQueued: boolean
  /** Settles once the generation's end has been classified. */
  ended: Promise<void>
  markEnded(): void
}

export function newGeneration(number: number, sdk: SdkModule, resumeTarget: string | null): Generation {
  let markEnded!: () => void
  const ended = new Promise<void>((resolve) => (markEnded = resolve))
  return {
    number, query: null as unknown as Query, input: new PromptQueue<SDKUserMessage>(), owned: null, spawn: 'pending', projections: [], retired: false,
    abort: new AbortController(), abortError: sdk.AbortError, readEnded: false, resumeTarget, initialized: false, identityConfirmed: false, startupErrors: [], cancelQueued: true, ended, markEnded,
  }
}

/**
 * The pinned CLI's refusals of a resume target (2.1.289, headless): written
 * to stderr and in its startup-failure frame before it exits 1, ahead of the
 * stdin loop that answers initialize.
 */
const RESUME_REFUSALS = ['No conversation found with session ID:', '--resume requires a valid session ID', 'Failed to resume session']

/** Whether a generation launched to resume ended before initialize with the CLI's resume refusal. */
function refusedResume(generation: Generation): boolean {
  if (generation.resumeTarget === null) return false
  const texts = [...generation.startupErrors, generation.owned?.stderrTail() ?? '']
  return texts.some((text) => RESUME_REFUSALS.some((refusal) => text.includes(refusal)))
}

/** No turn exists before initialize: a result frame then is the CLI's startup failure, kept for start's classification. */
export function keepStartupFailure(generation: Generation, message: { type: string }): boolean {
  if (generation.initialized || message.type !== 'result') return false
  const errors = (message as { errors?: unknown }).errors
  if (Array.isArray(errors)) generation.startupErrors.push(...errors.filter((e): e is string => typeof e === 'string'))
  return true
}

/**
 * The error start rejects with when the generation's initialize failed. The
 * SDK's rejection is never proof that the stop caused it: it stays a failure
 * the stop reports. A proven no-launch (the spawner refused once stop had
 * begun) and the stop's own cancellation are cancellations; a spawn failure
 * is a dependency failure. A process that exited while starting is
 * classified first (L14: exited, one process end); then a resumed launch the
 * CLI refused fails with `resume` (R10: nothing fresh was started), and
 * anything else with `transport`.
 */
export async function startFailure(generation: Generation, stopToken: object | null, error: unknown, cancelled: (message: string, causes: unknown[]) => AgentRuntimeError): Promise<AgentRuntimeError> {
  generation.retired = true
  const exit = generation.owned?.exited
  if (generation.spawn === 'refused') return cancelled('the driver was stopped before its process was created', [error])
  if (exit?.kind === 'spawn-failed') return new AgentRuntimeError({ category: 'dependency', message: 'the Claude Code executable could not be started' }, [error])
  if (cancelledByStop(generation, stopToken, error)) return cancelled('the driver was stopped while starting', [error])
  if (exit || generation.readEnded) await generation.ended
  if (refusedResume(generation)) return new AgentRuntimeError({ category: 'resume', message: 'the runtime refused the resume target or its transcript is unavailable' }, [error])
  return new AgentRuntimeError({ category: 'transport', message: 'the Claude Code process did not initialize' }, [error])
}

/**
 * A projection of this stop's cancellation: the AbortError the query's
 * cancel path minted after its controller was aborted with this stop's
 * token. It is no proof of what ended the process, so it is stored on the
 * generation for the stop's native account, not dropped. Anything else,
 * whenever it arrives, is a failure the stop reports.
 */
export function cancelledByStop(generation: Generation, stopToken: object | null, error: unknown): boolean {
  if (stopToken === null || generation.abort.signal.reason !== stopToken || !(error instanceof generation.abortError)) return false
  generation.projections.push(error)
  return true
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

/**
 * Interrupt the CLI's turn, cancelling what it queued when the generation
 * supports it (else a plain interrupt); resolves to the cancelled prompt UUIDs.
 */
export async function interruptGeneration(generation: Generation): Promise<string[]> {
  const interrupt = generation.query.interrupt as unknown as InterruptWithOptions
  const ack = await interrupt.call(generation.query, generation.cancelQueued ? { cancelQueued: true } : undefined)
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

/** The generation's controller, aborted too (with the caller's reason) when a caller-supplied controller aborts. */
export function linkedAbort(own: AbortController, caller: AbortController | undefined): AbortController {
  if (caller) {
    const forward = () => {
      if (!own.signal.aborted) own.abort(caller.signal.reason)
    }
    if (caller.signal.aborted) forward()
    else caller.signal.addEventListener('abort', forward, { once: true })
  }
  return own
}

/**
 * Mark every owned process, then (kill only) send SIGKILL to each owner whose
 * exit has not been observed, then cancel every query with the stop's token
 * and end its input, all without an await in between; then terminate each
 * owned process and close each query. Kill sends SIGKILL first because a CLI
 * that traps SIGTERM ends with a normal exit (143), which the strict verdict
 * fails (task-a67abea1 R2, K1). The exited check runs immediately before each
 * send; it is a JS guard on this owner's observed exit, not a kernel-atomic
 * identity proof. Exited and never-started owners are not signalled but are
 * terminated, joined and accounted as before. A send's result proves
 * nothing: the frozen exit evidence decides. Shutdown sends nothing here.
 * Every termination settles and every close is attempted before the stop
 * settles, even when a send throws or a termination rejects (task-f5001d7f
 * A13). Outcomes are judged by status: none failed returns the facts by
 * generation; one failed throws its reason unchanged; several throw one stop
 * error whose causes are every send throw, then every termination rejection,
 * each in supplied order.
 */
export async function terminateGenerations(generations: readonly Generation[], mode: 'kill' | 'shutdown', bounds: TerminateOptions, stopToken: object): Promise<ProcessExitFact[]> {
  for (const generation of generations) generation.owned?.markTermination()
  const sendFailures: unknown[] = []
  if (mode === 'kill') {
    for (const generation of generations) {
      const owned = generation.owned
      if (!owned || owned.pid === null || owned.exited !== null) continue
      try {
        owned.signal('SIGKILL')
      } catch (error) {
        sendFailures.push(error)
      }
    }
  }
  for (const generation of generations) {
    if (!generation.abort.signal.aborted) generation.abort.abort(stopToken)
    generation.input.end()
  }
  if (mode === 'shutdown') {
    // Closed stdin is the graceful request; give each live leader the grace bound to exit.
    const grace = bounds.graceMs ?? 2000
    await Promise.all(generations.map((g) => (g.owned ? exitWithin(g.owned, grace) : undefined)))
  }
  const outcomes = await Promise.allSettled(generations.flatMap((g) => (g.owned ? [g.owned.terminate(bounds)] : [])))
  for (const generation of generations) {
    try {
      generation.query?.close()
    } catch {
      // The transport is already closed.
    }
  }
  const failures = [...sendFailures, ...outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []))]
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AgentRuntimeError({ category: 'stop', message: `${failures.length} owned process terminations failed` }, failures)
  const facts = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<ProcessExitFact>).value)
  return facts.sort((a, b) => a.generation - b.generation)
}

/**
 * One generation's query options over the composed SDK options. Requests
 * ride canUseTool, which bypass mode never consults, so it is unset there.
 * The resume target is the one fixed on the generation. The query's cancel
 * is the stop's; a caller's controller forwards into it with its own reason.
 * The env is ignored by the owned spawner (I3) and passed so the SDK
 * computes nothing from process.env.
 */
export function generationOptions(generation: Generation, composed: Partial<Options>, launch: ResolvedLaunch, executable: string, canUseTool: NonNullable<Options['canUseTool']>, spawn: NonNullable<Options['spawnClaudeCodeProcess']>): Options {
  return {
    settingSources: [],
    includePartialMessages: true,
    ...composed,
    ...(composed.permissionMode === 'bypassPermissions' ? {} : { canUseTool }),
    ...(generation.resumeTarget ? { resume: generation.resumeTarget } : {}),
    abortController: linkedAbort(generation.abort, composed.abortController),
    cwd: launch.cwd,
    pathToClaudeCodeExecutable: executable,
    env: { ...launch.childEnv },
    spawnClaudeCodeProcess: spawn,
  }
}

/**
 * The generation's spawner. Once stop has begun it creates nothing (a
 * proven no-launch). Otherwise the owner is registered on the generation
 * before any recorder publication can reenter stop.
 */
export function ownedSpawn(generation: Generation, launch: ResolvedLaunch, recorder: WireRecorder | undefined, stopBegun: () => boolean): NonNullable<Options['spawnClaudeCodeProcess']> {
  const spawn = createOwnedClaudeSpawn({
    launch,
    generation: generation.number,
    ...(recorder ? { recorder } : {}),
    onSpawn: (owned) => {
      generation.owned = owned
    },
  })
  return (spawnOptions) => {
    if (stopBegun()) {
      generation.spawn = 'refused'
      throw new AgentRuntimeError({ category: 'stopped', message: 'the driver was stopped before its process was created' })
    }
    generation.spawn = 'created'
    return spawn(spawnOptions)
  }
}

/**
 * The stop's closed account, run after every process and job is joined:
 * each generation's native causes, read from its frozen evidence. A
 * generation whose spawner was never called (or refused) had no process,
 * so its projections are its own cancellation. One that spawned yet has no
 * owner is missing evidence, a failure.
 */
export function accountGenerations(generations: readonly Generation[]): unknown[] {
  return generations.flatMap((generation) => {
    if (generation.owned) return nativeCauses(generation.number, generation.owned, generation.projections)
    if (generation.spawn !== 'created') return []
    return [new AgentRuntimeError({ category: 'internal', message: `agent process generation ${generation.number} was spawned without an owner` }, generation.projections)]
  })
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
