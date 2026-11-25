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
  ok(percent?: number): void
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
export async function step(ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 1_000) {
    jest.advanceTimersByTime(Math.min(1_000, ms - done))
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }
  await flush(3)
}

export function sub(teamId: string, target: QuotaTarget): WorkerSubscription {
  return { teamId, target }
}

export function serviceHarness(): ServiceHarness {
  jest.useFakeTimers()
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-quota-svc-')))
  const db = freshTestDatabase(path.join(root, 'test.db'))
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
      ok(percent = 40) {
        if (request.ended) return
        request.ended = true
        resolve(jsonResponse(quotaCapture(percent)))
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
    requests.push(request)
    harness.auto?.(request)
  })) as typeof fetch
  const quota = new ManagerQuota({
    db: db.db,
    cadenceMs: CADENCE_MS,
    read: target => target.baseUrl
      ? fetchZaiUsage(target.baseUrl, target.token, fetchImpl)
      : Promise.resolve({ ok: false, outcome: 'not-provider', reason: 'no base URL' }),
    sessionTarget: providerId => harness.live.has(providerId) ? harness.live.get(providerId) : undefined,
    sessionTeams: providerId => harness.live.has(providerId) ? ['team-live'] : [],
    onSessionPull: (providerId, _target, pull) => { harness.sessionPulls.push({ providerId, pull }) },
    publishWorkerReport: (providerId, report) => usage.record(providerId, report),
    configuredWorkers: () => harness.desired,
    random: () => harness.random,
  })
  // Observe settlements without changing what the manager does with them.
  const settlements: QuotaSettlement[] = []
  const options = (quota.service as unknown as { options: { onSettled: (s: QuotaSettlement) => void } }).options
  const onSettled = options.onSettled
  options.onSettled = (settlement) => {
    settlements.push(settlement)
    onSettled(settlement)
  }
  Object.assign(harness, {
    db, quota, usage, requests, settlements, sessionPulls: [], logs, desired: [], live: new Map(), auto: null, random: 0.5,
    async reconcile(desired?: WorkerSubscription[]) {
      if (desired) harness.desired = desired
      quota.reconcile()
      await flush()
    },
    open(target: QuotaTarget) {
      const key = accountKeyOf(target)
      return requests.filter(request => !request.ended && keyOfRequest(request) === key)
    },
    async answerOldest(answer: (request: HeldRequest) => void) {
      const request = requests.find(candidate => !candidate.ended)
      if (!request) throw new Error('no open request')
      answer(request)
      await flush()
    },
    close() {
      quota.shutdown()
      for (const spy of spies) spy.mockRestore()
      jest.useRealTimers()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
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
