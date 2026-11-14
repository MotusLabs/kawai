// The pinned SDK's pending-control cleanup (task-d6bf9929 R2). The SDK's
// context probe, usage pull, interrupt and initialize carry no abort signal:
// they settle only when the Query's cleanup rejects every pending request
// with its cause, or with one plain Error("Query closed before response
// received") when that cleanup had no cause (our Query.close() after stop,
// or a clean EOF). Which cleanup runs first after a stop is scheduling, so a
// stop's own cancellation can reach a control job as that plain Error.
//
// The exception for it is narrow. Trust comes from construction: a query
// built here by the genuine imported SDK module's query() records its
// original control methods. Each control call is one invocation that notes
// whether it used that unchanged binding and which error rejected it. Its
// rejection is the stop's cancellation only when the invocation was trusted,
// the error is that invocation's own rejection, the stop's token is the
// generation's abort reason, the error is exactly the SDK's plain cleanup
// error, the cleanup had not begun when the stop sampled it (before any stop
// side effect) and has begun without a cause by the time it is classified.
// Anything else, a queryFactory's query or a replaced method included, is a
// failure the stop reports. A recognized error is kept by identity in the
// generation's projections, so a failed native exit still reports it. The
// Query's cleanup state is read through a typed read-only adapter over the
// pinned 0.3.289 fields; an unknown state fails closed. This authenticates
// the unmodified pinned SDK only, not vendor code modified to imitate it.
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Generation, SdkModule } from './generations.js'

export type ControlKind = 'context-probe' | 'quota-pull' | 'interrupt' | 'initialize'

const METHODS: Readonly<Record<ControlKind, string>> = {
  'context-probe': 'getContextUsage',
  'quota-pull': 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET',
  interrupt: 'interrupt',
  initialize: 'initializationResult',
}

/** The text of the pinned SDK's cause-less cleanup rejection (sdk.mjs `Px`). */
export const CLEANUP_TEXT = 'Query closed before response received'

/** The SDK module namespaces this module imported itself. */
const genuineModules = new WeakSet<object>()
/** Queries the genuine SDK constructed, with their control methods as constructed. */
const genuineQueries = new WeakMap<object, ReadonlyMap<ControlKind, unknown>>()

/** Import the SDK and remember its namespace as genuine (loadSdk's import). */
export async function importGenuineSdk(): Promise<SdkModule> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  genuineModules.add(sdk)
  return sdk
}

/** Build a query with the SDK's own query(); only a genuine namespace's query records its control methods. */
export function genuineQuery(sdk: SdkModule, params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query {
  const query = sdk.query(params)
  if (genuineModules.has(sdk)) {
    const methods = new Map<ControlKind, unknown>()
    for (const kind of Object.keys(METHODS) as ControlKind[]) methods.set(kind, (query as unknown as Record<string, unknown>)[METHODS[kind]])
    genuineQueries.set(query, methods)
  }
  return query
}

/** The pinned Query's private cleanup fields, or null when they are unknown. */
function cleanupState(query: unknown): { performed: boolean; cause: unknown } | null {
  try {
    if (query === null || typeof query !== 'object' || !genuineQueries.has(query)) return null
    if (!Object.hasOwn(query, 'cleanupPerformed') || !Object.hasOwn(query, 'cleanupCause')) return null
    const { cleanupPerformed, cleanupCause } = query as { cleanupPerformed: unknown; cleanupCause: unknown }
    return typeof cleanupPerformed === 'boolean' ? { performed: cleanupPerformed, cause: cleanupCause } : null
  } catch {
    return null
  }
}

/**
 * Sample each generation's cleanup state once, synchronously, before the
 * stop's first side effect. A generation sampled earlier keeps its sample;
 * one without a known state stays unknown, never false.
 */
export function sampleCleanupAtStop(generations: readonly Generation[]): void {
  for (const generation of generations) {
    if (generation.cleanupAtStop !== 'unsampled') continue
    const state = cleanupState(generation.query)
    generation.cleanupAtStop = state ? state.performed : 'unknown'
  }
}

/** Exactly the SDK's plain cleanup error: no subclass, cause, renamed name or telemetry tags. */
function isCleanupError(error: unknown): error is Error {
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) return false
  if (error.name !== 'Error' || error.message !== CLEANUP_TEXT) return false
  return !['cause', 'name', 'telemetryMessage', 'errorClass', 'errorCode'].some((key) => Object.hasOwn(error, key))
}

/** One call of one control method on a generation's query. */
export class ControlInvocation {
  private trusted = false
  private binding: object | null = null
  private rejection: { error: unknown } | null = null

  constructor(
    private readonly generation: Generation,
    private readonly kind: ControlKind,
  ) {}

  /** The control method on the generation's query now, or undefined. */
  method(): unknown {
    const query = this.generation.query as unknown as Record<string, unknown> | null
    return query ? query[METHODS[this.kind]] : undefined
  }

  /** Call the method once; note whether it is the genuine construction's binding, and its rejection. */
  async call<T>(...args: unknown[]): Promise<T> {
    const query = this.generation.query as unknown as object
    const method = this.method() as (...a: unknown[]) => Promise<T>
    const recorded = genuineQueries.get(query)
    this.trusted = recorded !== undefined && recorded.get(this.kind) === method
    this.binding = query
    try {
      return await method.apply(query, args)
    } catch (error) {
      this.rejection = { error }
      throw error
    }
  }

  /**
   * Whether `error`, this invocation's own rejection, is the stop's
   * cancellation by the SDK's cause-less cleanup; a match is kept in the
   * generation's projections (once per call).
   */
  cancelledByCleanup(stopToken: object | null, error: unknown): boolean {
    const generation = this.generation
    if (!this.trusted || this.rejection === null || this.rejection.error !== error) return false
    if (stopToken === null || generation.abort.signal.reason !== stopToken) return false
    if ((generation.query as unknown) !== this.binding || !isCleanupError(error)) return false
    if (generation.cleanupAtStop !== false) return false
    const state = cleanupState(this.binding)
    if (!state || !state.performed || state.cause !== undefined) return false
    generation.projections.push(error)
    return true
  }
}
