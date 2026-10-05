// Owns the lifecycle of chat sessions: auth-gated creation, lazy driver
// construction (the SDK query() is spawned by the driver on the first turn),
// persistence in the chat_sessions table with restore-on-start into the
// registry, kill/shutdown settlement, and immediate sdkSessionId capture so a
// restart can resume the same agent conversation. The SDK import stays dynamic
// (injected as a queryFactory in tests) so a broken install disables the
// feature instead of crashing the server.
import fs from 'node:fs'
import path from 'node:path'
import type {
  ChatApprovalDecision,
  ChatEvent,
  ChatPendingRequest,
  ChatQuestionAnswer,
} from '../../shared/chat'
import type { ServerMessage, Session, SessionStatus } from '../../shared/types'
import type { ChatSessionRecord, SessionDatabase } from '../db'
import { generateSessionName } from '../nameGenerator'
import type { SessionRegistry } from '../SessionRegistry'
import { ChatSessionDriver, type ChatQueryFactory } from './ChatSessionDriver'
import { probeSdkAvailability } from './sdkAvailability'
import {
  findTranscriptPath,
  replayTranscriptFile,
  type TranscriptReplay,
} from './transcriptReplay'

export type { ChatQueryFactory }

export interface ChatSessionManagerOptions {
  registry: SessionRegistry
  db: SessionDatabase
  /** Conversation-event sink (wired to the WS broadcast in index.ts). */
  onEvent: (sessionId: string, event: ChatEvent) => void
  /** Injected in tests; production resolves the SDK via dynamic import. */
  queryFactory?: ChatQueryFactory
  availabilityProbe?: () => Promise<void>
  authCheck?: () => boolean
}

export type ChatCreateResult =
  | { ok: true; session: Session }
  | { ok: false; error: string }

export type ChatActionResult =
  | { ok: true }
  | { ok: false; error: string }

/** The Claude CLI's credentials file inside the config dir (Linux/Windows). */
const CLI_CREDENTIALS_FILE = '.credentials.json'

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (override) return override
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return path.join(home, '.claude')
}

/**
 * Server-side auth gate (design D9): chat sessions can only run when the SDK
 * can authenticate — via ANTHROPIC_API_KEY in the environment or the CLI's
 * an OAuth token or stored login under CLAUDE_CONFIG_DIR (~/.claude by default). Credentials
 * never leaves the server.
 */
export function hasClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true
  try {
    return fs.existsSync(path.join(claudeConfigDir(), CLI_CREDENTIALS_FILE))
  } catch {
    return false
  }
}

/** Actionable refusal shown when hasClaudeAuth() is false. */
export function chatAuthErrorMessage(): string {
  return (
    'Chat sessions need Claude authentication on the server. ' +
    'Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the server environment, or log in with the ' +
    `Claude CLI (\`claude login\`) so credentials exist at ${path.join(
      claudeConfigDir(),
      CLI_CREDENTIALS_FILE
    )} — or point CLAUDE_CONFIG_DIR at an authenticated config directory.`
  )
}

export class ChatSessionManager {
  private readonly options: ChatSessionManagerOptions
  private readonly records = new Map<string, ChatSessionRecord>()
  private readonly drivers = new Map<string, ChatSessionDriver>()
  /** In-flight ensureDriver calls, so racing sends never build two drivers. */
  private readonly driverPromises = new Map<
    string,
    Promise<ChatSessionDriver | null>
  >()
  private sdkQuery: Promise<ChatQueryFactory> | null = null
  private availability: Promise<void> | null = null

  async createAvailableSession(input: { projectPath: string; name?: string }): Promise<ChatCreateResult> {
    if (!(this.options.authCheck ?? hasClaudeAuth)()) return { ok: false, error: chatAuthErrorMessage() }
    try {
      this.availability ??= (this.options.availabilityProbe ??
        (this.options.queryFactory ? async () => {} : probeSdkAvailability))()
      await this.availability
    } catch (error) {
      return {
        ok: false,
        error: 'Claude Agent SDK is unavailable. Check its installation and runtime, then restart the server. ' +
          (error instanceof Error ? error.message : 'SDK probe failed'),
      }
    }
    return this.createSession(input)
  }
  private readonly snapshotHistory = new Map<string, ChatEvent[]>()
  private readonly liveEvents = new Map<string, ChatEvent[]>()

  /** Synchronous capture: no driver callback can interleave with history loading. */
  getSnapshot(sessionId: string): Extract<ServerMessage, { type: 'chat-snapshot' }> | null {
    if (!this.records.has(sessionId)) return null
    this.captureHistory(sessionId)
    const live = this.liveEvents.get(sessionId) ?? []
    return {
      type: 'chat-snapshot', sessionId,
      events: [...(this.snapshotHistory.get(sessionId) ?? []), ...live],
      pendingRequests: this.getPendingRequests(sessionId),
      status: this.options.registry.get(sessionId)?.status ?? 'waiting',
      throughSequence: live.at(-1)?.sequence ?? 0,
    }
  }

  private captureHistory(sessionId: string): void {
    if (!this.snapshotHistory.has(sessionId)) {
      this.snapshotHistory.set(sessionId, this.getHistory(sessionId)?.events ?? [])
    }
  }

  constructor(options: ChatSessionManagerOptions) {
    this.options = options
    this.restorePersisted()
  }

  /** Create a chat session. Refused (no side effects) when auth is missing. */
  createSession(input: {
    projectPath: string
    name?: string
  }): ChatCreateResult {
    const projectPath = input.projectPath.trim()
    if (!projectPath) {
      return { ok: false, error: 'A project directory is required' }
    }
    if (!(this.options.authCheck ?? hasClaudeAuth)()) {
      return { ok: false, error: chatAuthErrorMessage() }
    }
    const sessionId = `chat-${crypto.randomUUID()}`
    const name = input.name?.trim() || generateSessionName()
    const now = new Date().toISOString()
    const record = {
      sessionId,
      name,
      projectPath,
      sdkSessionId: null as string | null,
      status: 'waiting' as SessionStatus,
      createdAt: now,
      lastActivityAt: now,
    }
    this.records.set(sessionId, record)
    this.options.db.insertChatSession(record)
    const session = this.toSession(record)
    this.options.registry.setChatSession(session)
    return { ok: true, session }
  }

  /** True when the id is a known chat session. */
  has(sessionId: string): boolean {
    return this.records.has(sessionId)
  }

  /**
   * Read-only history for a chat session: the stored SDK transcript replayed
   * into ChatEvents (with dead requests marked cancelled), or a
   * "history unavailable" notice. Sessions that never started have no SDK id
   * and replay as empty. Unknown sessions return null.
   */
  getHistory(sessionId: string): TranscriptReplay | null {
    const record = this.records.get(sessionId)
    if (!record) return null
    if (!record.sdkSessionId) {
      return { status: 'ok', events: [] }
    }
    return replayTranscriptFile(findTranscriptPath(record.sdkSessionId), {
      excludeToolCallIds: this.liveToolCallIds(sessionId),
    })
  }

  /**
   * Submit a user turn. The driver (and behind it the SDK subprocess) is
   * created lazily here — the first turn pays the spawn cost, creation never
   * blocks on process startup. A stored SDK id whose transcript is missing
   * refuses the turn rather than silently starting a fresh conversation
   * (design D5): the id is kept so a restored transcript can still resume.
   */
  async send(sessionId: string, text: string): Promise<ChatActionResult> {
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    if (
      record.sdkSessionId &&
      !this.drivers.has(sessionId) &&
      !this.driverPromises.has(sessionId) &&
      !findTranscriptPath(record.sdkSessionId)
    ) {
      return {
        ok: false,
        error:
          'Cannot resume this conversation: the agent transcript is missing. ' +
          `Restore ${record.sdkSessionId}.jsonl or create a new chat session.`,
      }
    }
    let driver: ChatSessionDriver | null
    try {
      driver = await this.ensureDriver(sessionId)
    } catch (error) {
      return {
        ok: false,
        error:
          'The Claude Agent SDK could not be loaded, so chat sessions are unavailable. ' +
          `Check the @anthropic-ai/claude-agent-sdk install: ${
            error instanceof Error ? error.message : String(error)
          }`,
      }
    }
    if (!driver) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    driver.send(text)
    this.touch(sessionId)
    return { ok: true }
  }

  /** Stop button: abort the in-flight turn without removing the session. */
  interrupt(sessionId: string): ChatActionResult {
    if (!this.records.has(sessionId)) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    // An idle session (no driver yet) has nothing to interrupt.
    this.drivers.get(sessionId)?.interrupt()
    return { ok: true }
  }

  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: ChatApprovalDecision
  ): ChatActionResult {
    const driver = this.drivers.get(sessionId)
    if (!driver) {
      return {
        ok: false,
        error: this.records.has(sessionId)
          ? `No pending approval with id ${requestId}; the session has no in-flight turn`
          : `Unknown chat session ${sessionId}`,
      }
    }
    return driver.resolveApproval(requestId, decision)
  }

  answerQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, ChatQuestionAnswer>
  ): ChatActionResult {
    const driver = this.drivers.get(sessionId)
    if (!driver) {
      return {
        ok: false,
        error: this.records.has(sessionId)
          ? `No pending question with id ${requestId}; the session has no in-flight turn`
          : `Unknown chat session ${sessionId}`,
      }
    }
    return driver.answerQuestion(requestId, answers)
  }

  getPendingRequests(sessionId: string): ChatPendingRequest[] {
    return this.drivers.get(sessionId)?.getPendingRequests() ?? []
  }

  /** Kill: abort the agent, settle pending requests, forget the session. */
  kill(sessionId: string): boolean {
    const record = this.records.get(sessionId)
    if (!record) return false
    this.drivers.get(sessionId)?.kill()
    this.drivers.delete(sessionId)
    this.driverPromises.delete(sessionId)
    this.records.delete(sessionId)
    this.snapshotHistory.delete(sessionId)
    this.liveEvents.delete(sessionId)
    this.options.registry.removeChatSession(sessionId)
    this.options.db.deleteChatSession(sessionId)
    return true
  }

  /** Server shutdown: settle every driver (callbacks cannot survive it). */
  shutdown(): void {
    for (const driver of this.drivers.values()) {
      driver.shutdown()
    }
    this.drivers.clear()
    this.driverPromises.clear()
  }

  /**
   * SDK session ids of all known chat sessions (live and restored) — used by
   * log discovery to exclude chat transcripts from agent-session matching
   * (design D6).
   */
  getSdkSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const record of this.records.values()) {
      if (record.sdkSessionId) ids.add(record.sdkSessionId)
    }
    return ids
  }

  // ---------------------------------------------------------------- internals

  /**
   * Tool call ids a live (non-dead) driver has seen. Transcript replay must
   * not mark those as cancelled — the live stream still owns their outcome.
   */
  private liveToolCallIds(sessionId: string): Set<string> {
    const driver = this.drivers.get(sessionId)
    if (!driver || driver.isDead) return new Set()
    return driver.getSeenToolCallIds()
  }

  /** Load chat_sessions rows into the registry as idle chat sessions. */
  private restorePersisted(): void {
    for (const row of this.options.db.getChatSessions()) {
      let record = row
      // Pending requests and in-flight turns died with the old process; a
      // restored session is always idle.
      if (record.status !== 'waiting') {
        record = { ...record, status: 'waiting' }
        this.options.db.updateChatSession(record.sessionId, {
          status: 'waiting',
        })
      }
      this.records.set(record.sessionId, record)
      this.options.registry.setChatSession(this.toSession(record))
    }
  }

  private async ensureDriver(
    sessionId: string
  ): Promise<ChatSessionDriver | null> {
    const existing = this.drivers.get(sessionId)
    if (existing) return existing
    const pending = this.driverPromises.get(sessionId)
    if (pending) return pending
    const record = this.records.get(sessionId)
    if (!record) return null
    this.captureHistory(sessionId)
    const promise = (async () => {
      const queryFactory = await this.resolveQueryFactory()
      const driver = new ChatSessionDriver({
        sessionId: record.sessionId,
        projectPath: record.projectPath,
        queryFactory,
        ...(record.sdkSessionId
          ? { resumeSessionId: record.sdkSessionId }
          : {}),
        onEvent: (event) => this.handleDriverEvent(record.sessionId, event),
        onStatus: (status) => this.applyPatch(record.sessionId, { status }),
        onSdkSessionId: (sdkSessionId) =>
          // Persist immediately: a crash right after the first turn must not
          // lose the ability to resume the conversation.
          this.applyPatch(record.sessionId, { sdkSessionId }),
      })
      if (!this.records.has(record.sessionId)) {
        // Killed while the import was resolving.
        driver.kill()
        return null
      }
      this.drivers.set(record.sessionId, driver)
      return driver
    })()
    this.driverPromises.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.driverPromises.delete(sessionId)
    }
  }

  /**
   * Resolve the SDK query() once per process. The import is dynamic so a
   * missing/broken install surfaces as a send-time error, not a crash; the
   * cache is dropped on failure so a repaired install recovers without a
   * server restart.
   */
  private async resolveQueryFactory(): Promise<ChatQueryFactory> {
    const injected = this.options.queryFactory
    if (injected) return injected
    this.sdkQuery ??= import('@anthropic-ai/claude-agent-sdk').then(
      (sdk) => sdk.query,
      (error) => {
        this.sdkQuery = null
        throw error
      }
    )
    return this.sdkQuery
  }

  private handleDriverEvent(sessionId: string, event: ChatEvent): void {
    if (!this.records.has(sessionId)) return
    const events = this.liveEvents.get(sessionId) ?? []
    event = { ...event, sequence: (events.at(-1)?.sequence ?? 0) + 1 }
    events.push(event)
    this.liveEvents.set(sessionId, events)
    this.options.onEvent(sessionId, event)
    if (
      event.type === 'turn_completed' ||
      event.type === 'approval_request' ||
      event.type === 'question_request'
    ) {
      this.touch(sessionId)
    }
  }

  /** Bump lastActivity across record, db, and registry in one update. */
  private touch(sessionId: string): void {
    this.applyPatch(sessionId, { lastActivityAt: new Date().toISOString() })
  }

  private applyPatch(
    sessionId: string,
    patch: Partial<ChatSessionRecord>
  ): void {
    const record = this.records.get(sessionId)
    if (!record) return
    const next = { ...record, ...patch }
    this.records.set(sessionId, next)
    this.options.db.updateChatSession(sessionId, patch)
    this.options.registry.updateSession(sessionId, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.lastActivityAt !== undefined
        ? { lastActivity: patch.lastActivityAt }
        : {}),
    })
  }

  private toSession(record: ChatSessionRecord): Session {
    return {
      id: record.sessionId,
      name: record.name,
      kind: 'chat',
      projectPath: record.projectPath,
      status: record.status,
      lastActivity: record.lastActivityAt,
      createdAt: record.createdAt,
      source: 'managed',
      // Per design D1: existing icons, labels, and sorting keep working.
      agentType: 'claude',
    }
  }
}
