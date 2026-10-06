import { EventEmitter } from 'node:events'
import type { AgentSession, Session } from '../shared/types'
import { activityInSameBucket } from '../shared/activityBucket'

export interface RegistryEvents {
  sessions: (sessions: Session[]) => void
  'session-update': (session: Session) => void
  'session-removed': (sessionId: string) => void
  'agent-sessions': (payload: { active: AgentSession[]; hibernating: AgentSession[]; history: AgentSession[] }) => void
  'agent-sessions-active': (active: AgentSession[]) => void
}

export class SessionRegistry extends EventEmitter {
  private sessions: Map<string, Session>
  // Chat sessions live outside tmux discovery, so replaceSessions() (which
  // rebuilds `sessions` from a tmux listing) must never touch them. Kept in a
  // separate map so a tmux refresh can't drop a live chat session.
  private chatSessions: Map<string, Session>
  private agentSessions: { active: AgentSession[]; hibernating: AgentSession[]; history: AgentSession[] }

  constructor() {
    super()
    this.sessions = new Map<string, Session>()
    this.chatSessions = new Map<string, Session>()
    this.agentSessions = { active: [], hibernating: [], history: [] }
  }

  getAll(): Session[] {
    return [...this.sessions.values(), ...this.chatSessions.values()]
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId) ?? this.chatSessions.get(sessionId)
  }

  /** Register or replace a chat session (not affected by tmux discovery). */
  setChatSession(session: Session): void {
    this.chatSessions.set(session.id, session)
    this.emit('sessions', this.getAll())
  }

  /** Remove a chat session; returns true when it existed. */
  removeChatSession(sessionId: string): boolean {
    const removed = this.chatSessions.delete(sessionId)
    if (removed) {
      this.emit('sessions', this.getAll())
    }
    return removed
  }

  replaceSessions(nextSessions: Session[]): void {
    // Callers thread registry.getAll() back in when composing the next tmux
    // world (e.g. session-create prepends the new window); chat sessions ride
    // along in that list. They are owned by the chat map, never by this
    // refresh, so drop them before diffing the tmux world.
    const tmuxNext = nextSessions.filter((session) => session.kind !== 'chat')
    const nextMap = new Map<string, Session>()

    for (const session of tmuxNext) {
      const existing = this.sessions.get(session.id)
      const nextLastActivity = pickLatestActivity(
        existing?.lastActivity,
        session.lastActivity
      )
      // Preserve createdAt from existing session, or use incoming/current time
      const createdAt =
        existing?.createdAt || session.createdAt || new Date().toISOString()
      nextMap.set(session.id, {
        ...session,
        lastActivity: nextLastActivity,
        createdAt,
      })
    }

    const removedIds = new Set(this.sessions.keys())
    for (const id of nextMap.keys()) {
      removedIds.delete(id)
    }

    // Check if anything actually changed. Activity timestamps are compared in
    // 30s buckets (design D5): steady output churn advances lastActivity on
    // every refresh, which otherwise re-broadcast the full session list (and
    // re-rendered the whole UI) each cycle. Stored/emitted timestamps keep
    // full precision — only change detection quantizes.
    const hasChanges =
      removedIds.size > 0 ||
      nextMap.size !== this.sessions.size ||
      Array.from(nextMap.values()).some((next) => {
        const existing = this.sessions.get(next.id)
        return !existing || !sessionsEqualForBroadcast(existing, next)
      })

    this.sessions = nextMap

    if (hasChanges) {
      this.emit('sessions', this.getAll())
    }

    for (const id of removedIds) {
      this.emit('session-removed', id)
    }
  }

  updateSession(sessionId: string, updates: Partial<Session>): Session | undefined {
    const current = this.sessions.get(sessionId) ?? this.chatSessions.get(sessionId)
    if (!current) {
      return undefined
    }

    const updated = {
      ...current,
      ...updates,
    }

    if (this.chatSessions.has(sessionId)) {
      this.chatSessions.set(sessionId, updated)
    } else {
      this.sessions.set(sessionId, updated)
    }
    this.emit('session-update', updated)
    return updated
  }

  getAgentSessions(): { active: AgentSession[]; hibernating: AgentSession[]; history: AgentSession[] } {
    return this.agentSessions
  }

  setAgentSessions(active: AgentSession[], hibernating: AgentSession[], history: AgentSession[]): void {
    const prev = this.agentSessions
    const activeChanged =
      active.length !== prev.active.length ||
      !active.every((a, i) => agentSessionsEqual(a, prev.active[i]))
    const hibernatingChanged =
      hibernating.length !== prev.hibernating.length ||
      !hibernating.every((a, i) => agentSessionsEqual(a, prev.hibernating[i]))
    const historyChanged =
      history.length !== prev.history.length ||
      !history.every((a, i) => agentSessionsEqual(a, prev.history[i]))

    if (!activeChanged && !hibernatingChanged && !historyChanged) return

    this.agentSessions = { active, hibernating, history }

    // Always send the lightweight active-only update
    if (activeChanged) {
      this.emit('agent-sessions-active', active)
    }
    // Only send the full payload when hibernating or history sessions changed.
    if (hibernatingChanged || historyChanged) {
      this.emit('agent-sessions', this.agentSessions)
    }
  }
}

function pickLatestActivity(
  existing: string | undefined,
  incoming: string
): string {
  if (!existing) {
    return incoming
  }

  const existingTime = Date.parse(existing)
  const incomingTime = Date.parse(incoming)

  if (Number.isNaN(existingTime) && Number.isNaN(incomingTime)) {
    return incoming
  }
  if (Number.isNaN(existingTime)) {
    return incoming
  }
  if (Number.isNaN(incomingTime)) {
    return existing
  }

  return incomingTime > existingTime ? incoming : existing
}

function agentSessionsEqual(a: AgentSession, b: AgentSession): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.logFilePath === b.logFilePath &&
    a.projectPath === b.projectPath &&
    a.agentType === b.agentType &&
    a.displayName === b.displayName &&
    a.createdAt === b.createdAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.isActive === b.isActive &&
    a.host === b.host &&
    a.lastUserMessage === b.lastUserMessage &&
    a.isPinned === b.isPinned &&
    a.lastResumeError === b.lastResumeError
  )
}

/**
 * Same-field equality as sessionsEqual, except lastActivity compares by 30s
 * bucket (shared activityBucket helper, design D5). Invalid (unparseable)
 * timestamps fall back to raw string equality, preserving the previous
 * behavior for malformed values.
 */
export function sessionsEqualForBroadcast(a: Session, b: Session): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.claudeProfileId === b.claudeProfileId &&
    a.tmuxWindow === b.tmuxWindow &&
    a.status === b.status &&
    activityInSameBucket(a.lastActivity, b.lastActivity) &&
    a.projectPath === b.projectPath &&
    a.source === b.source &&
    a.agentType === b.agentType &&
    a.command === b.command &&
    a.agentSessionId === b.agentSessionId &&
    a.agentSessionName === b.agentSessionName &&
    a.logFilePath === b.logFilePath &&
    a.lastUserMessage === b.lastUserMessage &&
    a.isPinned === b.isPinned &&
    a.host === b.host &&
    a.remote === b.remote &&
    a.archivedAt === b.archivedAt
  )
}
