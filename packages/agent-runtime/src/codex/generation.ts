// One Codex app-server generation (task 4.2): its transport, the thread it
// opened, and the helpers the session uses to boot, classify, stop and
// account it.
//
// - Boot. initialize, then thread/start (the composed policy, cwd, model,
//   prompt append and dynamic tools) or thread/resume (the saved thread id
//   with the same policy, excludeTurns). Neither sends a prompt.
// - Classification. A start failure takes the most specific category:
//   configuration and dependency pass through; an unauthorized reply is
//   authentication; a refused resume is resume; anything else is transport
//   (L01). The raw failure is nested by identity.
// - Stop. Each generation's transport stop is memoized and called outside its
//   handler jobs. Accounting reads the native evidence each owned process
//   froze at exit (a pre-stop, nonzero or unsent-signal end fails the stop),
//   beside the transport's own stop failures, which it already joins.
import type { ProcessExitFact } from '../contract.js'
import { AgentRuntimeError, type AgentErrorCategory } from '../errors.js'
import type { JsonObject } from '../json.js'
import { nativeCauses } from '../process/nativeVerdict.js'
import { AppServerRpcError, type AppServerTransport } from './appServerTransport.js'
import { codexErrorCategory, rpcErrorInfo } from './auth.js'

export interface CodexGeneration {
  readonly number: number
  readonly transport: AppServerTransport
  /** Resume target fixed before the process exists; null for a fresh thread. */
  readonly resumeTarget: string | null
  threadId: string | null
  /** Superseded or failed: its notifications and requests reach nothing. */
  retired: boolean
  stopping: Promise<ProcessExitFact> | null
  /** Resolves once the generation ended (exit, retirement or stop): native-id waits end with it. */
  readonly ended: Promise<null>
  end(): void
}

export function newGeneration(number: number, transport: AppServerTransport, resumeTarget: string | null): CodexGeneration {
  let end!: () => void
  const ended = new Promise<null>((resolve) => (end = () => resolve(null)))
  return { number, transport, resumeTarget, threadId: null, retired: false, stopping: null, ended, end }
}

export const CLIENT_INFO = { name: 'agent-runtime', title: '@motuslabs/agent-runtime', version: '0.1.0' }
export const CAPABILITIES: JsonObject = { experimentalApi: true, requestAttestation: false }

export interface ThreadOpened {
  threadId: string
  path: string | null
  model: string | null
}

/** Read thread/start or thread/resume's reply: the thread id, its transcript path and the model. */
export function threadOpened(result: unknown): ThreadOpened | null {
  const reply = result as { thread?: { id?: unknown; path?: unknown; model?: unknown }; model?: unknown } | null
  const thread = reply?.thread
  if (!thread || typeof thread.id !== 'string' || thread.id === '') return null
  const model = typeof reply?.model === 'string' ? reply.model : typeof thread.model === 'string' ? thread.model : null
  return { threadId: thread.id, path: typeof thread.path === 'string' && thread.path ? thread.path : null, model }
}

/** The start failure of one boot step, most specific category first (L01). */
export function startFailure(step: 'initialize' | 'thread/start' | 'thread/resume', error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError && (error.category === 'configuration' || error.category === 'dependency')) return error
  let category: AgentErrorCategory = 'transport'
  if (error instanceof AppServerRpcError && !error.uncorrelated) {
    const auth = codexErrorCategory(rpcErrorInfo(error.error), 'transport')
    category = auth === 'authentication' ? 'authentication' : step === 'thread/resume' ? 'resume' : 'transport'
  }
  const what = step === 'thread/resume' ? 'resume the saved thread' : step === 'thread/start' ? 'start a thread' : 'initialize the app-server'
  return new AgentRuntimeError({ category, message: `Codex could not ${what}${error instanceof Error ? `: ${error.message}` : ''}` }, [error])
}

/** Retire a generation and begin its transport's shared stop, outside its handler jobs; once. */
export function stopGeneration(generation: CodexGeneration): { stopping: Promise<ProcessExitFact>; first: boolean } {
  generation.retired = true
  generation.end()
  if (generation.stopping) return { stopping: generation.stopping, first: false }
  generation.stopping = generation.transport.outside(() => generation.transport.stop())
  return { stopping: generation.stopping, first: true }
}

/** Native evidence of every generation, after the joins (observer failures come from the transport's stop). */
export function accountGenerations(generations: readonly CodexGeneration[]): unknown[] {
  return generations.flatMap((generation) => {
    const owned = generation.transport.process
    if (!owned) return []
    const observed = new Set(owned.observerFailures)
    return nativeCauses(generation.number, owned, []).filter((cause) => !observed.has(cause))
  })
}
