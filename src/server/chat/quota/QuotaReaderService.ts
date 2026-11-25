// The one quota reader service (process-quota-history-and-incident-advice
// D1/D2, Table S). Two kinds of reason keep an account polled:
//
// - a started, non-archived session on the provider (today's behavior,
//   kept exactly: one fixed-interval timer per provider, a tick that finds no
//   live session stops it — binding B6), and
// - a configured team worker whose profile resolves to a standalone quota
//   reader. Worker reasons are reference-counted per account key (the teams
//   holding it). A new key polls at once (B1), then on the cadence ±10%
//   jitter, backing off 1, 2, 4 … 30 minutes after consecutive failures (B2).
//
// Every request — spawn pull, session tick, worker tick — goes through
// `request`, which allows one request in flight per account key (P1) and
// joins a caller to the running one. A standalone read is bounded at 10 s by
// the service itself (S4); a late answer is dropped. Shutdown clears every
// timer, and a settlement after it publishes and records nothing (S11, B4).
// A worker on a profile with no standalone reader (agent-only, or OpenRouter:
// X2) gets one `unsupported` settlement per configuration and no timer (S9).
// The service never starts an agent, makes a model request, or touches a
// login (I1): its only effect on the world is `options.read`.
import type { OpenRouterUsagePull } from '../openRouterUsage'
import type { ZaiUsagePull } from '../zaiUsage'
import { accountKeyOf, readerKindOf, type QuotaTarget } from './quotaTarget'

export type QuotaPull = ZaiUsagePull | OpenRouterUsagePull
export type QuotaOutcome = 'supported' | 'unavailable' | 'auth-refused' | 'failed' | 'unsupported'
export type QuotaReason = 'session' | 'worker' | 'both'

export const QUOTA_TIMEOUT_MS = 10_000
export const QUOTA_JITTER = 0.1
export const QUOTA_BACKOFF_MAX_MS = 30 * 60_000

/** A pull's recorded outcome; `null` is a request the service abandoned (timeout). */
export function quotaOutcomeOf(pull: QuotaPull | null): QuotaOutcome {
  if (!pull) return 'failed'
  if (pull.ok) return pull.report.windows.length > 0 ? 'supported' : 'unavailable'
  if (pull.outcome === 'provider-refused' || pull.outcome === 'refused') return 'auth-refused'
  if (pull.outcome === 'not-provider') return 'unsupported'
  return 'failed'
}

/** The backoff after `failures` consecutive failures: 1, 2, 4 … minutes, at most 30 (B2). */
export function quotaBackoffMs(failures: number): number {
  return Math.min(2 ** Math.max(0, failures - 1) * 60_000, QUOTA_BACKOFF_MAX_MS)
}

export interface QuotaSettlement {
  target: QuotaTarget
  reason: QuotaReason
  /** Teams whose history receives the observation (worker teams plus live sessions' teams). */
  teams: string[]
  outcome: QuotaOutcome
  /** The parsed pull; null for an abandoned request or an `unsupported` reader. */
  pull: QuotaPull | null
  startedAt: number
  settledAt: number
}

export interface QuotaReaderOptions {
  /** The one network effect: the manager's quota pull for a target. */
  read: (target: QuotaTarget) => Promise<QuotaPull>
  cadenceMs: number
  timeoutMs?: number
  now?: () => number
  /** Jitter source in [0, 1). */
  random?: () => number
  /** A live session's target for the provider; undefined when none is live, null when it has no base URL. */
  sessionTarget: (providerId: string) => QuotaTarget | null | undefined
  /**
   * Teams of the provider's live sessions. Asked only for a key a live session
   * holds: a session's own request, or the session cadence when its target
   * resolves to the key (`sessionServes`).
   */
  sessionTeams: (target: QuotaTarget) => string[]
  /** Publish a session-cadence pull (today's refresh semantics). */
  onSessionPull: (providerId: string, target: QuotaTarget, pull: QuotaPull) => void
  /** Every settled request and every `unsupported` worker configuration, before any caller sees it. */
  onSettled: (settlement: QuotaSettlement) => void
}

interface WorkerEntry {
  key: string
  target: QuotaTarget
  teams: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  failures: number
  /** The endpoint answered "not a quota endpoint": no polling until the configuration changes. */
  disabled: boolean
}

/** The reason a request started under, widened when a session joins it. */
interface Started {
  reason: QuotaReason
  teams: string[]
  sessionJoined: boolean
}

export interface WorkerSubscription {
  teamId: string
  target: QuotaTarget
}

export class QuotaReaderService {
  private readonly workers = new Map<string, WorkerEntry>()
  private readonly sessions = new Map<string, ReturnType<typeof setInterval>>()
  private readonly inFlight = new Map<string, { token: number; promise: Promise<QuotaPull | null>; started: Started }>()
  /** `teamId\0key` of each unsupported worker configuration already reported. */
  private readonly unsupported = new Set<string>()
  private sequence = 0
  private stopped = false

  constructor(private readonly options: QuotaReaderOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Whether a request for the account key is outstanding. */
  inFlightFor(target: QuotaTarget): boolean {
    return this.inFlight.has(accountKeyOf(target))
  }

  /** Account keys with a worker reason (tests and diagnostics). */
  workerKeys(): string[] {
    return [...this.workers.keys()]
  }

  /**
   * Whether the target is the provider's current effective account: the key
   * its live session cadence resolves to, or — with no live session — its
   * only worker key. A settlement under a retired or a sibling key goes to
   * history under its own identity and never replaces the live report (B5).
   */
  isCurrentAccount(target: QuotaTarget): boolean {
    const key = accountKeyOf(target)
    const session = this.options.sessionTarget(target.providerId)
    if (session !== undefined) return session !== null && accountKeyOf(session) === key
    const keys = [...this.workers.values()].filter(entry => entry.target.providerId === target.providerId).map(entry => entry.key)
    return keys.length === 1 && keys[0] === key
  }

  /** Whether the worker entry for this target has a timer armed. */
  workerArmed(target: QuotaTarget): boolean {
    return this.workers.get(accountKeyOf(target))?.timer != null
  }

  /**
   * One request for the target's account, or the one already in flight. Null
   * when the service is stopped or the request was abandoned at the timeout.
   */
  request(target: QuotaTarget, origin: 'session' | 'worker' = 'session'): Promise<QuotaPull | null> {
    if (this.stopped) return Promise.resolve(null)
    const key = accountKeyOf(target)
    const running = this.inFlight.get(key)
    if (running) {
      // A session joining a worker's request (a spawn pull, a session tick)
      // shares its settlement: the session's teams get the observation too.
      if (origin === 'session') running.started.sessionJoined = true
      return running.promise
    }
    const token = ++this.sequence
    const startedAt = this.now()
    // The reason is the one the request started under (B3): a worker removed
    // while it runs still has its settlement recorded as a worker's.
    const started: Started = { ...this.reasonOf(key, target, origin === 'session'), sessionJoined: false }
    const read = this.options.read(target).catch(
      (): QuotaPull => ({ ok: false, outcome: 'unreachable', reason: 'quota read failed' })
    )
    // The service bounds standalone reads itself (S4); session reads of other
    // readers keep their own timeouts unchanged (X2).
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = readerKindOf(target) === 'standalone'
      ? Promise.race([read, new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), this.options.timeoutMs ?? QUOTA_TIMEOUT_MS)
          timer.unref?.()
        })])
      : read
    const promise = bounded.then((pull) => {
      if (timer) clearTimeout(timer)
      if (this.inFlight.get(key)?.token === token) this.inFlight.delete(key)
      if (this.stopped) return null
      this.settle(key, target, pull, startedAt, started)
      return pull
    })
    this.inFlight.set(key, { token, promise, started })
    return promise
  }

  /** The reasons holding a key; `sessionOrigin` marks a request a session made (spawn pull, session tick). */
  private reasonOf(key: string, target: QuotaTarget, sessionOrigin = false): { reason: QuotaReason; teams: string[] } {
    const worker = this.workers.get(key)
    const session = sessionOrigin || this.sessionServes(key, target.providerId)
    const teams = new Set(worker?.teams ?? [])
    // Session teams only when a session holds this key (its own request, or B6).
    if (session) for (const team of this.options.sessionTeams(target)) teams.add(team)
    const reason: QuotaReason = worker && session ? 'both' : worker ? 'worker' : 'session'
    return { reason, teams: [...teams] }
  }

  private settle(key: string, target: QuotaTarget, pull: QuotaPull | null, startedAt: number, started: Started): void {
    const outcome = quotaOutcomeOf(pull)
    const worker = this.workers.get(key)
    if (worker) {
      if (outcome === 'failed' || outcome === 'auth-refused') worker.failures += 1
      else if (outcome === 'unsupported') worker.disabled = true
      else worker.failures = 0
    }
    const now = this.reasonOf(key, target, started.sessionJoined)
    const teams = new Set([...started.teams, ...now.teams])
    const reason: QuotaReason = started.sessionJoined && started.reason === 'worker' ? 'both' : started.reason
    this.options.onSettled({ target, reason, teams: [...teams], outcome, pull, startedAt, settledAt: this.now() })
  }

  // ------------------------------------------------------------------ sessions

  /** Arm the provider's session cadence (today's refresh timer); idempotent. */
  armSession(providerId: string): void {
    if (this.stopped || this.sessions.has(providerId)) return
    const timer = setInterval(() => this.refreshSession(providerId), this.options.cadenceMs)
    timer.unref?.()
    this.sessions.set(providerId, timer)
  }

  /** One session refresh: stops the cadence without a live session (today's semantics). */
  refreshSession(providerId: string): void {
    const target = this.options.sessionTarget(providerId)
    if (target === undefined) {
      const timer = this.sessions.get(providerId)
      if (timer) clearInterval(timer)
      this.sessions.delete(providerId)
      return
    }
    if (!target?.baseUrl) return
    void this.request(target).then((pull) => {
      if (pull && !this.stopped) this.options.onSessionPull(providerId, target, pull)
    })
  }

  /** Whether the provider's armed session cadence currently polls this key (B6). */
  private sessionServes(key: string, providerId: string): boolean {
    if (!this.sessions.has(providerId)) return false
    const target = this.options.sessionTarget(providerId)
    return target != null && accountKeyOf(target) === key
  }

  // ------------------------------------------------------------------- workers

  /**
   * Make the worker reasons equal `desired`: new keys poll now (S1, S14), keys
   * nobody lists lose their timer (S7), a key listed by another team only
   * gains the team (S13). Non-standalone targets report `unsupported` once
   * per team and configuration and never get a timer (S9).
   */
  reconcileWorkers(desired: WorkerSubscription[]): void {
    if (this.stopped) return
    const next = new Map<string, { target: QuotaTarget; teams: Set<string> }>()
    const unsupported = new Set<string>()
    for (const { teamId, target } of desired) {
      const key = accountKeyOf(target)
      if (readerKindOf(target) !== 'standalone') {
        const id = `${teamId}\0${key}`
        unsupported.add(id)
        if (!this.unsupported.has(id)) {
          this.unsupported.add(id)
          const at = this.now()
          this.options.onSettled({ target, reason: 'worker', teams: [teamId], outcome: 'unsupported', pull: null, startedAt: at, settledAt: at })
        }
        continue
      }
      const entry = next.get(key) ?? { target, teams: new Set<string>() }
      entry.teams.add(teamId)
      next.set(key, entry)
    }
    for (const id of [...this.unsupported]) if (!unsupported.has(id)) this.unsupported.delete(id)
    for (const [key, entry] of this.workers) {
      if (next.has(key)) continue
      if (entry.timer) clearTimeout(entry.timer)
      this.workers.delete(key)
    }
    for (const [key, { target, teams }] of next) {
      const entry = this.workers.get(key)
      if (entry) {
        entry.teams = teams
        continue
      }
      const created: WorkerEntry = { key, target, teams, timer: null, failures: 0, disabled: false }
      this.workers.set(key, created)
      this.poll(created)
    }
  }

  private poll(entry: WorkerEntry): void {
    void this.request(entry.target, 'worker').then(() => this.afterPoll(entry))
  }

  private afterPoll(entry: WorkerEntry): void {
    if (this.stopped || this.workers.get(entry.key) !== entry || entry.disabled || entry.timer) return
    this.schedule(entry, entry.failures > 0 ? quotaBackoffMs(entry.failures) : this.cadenceDelay())
  }

  private cadenceDelay(): number {
    const random = (this.options.random ?? Math.random)()
    return Math.round(this.options.cadenceMs * (1 + (random * 2 - 1) * QUOTA_JITTER))
  }

  private schedule(entry: WorkerEntry, delay: number): void {
    entry.timer = setTimeout(() => this.tick(entry), delay)
    entry.timer.unref?.()
  }

  private tick(entry: WorkerEntry): void {
    entry.timer = null
    if (this.stopped || this.workers.get(entry.key) !== entry || entry.disabled) return
    // Served by a live session's cadence, or a request already running (S3, S8).
    if (this.sessionServes(entry.key, entry.target.providerId) || this.inFlight.has(entry.key)) {
      this.schedule(entry, this.cadenceDelay())
      return
    }
    this.poll(entry)
  }

  /** Server shutdown: every timer cleared; nothing settles or publishes afterwards (S11). */
  shutdown(): void {
    this.stopped = true
    for (const entry of this.workers.values()) if (entry.timer) clearTimeout(entry.timer)
    this.workers.clear()
    for (const timer of this.sessions.values()) clearInterval(timer)
    this.sessions.clear()
  }
}
