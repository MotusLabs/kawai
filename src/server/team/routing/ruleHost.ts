// Server side of one routing rule file (profile-routing design D1/D2). The
// rule's declared `env` must be known before it runs with any variables, so
// loading takes two Workers: a bootstrap Worker with an empty environment
// imports the module and reports `env`, then the serving Worker starts with
// exactly those variables (taken from the server environment) and imports
// the module again. Calls are structured-clone messages with a timeout
// (rule `timeoutMs`, default 3 s, at most 10 s); after repeated timeouts the
// serving Worker is terminated and started afresh, since a rule stuck in a
// synchronous loop would otherwise never answer again.
import { pathToFileURL } from 'node:url'
import type {
  LimitOutcome, LimitOutcomeContext, RouteContext, RouteDecision,
} from '../../../shared/routing'

export const DEFAULT_RULE_TIMEOUT_MS = 3_000
export const MAX_RULE_TIMEOUT_MS = 10_000
/** A module that does not finish importing within this is a load failure. */
export const RULE_LOAD_TIMEOUT_MS = 10_000
/** Consecutive call timeouts before the serving Worker is restarted. */
export const RESTART_AFTER_TIMEOUTS = 3

const WORKER_URL = new URL('./ruleWorker.ts', import.meta.url).href

type Outbound =
  | { type: 'loaded'; env: string[]; timeoutMs: number | null; hasOnLimit: boolean }
  | { type: 'load-error'; error: string }
  | { type: 'result'; id: number; ok: boolean; value?: unknown; error?: string }

interface Loaded {
  env: string[]
  timeoutMs: number | null
  hasOnLimit: boolean
}

export class RuleTimeoutError extends Error {}

export class RuleHost {
  private worker: Worker | null = null
  private loaded: Loaded | null = null
  private nextId = 0
  private timeouts = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(
    readonly file: string,
    private readonly serverEnv: Record<string, string | undefined>,
    /** Distinguishes reloads, so each import reads the file afresh. */
    private readonly version: string = String(Date.now())
  ) {}

  get timeoutMs(): number {
    return Math.min(MAX_RULE_TIMEOUT_MS, this.loaded?.timeoutMs ?? DEFAULT_RULE_TIMEOUT_MS)
  }

  get hasOnLimit(): boolean {
    return this.loaded?.hasOnLimit ?? false
  }

  /** The variables the rule declared, as passed to its Worker. */
  get declaredEnv(): string[] {
    return this.loaded?.env ?? []
  }

  /** Bootstrap with an empty env, then start the serving Worker. Throws the load error. */
  async load(): Promise<void> {
    const bootstrap = new Worker(WORKER_URL, { env: {} } as WorkerOptions)
    try {
      const declared = await this.importIn(bootstrap)
      this.loaded = declared
    } finally {
      bootstrap.terminate()
    }
    await this.startServing()
  }

  async route(ctx: RouteContext): Promise<RouteDecision> {
    return validateDecision(await this.call('route', ctx))
  }

  async onLimit(ctx: LimitOutcomeContext): Promise<LimitOutcome> {
    return validateOutcome(await this.call('onLimit', ctx))
  }

  close(): void {
    this.worker?.terminate()
    this.worker = null
    for (const { reject } of this.pending.values()) reject(new Error('rule closed'))
    this.pending.clear()
  }

  private async startServing(): Promise<void> {
    this.worker?.terminate()
    const env: Record<string, string> = {}
    for (const key of this.loaded?.env ?? []) {
      const value = this.serverEnv[key]
      if (value !== undefined) env[key] = value
    }
    const worker = new Worker(WORKER_URL, { env } as WorkerOptions)
    try {
      await this.importIn(worker)
    } catch (error) {
      worker.terminate()
      throw error
    }
    worker.onmessage = (event: MessageEvent<Outbound>) => {
      const data = event.data
      if (data.type !== 'result') return
      const waiter = this.pending.get(data.id)
      if (!waiter) return
      this.pending.delete(data.id)
      if (data.ok) waiter.resolve(data.value)
      else waiter.reject(new Error(data.error ?? 'rule failed'))
    }
    worker.onerror = (event) => {
      for (const { reject } of this.pending.values()) reject(new Error(event.message || 'rule worker error'))
      this.pending.clear()
    }
    this.worker = worker
    this.timeouts = 0
  }

  /** Import the rule inside `worker`; resolves with what it declared. */
  private importIn(worker: Worker): Promise<Loaded> {
    const url = `${pathToFileURL(this.file).href}?v=${encodeURIComponent(this.version)}`
    return new Promise<Loaded>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`loading took longer than ${RULE_LOAD_TIMEOUT_MS / 1000}s`)), RULE_LOAD_TIMEOUT_MS)
      worker.onmessage = (event: MessageEvent<Outbound>) => {
        const data = event.data
        if (data.type === 'loaded') {
          clearTimeout(timer)
          resolve({ env: data.env, timeoutMs: data.timeoutMs, hasOnLimit: data.hasOnLimit })
        } else if (data.type === 'load-error') {
          clearTimeout(timer)
          reject(new Error(data.error))
        }
      }
      worker.onerror = (event) => {
        clearTimeout(timer)
        reject(new Error(event.message || 'rule failed to load'))
      }
      worker.postMessage({ type: 'load', url })
    })
  }

  private call(method: 'route' | 'onLimit', payload: unknown): Promise<unknown> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('rule is not loaded'))
    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RuleTimeoutError(`${method} did not return within ${this.timeoutMs} ms`))
        if (++this.timeouts >= RESTART_AFTER_TIMEOUTS) {
          void this.startServing().catch(() => { this.worker = null })
        }
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); this.timeouts = 0; resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      worker.postMessage({ type: 'call', id, method, payload })
    })
  }
}

function validateDecision(value: unknown): RouteDecision {
  const decision = value as RouteDecision | null
  if (decision?.type === 'default') return { type: 'default' }
  if (decision?.type === 'pick' && typeof decision.candidateId === 'string') {
    return { type: 'pick', candidateId: decision.candidateId }
  }
  if (decision?.type === 'hold' && typeof decision.reason === 'string') {
    const retry = decision.retryAfterMs
    if (retry !== undefined && !(typeof retry === 'number' && Number.isFinite(retry) && retry >= 0)) {
      throw new Error('retryAfterMs must be a finite non-negative number')
    }
    return {
      type: 'hold', reason: decision.reason,
      ...(retry !== undefined ? { retryAfterMs: retry } : {}),
    }
  }
  throw new Error(`route returned an invalid decision: ${JSON.stringify(value)}`)
}

function validateOutcome(value: unknown): LimitOutcome {
  const outcome = value as LimitOutcome | null
  if (outcome?.type === 'park' || outcome?.type === 'release' || outcome?.type === 'default') return { type: outcome.type }
  if (outcome?.type === 'forward') {
    const to = outcome.to
    if (to === undefined) return { type: 'forward' }
    if ((to.kind === 'group' || to.kind === 'session') && typeof to.id === 'string') {
      return { type: 'forward', to: { kind: to.kind, id: to.id } }
    }
  }
  throw new Error(`onLimit returned an invalid outcome: ${JSON.stringify(value)}`)
}
