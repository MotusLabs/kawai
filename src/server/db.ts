// SQLite persistence for sessions and chat records: opening the database
// through the schema-version runner (dbSafety/migrations.ts, which also owns
// the frozen baseline schema and the startup backup) and typed query helpers.
import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import type { ChatApprovalPolicy, ChatContextExhausted, ChatContextUsage } from '../shared/chat'
import type { AgentType, ChatNameSource, SessionStatus } from '../shared/types'
import type { ChatRuntime } from './chat/provider/driver'
import { parseApprovalPolicy } from './chat/approvalPolicy'
import { resolveProjectPath } from './paths'
import { DatabaseBackups } from './dbSafety/backups'
import { migrateSchema, type Migration } from './dbSafety/migrations'
import { compactDatabase, startIncremental } from './dbSafety/compaction'

export interface AgentSessionRecord {
  id: number
  sessionId: string
  logFilePath: string
  projectPath: string
  slug: string | null
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  lastUserMessage: string | null
  currentWindow: string | null
  isPinned: boolean
  lastResumeError: string | null
  wakeStartedAt: string | null
  lastKnownLogSize: number | null
  isCodexExec: boolean
  launchCommand: string | null
}

export type NewAgentSessionRecord = Omit<
  AgentSessionRecord,
  'id' | 'wakeStartedAt'
> & { wakeStartedAt?: string | null }

/** Identity fields for every tracked log, cheap enough to load in full. */
export interface KnownSessionKey {
  sessionId: string
  logFilePath: string
  projectPath: string | null
  slug: string | null
  agentType: AgentType | null
  isCodexExec: boolean
}

/**
 * Minimal chat-session row (design D5): conversation content itself is never
 * duplicated into our DB — it lives in the SDK transcript addressed by
 * `sdkSessionId`. Null sdkSessionId means created but never started.
 * `archivedAt` (chat-archive design D1) is the archive timestamp; null or
 * absent means the session is live. `approvalPolicy`
 * (chat-auto-approve-tools design D5) defaults to manual. `nameSource`
 * (chat-session-naming design D1) records who chose `name`; absent means the
 * name was never attributed and is treated as manual so it cannot be lost.
 * `contextUsage` (add-chat-context-usage design D4) is the latest
 * context-usage reading, stored over five columns; null/absent means no
 * model request has been measured yet. `model` (chat-session-model design
 * D4) is the model the agent last reported in its init frame; null/absent
 * means the session has not run a turn since it was created.
 */
export interface ChatSessionRecord {
  sessionId: string
  name: string
  projectPath: string
  sdkSessionId: string | null
  claudeProfileId?: string
  status: SessionStatus
  createdAt: string
  lastActivityAt: string
  archivedAt?: string | null
  approvalPolicy?: ChatApprovalPolicy
  nameSource?: ChatNameSource
  contextUsage?: ChatContextUsage | null
  /** Model the agent last reported (init frame); null/absent = none yet. */
  model?: string | null
  /** Team group (agent-teams): set at creation only; null/absent = none. */
  groupId?: string | null
  /** Team task the session works on (team-tasks); null/absent = none. */
  taskId?: string | null
  /** Created by worktree staffing rather than by the human (team-tasks D4). */
  spawned?: boolean
  /**
   * The context-exhausted flag (chat-context-exhaustion D3): when a turn
   * failed on a context limit and the CLI's terminal reason; null/absent = not
   * flagged. Patched as one value over its two columns.
   */
  contextExhausted?: ChatContextExhausted | null
  /**
   * The chat's agent runtime (codex-chat-sessions 3.3, ruling R1), fixed at
   * creation; absent/`claude` for chats created before runtimes existed.
   */
  runtime?: ChatRuntime
  /** The resolved Codex home a Codex chat was created against; null otherwise. */
  codexHome?: string | null
  /** The Codex transcript file path, once the driver's thread reveals it (§5). */
  transcriptPath?: string | null
}

// last_user_message is a UI preview; unbounded values (giant pastes, tool
// dumps) bloated real-world databases into the hundreds of MB and made every
// full-table read a multi-second event-loop stall.
export const MAX_LAST_USER_MESSAGE_LENGTH = 8192

function clampLastUserMessage(value: string | null): string | null {
  if (value && value.length > MAX_LAST_USER_MESSAGE_LENGTH) {
    return value.slice(0, MAX_LAST_USER_MESSAGE_LENGTH)
  }
  return value
}
export type ClaimCurrentWindowPatch = Partial<
  Pick<
    AgentSessionRecord,
    'displayName' | 'lastResumeError' | 'wakeStartedAt' | 'launchCommand'
  >
>

export interface SessionDatabase {
  db: SQLiteDatabase
  insertSession: (session: NewAgentSessionRecord) => AgentSessionRecord
  updateSession: (
    sessionId: string,
    patch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>>
  ) => AgentSessionRecord | null
  /**
   * Atomic window claim with two guards: only updates if (a) this row is still
   * dormant (current_window IS NULL) AND (b) no other row already owns the
   * target tmuxWindow. Returns the updated record on success, or null when
   * either guard fails (no-op). Use this from any rematch/wake path that
   * persists current_window after observing a candidate window externally.
   */
  claimCurrentWindow: (
    sessionId: string,
    tmuxWindow: string,
    extraPatch?: ClaimCurrentWindowPatch
  ) => AgentSessionRecord | null
  getSessionById: (sessionId: string) => AgentSessionRecord | null
  getSessionByLogPath: (logPath: string) => AgentSessionRecord | null
  getSessionByWindow: (tmuxWindow: string) => AgentSessionRecord | null
  getActiveSessions: () => AgentSessionRecord[]
  getHibernatingSessions: () => AgentSessionRecord[]
  getHistorySessions: (options?: { maxAgeHours?: number }) => AgentSessionRecord[]
  /** All session identity keys without large TEXT columns — safe to load per poll. */
  getKnownSessionKeys: () => KnownSessionKey[]
  orphanSession: (
    sessionId: string,
    options?: { hibernate?: boolean }
  ) => AgentSessionRecord | null
  displayNameExists: (displayName: string, excludeSessionId?: string) => boolean
  setPinned: (sessionId: string, isPinned: boolean) => AgentSessionRecord | null
  getActiveSessionBySlugAndProject: (
    slug: string,
    projectPath: string
  ) => AgentSessionRecord | null
  // App settings
  getAppSetting: (key: string) => string | null
  setAppSetting: (key: string, value: string) => void
  deleteAppSetting: (key: string) => void
  // Chat sessions (SDK-driven; separate from agent_sessions log rows)
  insertChatSession: (session: ChatSessionRecord) => ChatSessionRecord
  updateChatSession: (
    sessionId: string,
    patch: Partial<Omit<ChatSessionRecord, 'sessionId'>>
  ) => ChatSessionRecord | null
  deleteChatSession: (sessionId: string) => boolean
  getChatSession: (sessionId: string) => ChatSessionRecord | null
  getChatSessions: () => ChatSessionRecord[]
  close: () => void
  /** Online backups beside the database file; null for an in-memory database. */
  backups: DatabaseBackups | null
}

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.agentboard'
)
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'agentboard.db')
const DB_PATH_ENV = 'AGENTBOARD_DB_PATH'

/** The database path from AGENTBOARD_DB_PATH, or the default data dir. */
function resolveDbPath(): string {
  const envPath = process.env[DB_PATH_ENV]?.trim()
  const resolvedEnvPath =
    envPath && envPath !== ':memory:' ? resolveProjectPath(envPath) : envPath
  return resolvedEnvPath ?? DEFAULT_DB_PATH
}

/**
 * Directory beside agentboard.db for sibling data (chat wire logs). An
 * in-memory database falls back to the default data directory.
 */
export function resolveDataDir(): string {
  const dbPath = resolveDbPath()
  return !dbPath || dbPath === ':memory:' ? DEFAULT_DATA_DIR : path.dirname(dbPath)
}

/**
 * Open the database and bring its schema to this build's version
 * (execution-safety-recovery D13–D15). Throws DatabaseStartupError, before any
 * write, for a database newer than the build, for a recorded migration name
 * or version the registry disagrees with (a different lineage, or a gap in
 * the recorded versions), and for a failed migration or pre-migration
 * backup. `migrations` and `appVersion` are for tests.
 */
export function initDatabase(
  options: { path?: string; migrations?: readonly Migration[]; appVersion?: string } = {},
): SessionDatabase {
  const dbPath = options.path ?? resolveDbPath()
  ensureDataDir(dbPath)

  const db = new SQLiteDatabase(dbPath)
  // Wait out a lock held by another connection (e2e seed children, manual
  // sqlite3 inspection) instead of failing the statement at once with
  // SQLITE_BUSY. While an outside process holds a lock — a sqlite3 shell
  // with an open write transaction, or a second server on the same data
  // dir — a statement now blocks the server's thread for up to 5 s. The
  // journal mode stays rollback — WAL would add -wal/-shm files beside the
  // DB and change copy/backup semantics.
  db.exec('PRAGMA busy_timeout = 5000')
  startIncremental(db)
  const backups = dbPath === ':memory:' ? null : new DatabaseBackups({ db, dbPath })
  try {
    migrateSchema(db, dbPath, { backups, migrations: options.migrations, appVersion: options.appVersion })
  } catch (error) {
    db.close()
    throw error
  }
  // After the migrations, before serving: incremental auto_vacuum (never throws).
  compactDatabase(db)

  const insertStmt = db.prepare(
    `INSERT INTO agent_sessions
      (session_id, log_file_path, project_path, slug, agent_type, display_name, created_at, last_activity_at, last_user_message, current_window, is_pinned, last_resume_error, wake_started_at, last_known_log_size, is_codex_exec, launch_command)
     VALUES ($sessionId, $logFilePath, $projectPath, $slug, $agentType, $displayName, $createdAt, $lastActivityAt, $lastUserMessage, $currentWindow, $isPinned, $lastResumeError, $wakeStartedAt, $lastKnownLogSize, $isCodexExec, $launchCommand)`
  )

  const selectBySessionId = db.prepare(
    'SELECT * FROM agent_sessions WHERE session_id = $sessionId'
  )
  const selectByLogPath = db.prepare(
    'SELECT * FROM agent_sessions WHERE log_file_path = $logFilePath'
  )
  const selectByWindow = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window = $currentWindow'
  )
  const selectActive = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NOT NULL ORDER BY session_id'
  )
  const selectHibernating = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NULL AND is_pinned = 1 ORDER BY last_activity_at DESC, session_id'
  )
  const selectHistory = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NULL AND is_pinned = 0 ORDER BY last_activity_at DESC, session_id'
  )
  const selectHistoryRecent = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NULL AND is_pinned = 0 AND last_activity_at > $cutoff ORDER BY last_activity_at DESC, session_id'
  )
  const selectKnownSessionKeys = db.prepare(
    'SELECT session_id, log_file_path, project_path, slug, agent_type, is_codex_exec FROM agent_sessions'
  )
  const selectByDisplayName = db.prepare(
    'SELECT 1 FROM agent_sessions WHERE display_name = $displayName LIMIT 1'
  )
  const selectByDisplayNameExcluding = db.prepare(
    'SELECT 1 FROM agent_sessions WHERE display_name = $displayName AND session_id != $excludeSessionId LIMIT 1'
  )
  const selectActiveBySlugAndProject = db.prepare(
    'SELECT * FROM agent_sessions WHERE slug = $slug AND project_path = $projectPath AND current_window IS NOT NULL ORDER BY last_activity_at DESC LIMIT 1'
  )

  const updateStmt = (fields: string[]) =>
    db.prepare(
      `UPDATE agent_sessions SET ${fields
        .map((field) => `${field} = $${field}`)
        .join(', ')} WHERE session_id = $sessionId`
    )

  const claimWindowStmt = (fields: string[]) =>
    db.prepare(
      `UPDATE agent_sessions SET ${fields
        .map((field) => `${field} = $${field}`)
        .join(', ')} WHERE session_id = $sessionId
         AND current_window IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_sessions
           WHERE current_window = $current_window
             AND session_id != $sessionId
         )`
    )

  // App settings prepared statements
  const selectAppSetting = db.prepare(
    'SELECT value FROM app_settings WHERE key = $key'
  )
  const upsertAppSetting = db.prepare(
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES ($key, $value)'
  )
  const deleteAppSettingStmt = db.prepare(
    'DELETE FROM app_settings WHERE key = $key'
  )

  // Chat sessions prepared statements. The runtime columns are written at
  // call time (see insertChatSession): an eagerly prepared statement naming
  // them would refuse to open any database the codex-chat-runtime migration
  // has not reached yet — the migration tests' subset opens.
  const insertChatStmt = db.prepare(
    `INSERT INTO chat_sessions
      (session_id, name, project_path, sdk_session_id, profile_id, status, created_at, last_activity_at, approval_policy, name_source, group_id, task_id, spawned)
     VALUES ($sessionId, $name, $projectPath, $sdkSessionId, $profileId, $status, $createdAt, $lastActivityAt, $approvalPolicy, $nameSource, $groupId, $taskId, $spawned)`
  )
  // Call-time, not a named prepared statement, for the same subset-open reason.
  const setChatRuntimeSql =
    'UPDATE chat_sessions SET runtime = ?, codex_home = ? WHERE session_id = ?'
  const selectChatBySessionId = db.prepare(
    'SELECT * FROM chat_sessions WHERE session_id = $sessionId'
  )
  const selectAllChatSessions = db.prepare(
    'SELECT * FROM chat_sessions ORDER BY created_at, session_id'
  )
  const deleteChatStmt = db.prepare(
    'DELETE FROM chat_sessions WHERE session_id = $sessionId'
  )
  const updateChatStmt = (fields: string[]) =>
    db.prepare(
      `UPDATE chat_sessions SET ${fields
        .map((field) => `${field} = $${field}`)
        .join(', ')} WHERE session_id = $sessionId`
    )

  return {
    db,
    insertSession: (session) => {
      insertStmt.run({
        $sessionId: session.sessionId,
        $logFilePath: session.logFilePath,
        $projectPath: session.projectPath,
        $slug: session.slug ?? null,
        $agentType: session.agentType,
        $displayName: session.displayName,
        $createdAt: session.createdAt,
        $lastActivityAt: session.lastActivityAt,
        $lastUserMessage: clampLastUserMessage(session.lastUserMessage),
        $currentWindow: session.currentWindow,
        $isPinned: session.isPinned ? 1 : 0,
        $lastResumeError: session.lastResumeError,
        $wakeStartedAt: session.wakeStartedAt ?? null,
        $lastKnownLogSize: session.lastKnownLogSize,
        $isCodexExec: session.isCodexExec ? 1 : 0,
        $launchCommand: session.launchCommand ?? null,
      })
      const row = selectBySessionId.get({ $sessionId: session.sessionId }) as
        | Record<string, unknown>
        | undefined
      if (!row) {
        throw new Error('Failed to insert session')
      }
      return mapRow(row)
    },
    updateSession: (sessionId, patch) => {
      const entries = Object.entries(patch).filter(
        ([, value]) => value !== undefined
      ) as Array<[string, unknown]>
      if (entries.length === 0) {
        return (selectBySessionId.get({ $sessionId: sessionId }) as Record<string, unknown> | undefined)
          ? mapRow(selectBySessionId.get({ $sessionId: sessionId }) as Record<string, unknown>)
          : null
      }

      const fieldMap: Record<string, string> = {
        logFilePath: 'log_file_path',
        projectPath: 'project_path',
        slug: 'slug',
        agentType: 'agent_type',
        displayName: 'display_name',
        createdAt: 'created_at',
        lastActivityAt: 'last_activity_at',
        lastUserMessage: 'last_user_message',
        currentWindow: 'current_window',
        isPinned: 'is_pinned',
        lastResumeError: 'last_resume_error',
        wakeStartedAt: 'wake_started_at',
        lastKnownLogSize: 'last_known_log_size',
        isCodexExec: 'is_codex_exec',
        launchCommand: 'launch_command',
      }

      const fields: string[] = []
      const params: Record<string, string | number | null> = {
        $sessionId: sessionId,
      }
      for (const [key, value] of entries) {
        const field = fieldMap[key]
        if (!field) continue
        fields.push(field)
        // Normalize boolean fields to 0/1 for SQLite
        if (key === 'isPinned' || key === 'isCodexExec') {
          params[`$${field}`] = value ? 1 : 0
        } else if (key === 'lastUserMessage') {
          params[`$${field}`] = clampLastUserMessage(value as string | null)
        } else {
          params[`$${field}`] = value as string | number | null
        }
      }

      if (fields.length === 0) {
        return null
      }

      updateStmt(fields).run(params)
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    claimCurrentWindow: (sessionId, tmuxWindow, extraPatch) => {
      const fieldMap: Record<string, string> = {
        displayName: 'display_name',
        lastResumeError: 'last_resume_error',
        wakeStartedAt: 'wake_started_at',
        launchCommand: 'launch_command',
      }
      const fields = ['current_window']
      const params: Record<string, string | number | null> = {
        $sessionId: sessionId,
        $current_window: tmuxWindow,
      }
      if (extraPatch) {
        for (const [key, value] of Object.entries(extraPatch)) {
          if (value === undefined) continue
          const field = fieldMap[key]
          if (!field) continue
          fields.push(field)
          params[`$${field}`] = value as string | number | null
        }
      }
      const result = claimWindowStmt(fields).run(params)
      if (result.changes === 0) return null
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionById: (sessionId) => {
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionByLogPath: (logPath) => {
      const row = selectByLogPath.get({ $logFilePath: logPath }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionByWindow: (tmuxWindow) => {
      const row = selectByWindow.get({ $currentWindow: tmuxWindow }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getActiveSessions: () => {
      const rows = selectActive.all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    getHibernatingSessions: () => {
      const rows = selectHibernating.all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    getHistorySessions: (options?: { maxAgeHours?: number }) => {
      if (options?.maxAgeHours) {
        const cutoff = new Date(Date.now() - options.maxAgeHours * 60 * 60 * 1000).toISOString()
        const rows = selectHistoryRecent.all({ $cutoff: cutoff }) as Record<string, unknown>[]
        return rows.map(mapRow)
      }
      const rows = selectHistory.all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    getKnownSessionKeys: () => {
      const rows = selectKnownSessionKeys.all() as Record<string, unknown>[]
      return rows.map((row) => ({
        sessionId: row.session_id as string,
        logFilePath: row.log_file_path as string,
        projectPath: (row.project_path as string | null) ?? null,
        slug: (row.slug as string | null) ?? null,
        agentType: (row.agent_type as AgentType | null) ?? null,
        isCodexExec: Boolean(row.is_codex_exec),
      }))
    },
    orphanSession: (sessionId, options) => {
      const hibernate = options?.hibernate ?? true
      // Auto-promote to Hibernating on unexpected window loss. Deliberate kills
      // and explicit mismatch cleanup opt out so those rows still land in
      // History.
      updateStmt(['current_window', 'is_pinned']).run({
        $sessionId: sessionId,
        $current_window: null,
        $is_pinned: hibernate ? 1 : 0,
      })
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    displayNameExists: (displayName, excludeSessionId) => {
      const row = excludeSessionId
        ? selectByDisplayNameExcluding.get({
            $displayName: displayName,
            $excludeSessionId: excludeSessionId,
          })
        : selectByDisplayName.get({ $displayName: displayName })
      return row != null
    },
    setPinned: (sessionId, isPinned) => {
      updateStmt(['is_pinned']).run({
        $sessionId: sessionId,
        $is_pinned: isPinned ? 1 : 0,
      })
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getActiveSessionBySlugAndProject: (slug, projectPath) => {
      const row = selectActiveBySlugAndProject.get({
        $slug: slug,
        $projectPath: projectPath,
      }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    // App settings
    getAppSetting: (key) => {
      const row = selectAppSetting.get({ $key: key }) as
        | { value: string }
        | undefined
      return row?.value ?? null
    },
    setAppSetting: (key, value) => {
      upsertAppSetting.run({ $key: key, $value: value })
    },
    deleteAppSetting: (key) => {
      deleteAppSettingStmt.run({ $key: key })
    },
    // Chat sessions
    insertChatSession: (session) => {
      const insertRow = () =>
        insertChatStmt.run({
          $sessionId: session.sessionId,
          $name: session.name,
          $projectPath: session.projectPath,
          $sdkSessionId: session.sdkSessionId,
          $profileId: session.claudeProfileId ?? 'default',
          $status: session.status,
          $createdAt: session.createdAt,
          $lastActivityAt: session.lastActivityAt,
          $approvalPolicy: session.approvalPolicy ?? 'manual',
          $nameSource: session.nameSource ?? 'manual',
          $groupId: session.groupId ?? null,
          $taskId: session.taskId ?? null,
          $spawned: session.spawned ? 1 : 0,
        })
      // The runtime and, for Codex, the resolved home are fixed at creation
      // (codex-chat-sessions 3.3); the transcript path arrives later (§5).
      // Written at call time and only when the record carries them, so a
      // predecessor record (the migration tests) inserts without naming the
      // columns it predates. One transaction (N3): the facts land with the
      // row or not at all — a crash between INSERT and UPDATE must never
      // store a Codex chat as Claude.
      const runtime = session.runtime
      if (runtime !== undefined) {
        db.transaction(() => {
          insertRow()
          db.run(setChatRuntimeSql, [runtime, session.codexHome ?? null, session.sessionId])
        })()
      } else {
        insertRow()
      }
      return session
    },
    updateChatSession: (sessionId, patch) => {
      const fieldMap: Record<string, string> = {
        name: 'name',
        projectPath: 'project_path',
        sdkSessionId: 'sdk_session_id',
        claudeProfileId: 'profile_id',
        status: 'status',
        createdAt: 'created_at',
        lastActivityAt: 'last_activity_at',
        archivedAt: 'archived_at',
        approvalPolicy: 'approval_policy',
        nameSource: 'name_source',
        // group_id is deliberately absent: a session's group is fixed at
        // creation (agent-teams), so no patch can change it.
        taskId: 'task_id',
        model: 'model',
        // The Codex transcript path arrives whenever the driver's thread
        // reveals it (§5); runtime and codex_home are deliberately absent —
        // both are fixed at creation (codex-chat-sessions 3.3).
        transcriptPath: 'transcript_path',
      }
      const fields: string[] = []
      const params: Record<string, string | number | null> = {
        $sessionId: sessionId,
      }
      // The context reading is one value spread over five columns (design
      // D4); a null patch clears them together so no partial reading is ever
      // stored. `context_approx` records whether the threshold is a window
      // standing in for the real one (design D2 steps 2–3).
      if (patch.contextUsage !== undefined) {
        const usage = patch.contextUsage
        fields.push(
          'context_tokens',
          'context_threshold',
          'context_pct',
          'context_at',
          'context_approx'
        )
        params.$context_tokens = usage?.usedTokens ?? null
        params.$context_threshold = usage?.thresholdTokens ?? null
        params.$context_pct = usage?.percentage ?? null
        params.$context_at = usage?.at ?? null
        params.$context_approx = usage ? (usage.thresholdApproximate ? 1 : 0) : null
      }
      // The flag is one value over two columns; null clears both together.
      if (patch.contextExhausted !== undefined) {
        fields.push('context_exhausted_at', 'context_exhausted_reason')
        params.$context_exhausted_at = patch.contextExhausted?.at ?? null
        params.$context_exhausted_reason = patch.contextExhausted?.reason ?? null
      }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || key === 'contextUsage' || key === 'contextExhausted') continue
        const field = fieldMap[key]
        if (!field) continue
        fields.push(field)
        params[`$${field}`] = value as string | number | null
      }
      if (fields.length === 0) {
        const row = selectChatBySessionId.get({ $sessionId: sessionId }) as
          | Record<string, unknown>
          | undefined
        return row ? mapChatRow(row) : null
      }
      updateChatStmt(fields).run(params)
      const row = selectChatBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapChatRow(row) : null
    },
    deleteChatSession: (sessionId) => {
      const result = deleteChatStmt.run({ $sessionId: sessionId })
      return result.changes > 0
    },
    getChatSession: (sessionId) => {
      const row = selectChatBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapChatRow(row) : null
    },
    getChatSessions: () => {
      const rows = selectAllChatSessions.all() as Record<string, unknown>[]
      return rows.map(mapChatRow)
    },
    close: () => {
      backups?.stop()
      db.close()
    },
    backups,
  }
}

function ensureDataDir(dbPath: string) {
  if (dbPath === ':memory:') {
    return
  }

  const dir = path.dirname(dbPath)
  if (!dir) return

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Ignore mkdir failures; SQLite will surface errors when opening
  }

  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Ignore chmod failures
  }
}

function mapChatRow(row: Record<string, unknown>): ChatSessionRecord {
  return {
    sessionId: String(row.session_id ?? ''),
    claudeProfileId: String(row.profile_id ?? 'default'),
    name: String(row.name ?? ''),
    projectPath: String(row.project_path ?? ''),
    sdkSessionId:
      row.sdk_session_id === null || row.sdk_session_id === undefined
        ? null
        : String(row.sdk_session_id),
    status: (row.status ?? 'waiting') as ChatSessionRecord['status'],
    createdAt: String(row.created_at ?? ''),
    lastActivityAt: String(row.last_activity_at ?? ''),
    archivedAt:
      row.archived_at === null || row.archived_at === undefined
        ? null
        : String(row.archived_at),
    approvalPolicy: parseApprovalPolicy(row.approval_policy),
    nameSource: parseChatNameSource(row.name_source),
    contextUsage: mapContextUsage(row),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    groupId: row.group_id === null || row.group_id === undefined ? null : String(row.group_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    spawned: Number(row.spawned ?? 0) === 1,
    contextExhausted:
      typeof row.context_exhausted_at === 'string' && typeof row.context_exhausted_reason === 'string'
        ? { at: row.context_exhausted_at, reason: row.context_exhausted_reason }
        : null,
    // Chats created before runtimes existed restore as Claude (3.3).
    runtime: row.runtime === 'codex' ? 'codex' : 'claude',
    codexHome: row.codex_home === null || row.codex_home === undefined ? null : String(row.codex_home),
    transcriptPath:
      row.transcript_path === null || row.transcript_path === undefined
        ? null
        : String(row.transcript_path),
  }
}

/**
 * All five columns are written together (design D4), so a row missing any of
 * them is not a reading — return null rather than inventing a percentage or
 * timestamp (design D7). A `context_approx` of 1 marks a window standing in
 * for the threshold (design D2 steps 2–3).
 */
function mapContextUsage(row: Record<string, unknown>): ChatContextUsage | null {
  const used = row.context_tokens
  const threshold = row.context_threshold
  const pct = row.context_pct
  const at = row.context_at
  if (used === null || used === undefined) return null
  if (threshold === null || threshold === undefined) return null
  if (pct === null || pct === undefined) return null
  if (at === null || at === undefined) return null
  return {
    usedTokens: Number(used),
    thresholdTokens: Number(threshold),
    percentage: Number(pct),
    at: String(at),
    ...(row.context_approx === 1 ? { thresholdApproximate: true } : {}),
  }
}

/** Read a stored provenance value; anything absent or unknown reads as manual. */
function parseChatNameSource(value: unknown): ChatNameSource {
  return value === 'placeholder' || value === 'auto' ? value : 'manual'
}

function mapRow(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id ?? ''),
    logFilePath: String(row.log_file_path ?? ''),
    projectPath: String(row.project_path ?? ''),
    slug:
      row.slug === null || row.slug === undefined
        ? null
        : String(row.slug),
    agentType: row.agent_type as AgentType,
    displayName: String(row.display_name ?? ''),
    createdAt: String(row.created_at ?? ''),
    lastActivityAt: String(row.last_activity_at ?? ''),
    lastUserMessage:
      row.last_user_message === null || row.last_user_message === undefined
        ? null
        : String(row.last_user_message),
    currentWindow:
      row.current_window === null || row.current_window === undefined
        ? null
        : String(row.current_window),
    isPinned: Number(row.is_pinned) === 1,
    lastResumeError:
      row.last_resume_error === null || row.last_resume_error === undefined
        ? null
        : String(row.last_resume_error),
    wakeStartedAt:
      row.wake_started_at === null || row.wake_started_at === undefined
        ? null
        : String(row.wake_started_at),
    // Note: null lastKnownLogSize is treated as "unknown", triggering a match check
    // on first poll after upgrade. This is intentional (one-time cost).
    lastKnownLogSize:
      row.last_known_log_size === null || row.last_known_log_size === undefined
        ? null
        : Number(row.last_known_log_size),
    isCodexExec: Number(row.is_codex_exec) === 1,
    launchCommand:
      row.launch_command === null || row.launch_command === undefined
        ? null
        : String(row.launch_command),
  }
}
