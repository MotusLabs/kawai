// Production-composition harness for the quota reader (process-quota-history-
// and-incident-advice): a real ChatSessionManager with a user-level provider
// catalog, a project whose group file lists workers, an injected fetch that
// records every request and answers from a script, and fake timers. No test
// using it reaches the network (X4) or starts an agent unless it says so.
import { jest } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatUsageReport } from '../../../shared/chat'
import { initDatabase, type SessionDatabase } from '../../db'
import { SessionRegistry } from '../../SessionRegistry'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import { anyDirectory, fakeQueryFactory, managedManager, type FakeHandle } from './chatSessionManagerHarness'

/** Built at runtime so no literal looks like a credential (P4 searches for these). */
export const QUOTA_TOKEN = ['zq', 'fake', 'token', 'a1b2c3'].join('-')
export const QUOTA_TOKEN_B = ['zq', 'fake', 'token', 'd4e5f6'].join('-')
export const BODY_MARKER = 'body-marker-7f3e'

export const CADENCE_MS = 600_000

/** A Z.AI quota capture at `percentage`, carrying a body-only marker string. */
export function quotaCapture(percentage: number, nextResetTime = 4_102_444_800_000): unknown {
  return {
    code: 200, msg: `Operation successful ${BODY_MARKER}`, success: true,
    data: { limits: [{ type: 'TIME_LIMIT', percentage, nextResetTime }], level: 'pro' },
  }
}

export interface FetchCall {
  url: string
  auth: string | undefined
}

export type Answer = Response | Error | Promise<Response>

export interface QuotaComposition {
  root: string
  home: string
  project: string
  db: SessionDatabase
  manager: ChatSessionManager
  handles: FakeHandle[]
  calls: FetchCall[]
  usage: Array<{ providerId: string; report: ChatUsageReport | null }>
  /** Answers queued for the next requests; when empty, `fallback` answers. */
  answers: Answer[]
  setFallback(answer: () => Answer): void
  writeGroup(frontmatter: string, name?: string): void
  close(): Promise<void>
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A user-level catalog: provider `zai` (profiles `glm`, `glm-flash`) with a base URL and token env, plus `host` (no base URL). */
function writeCatalog(home: string, tokenEnv = 'ZQ_TOKEN'): void {
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kawai', 'providers.json'), JSON.stringify({
    zai: {
      label: 'Z.AI', authTokenEnv: tokenEnv,
      env: { ANTHROPIC_BASE_URL: 'https://zai.test/api/anthropic' },
      models: { glm: { label: 'GLM' }, 'glm-flash': { label: 'GLM Flash' } },
    },
    other: {
      label: 'Other', authTokenEnv: 'ZQ_OTHER_TOKEN',
      env: { ANTHROPIC_BASE_URL: 'https://other.test/api/anthropic' },
      models: { 'other-m': { label: 'Other M' } },
    },
    router: {
      label: 'Router', authTokenEnv: 'ZQ_OR_TOKEN',
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' },
      models: { 'or-m': {} },
    },
  }))
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
    default: { label: 'Default' }, hostonly: { label: 'Host only', model: 'sonnet' },
  }))
}

/**
 * Build the composition with fake timers installed. `env` is the server's
 * provider environment (token values). Every request is recorded with its
 * Authorization header and answered from `answers`, then `fallback`.
 */
export async function quotaComposition(options: { env?: Record<string, string> } = {}): Promise<QuotaComposition> {
  jest.useFakeTimers()
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-quota-')))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  writeCatalog(home)
  fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
  const db = initDatabase({ path: path.join(root, 'test.db') })
  const calls: FetchCall[] = []
  const answers: Answer[] = []
  let fallback: () => Answer = () => jsonResponse(quotaCapture(5))
  const providerUsageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
    const next = answers.length > 0 ? answers.shift()! : fallback()
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  const env = options.env ?? { ZQ_TOKEN: QUOTA_TOKEN }
  const handles: FakeHandle[] = []
  const usage: QuotaComposition['usage'] = []
  const manager = await managedManager({
    isDirectory: anyDirectory, db, registry: new SessionRegistry(), onEvent: () => {}, authCheck: () => true,
    onUsage: (providerId, report) => usage.push({ providerId, report }),
    queryFactory: fakeQueryFactory(handles),
    getProviderEnv: () => env,
    profileCatalogHome: home,
    providerUsageFetch,
    providerUsageRefreshMs: CADENCE_MS,
  })
  return {
    root, home, project, db, manager, handles, calls, usage, answers,
    setFallback: answer => { fallback = answer },
    writeGroup: (frontmatter, name = 'devs') =>
      fs.writeFileSync(path.join(project, '.kawai', 'groups', `${name}.md`), `---\n${frontmatter}\n---\nBuild.`),
    close: async () => {
      manager.shutdown()
      await manager.retiredSettled()
      jest.useRealTimers()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Let real I/O (team resolution) and microtasks settle, advancing zero-delay timers between turns. */
export async function settle(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    jest.advanceTimersByTime(0)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Advance fake time in one-second steps, letting continuations run between steps. */
export async function advance(ms: number): Promise<void> {
  const step = 1_000
  for (let done = 0; done < ms; done += step) {
    jest.advanceTimersByTime(Math.min(step, ms - done))
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  await settle(5)
}

/** Every quota history row, oldest first. */
export function historyRows(db: SessionDatabase): Array<Record<string, unknown>> {
  return db.db.prepare('SELECT * FROM process_quota_observations ORDER BY observed_at, recorded_at, id').all() as Array<Record<string, unknown>>
}

/** Create a session (never started) so the project's team is known; returns its id. */
export async function anchorSession(composition: QuotaComposition, groupId = 'devs'): Promise<string> {
  const created = await composition.manager.createAvailableSession({ projectPath: composition.project, groupId })
  if (!created.ok) throw new Error(created.error)
  // Team resolution runs git (real I/O, unaffected by fake timers).
  await composition.manager.teams.resolvedTeamOf(created.session.id)
  await settle()
  return created.session.id
}
