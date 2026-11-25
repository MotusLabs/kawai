// Service-seam harness for Table S and property P1 (process-quota-history-
// and-incident-advice): the production `ManagerQuota` — its reader service,
// history store and publish path — over a fresh test database, reading
// through the production Z.AI pull (`fetchZaiUsage`) with an injected fetch
// that holds every request until the test answers it and honours the abort
// signal the way a real transport does. Fake timers drive the clock; no test
// using it reaches the network (X4). Logger calls are captured so property P4
// can search them for the fake credential and the response body.
import { jest, spyOn } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionDatabase } from '../../db'
import { logger } from '../../logger'
import { UsageLimitStore } from '../../chat/usageLimits'
import { fetchZaiUsage } from '../../chat/zaiUsage'
import { ManagerQuota } from '../../chat/quota/managerQuota'
import type { QuotaPull, QuotaSettlement, WorkerSubscription } from '../../chat/quota/QuotaReaderService'
import { accountKeyOf, type QuotaTarget } from '../../chat/quota/quotaTarget'
import { BODY_MARKER, CADENCE_MS, QUOTA_TOKEN, QUOTA_TOKEN_B, jsonResponse, quotaCapture } from './quotaComposition'
import { freshTestDatabase } from './testDatabase'

export { BODY_MARKER, CADENCE_MS, QUOTA_TOKEN, QUOTA_TOKEN_B }

export const ZAI: QuotaTarget = { providerId: 'zai', baseUrl: 'https://zai.test/api/anthropic', token: QUOTA_TOKEN }
export const ZAI_B: QuotaTarget = { ...ZAI, token: QUOTA_TOKEN_B }
export const OTHER: QuotaTarget = { providerId: 'other', baseUrl: 'https://other.test/api/anthropic', token: QUOTA_TOKEN }
export const HOST_ONLY: QuotaTarget = { providerId: 'hostonly', baseUrl: null }
export const ROUTER: QuotaTarget = { providerId: 'router', baseUrl: 'https://openrouter.ai/api', token: QUOTA_TOKEN }

export interface HeldRequest {
  url: string
  auth: string | undefined
  signal: AbortSignal
  /** Ended by an answer, a failure, or an abort. */
  ended: boolean
  ok(percent?: number, resetMs?: number): void
  fail(status?: number): void
}

export interface ServiceHarness {
  db: SessionDatabase
  quota: ManagerQuota
  usage: UsageLimitStore
  requests: HeldRequest[]
  settlements: QuotaSettlement[]
  sessionPulls: Array<{ providerId: string; pull: QuotaPull }>
  logs: string[]
  /** Worker subscriptions `configuredWorkers` returns. */
  desired: WorkerSubscription[]
  /** Live session targets by provider (absent: no live session). */
  live: Map<string, QuotaTarget | null>
  /** Answer every new request at once with this (null: hold it). */
  auto: ((request: HeldRequest) => void) | null
  /** Jitter draw in [0, 1). */
  random: number
  reconcile(desired?: WorkerSubscription[]): Promise<void>
  /** Called with the account key of each request before it is counted (P1 checks). */
  beforeRequest: ((key: string) => void) | null
  /** Open transport requests for one account key. */
  openKey(key: string): HeldRequest[]
  /**
   * A process restart: the old manager stops, its open requests end with the
   * process, and a new manager starts over the same database and fetch.
   */
  restart(): void
  /** Requests whose transport has not ended, for one account key. */
  open(target: QuotaTarget): HeldRequest[]
  /** Answer the oldest open request. */
  answerOldest(answer: (request: HeldRequest) => void): Promise<void>
  close(): void
}

/** Let promise chains run; `setImmediate` is not faked. */
export async function flush(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    jest.advanceTimersByTime(0)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Advance fake time in 1 s steps, letting microtasks run after each. */
export async function step(ms: number, chunk = 1_000): Promise<void> {
  for (let done = 0; done < ms; done += chunk) {
    jest.advanceTimersByTime(Math.min(chunk, ms - done))
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }
  await flush(3)
}

export function sub(teamId: string, target: QuotaTarget): WorkerSubscription {
  return { teamId, target }
}

/**
 * A harness over a fresh database, or over `shared` (left open on close and
 * emptied of quota history first) so a long property can reuse one.
 */
export function serviceHarness(shared?: SessionDatabase): ServiceHarness {
  jest.useFakeTimers()
  const root = shared ? null : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-quota-svc-')))
  const db = shared ?? freshTestDatabase(path.join(root!, 'test.db'))
  if (shared) shared.db.exec('DELETE FROM process_quota_observations')
  const usage = new UsageLimitStore()
  const requests: HeldRequest[] = []
  const logs: string[] = []
  const spies = (['debug', 'info', 'warn', 'error'] as const).map(level =>
    spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logs.push(JSON.stringify(args)) }) as never))
  const harness = {} as ServiceHarness
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const signal = init?.signal as AbortSignal
    const request: HeldRequest = {
      url: String(url), auth: headers.Authorization, signal, ended: false,
      ok(percent = 40, resetMs?: number) {
        if (request.ended) return
        request.ended = true
        resolve(jsonResponse(quotaCapture(percent, resetMs)))
      },
      fail(status = 503) {
        if (request.ended) return
        request.ended = true
        resolve(new Response(`upstream ${BODY_MARKER} ${QUOTA_TOKEN}`, { status }))
      },
    }
    signal.addEventListener('abort', () => {
      if (request.ended) return
      request.ended = true
      reject(new DOMException(`aborted ${BODY_MARKER}`, 'AbortError'))
    })
    harness.beforeRequest?.(keyOfRequest(request))
    requests.push(request)
    harness.auto?.(request)
  })) as typeof fetch
  const settlements: QuotaSettlement[] = []
  const build = (): ManagerQuota => {
    const quota = new ManagerQuota({
      db: db.db,
      cadenceMs: CADENCE_MS,
      read: target => target.baseUrl
        ? fetchZaiUsage(target.baseUrl, target.token, fetchImpl)
        : Promise.resolve({ ok: false, outcome: 'not-provider', reason: 'no base URL' }),
      sessionTarget: providerId => harness.live.has(providerId) ? harness.live.get(providerId) : undefined,
      // The live session's team, when its account is the target's (same key).
      sessionTeams: (target) => {
        const live = harness.live.get(target.providerId)
        return live && accountKeyOf(live) === accountKeyOf(target) ? ['team-live'] : []
      },
      onSessionPull: (providerId, _target, pull) => { harness.sessionPulls.push({ providerId, pull }) },
      publishWorkerReport: (target, report) => harness.usage.record(target.providerId, report),
      configuredWorkers: () => harness.desired,
      random: () => harness.random,
    })
    // Observe settlements without changing what the manager does with them.
    const options = (quota.service as unknown as { options: { onSettled: (s: QuotaSettlement) => void } }).options
    const onSettled = options.onSettled
    options.onSettled = (settlement) => {
      settlements.push(settlement)
      onSettled(settlement)
    }
    return quota
  }
  const quota = build()
  Object.assign(harness, {
    db, quota, usage, requests, settlements, sessionPulls: [], logs, desired: [], live: new Map(), auto: null, random: 0.5,
    beforeRequest: null,
    openKey(key: string) {
      return requests.filter(request => !request.ended && keyOfRequest(request) === key)
    },
    restart() {
      harness.quota.shutdown()
      for (const request of requests) request.ended = true
      harness.usage = new UsageLimitStore()
      harness.quota = build()
      harness.quota.start()
    },
    async reconcile(desired?: WorkerSubscription[]) {
      if (desired) harness.desired = desired
      harness.quota.reconcile()
      await flush()
    },
    open(target: QuotaTarget) {
      return harness.openKey(accountKeyOf(target))
    },
    async answerOldest(answer: (request: HeldRequest) => void) {
      const request = requests.find(candidate => !candidate.ended)
      if (!request) throw new Error('no open request')
      answer(request)
      await flush()
    },
    close() {
      harness.quota.shutdown()
      for (const spy of spies) spy.mockRestore()
      jest.useRealTimers()
      if (root) {
        db.close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  } satisfies Partial<ServiceHarness>)
  return harness
}

/** The account key a held request was made for (its URL host and credential). */
export function keyOfRequest(request: HeldRequest): string {
  const url = new URL(request.url)
  const providerId = url.host === 'zai.test' ? 'zai' : url.host === 'other.test' ? 'other' : url.host
  return accountKeyOf({ providerId, baseUrl: `${url.origin}/api/anthropic`, token: request.auth })
}

/** Every stored quota row, raw, for P4. */
export function storedRows(harness: ServiceHarness): string[] {
  return (harness.db.db.prepare('SELECT * FROM process_quota_observations').all() as unknown[]).map(row => JSON.stringify(row))
}
