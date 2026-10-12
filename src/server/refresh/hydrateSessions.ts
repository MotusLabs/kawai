// Hydration of tmux windows with persisted agent-session records, plus the
// async window→log association verification that feeds it precomputed
// decisions at startup. The empty-input guard at the top of hydrate is a
// regression-tested mass-kill protection and must stay first.
import type { AgentSession, Session, ServerMessage, TerminalSession } from '../../shared/types'
import { toAgentSession } from '../agentSessions'
import { verifyWindowLogAssociationDetailedAsync } from '../logmatch'
import type { WindowLogVerificationResult } from '../logmatch'
import type { AgentSessionRecord } from '../db'
import { logger } from '../logger'
import type { SessionManager } from '../SessionManager'
import type { initDatabase } from '../db'

type SessionDatabase = ReturnType<typeof initDatabase>

interface VerificationDecision {
  verification: WindowLogVerificationResult
  nameMatches: boolean
  windowExists: boolean
}

export interface HydrateSessionsOptions {
  precomputedVerifications?: Map<string, VerificationDecision>
}

/** Dependencies hydrateSessionsWithAgentSessions closes over. */
export interface HydrateSessionsDeps {
  db: SessionDatabase
  sessionManager: SessionManager
  broadcast: (message: ServerMessage) => void
  updateDormantAgentSessions: () => void
  updateActiveAgentSessions: () => void
}

export async function verifyAllSessions(
  activeSessions: AgentSessionRecord[],
  sessions: Session[],
  logDirs: string[]
): Promise<Map<string, VerificationDecision>> {
  const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
  const windowByTarget = new Map(sessions.map((session) => [session.tmuxWindow, session]))
  const allLogPaths = activeSessions
    .filter((session) => session.currentWindow)
    .map((session) => ({ sessionId: session.sessionId, logPath: session.logFilePath }))

  const entries: Array<[string, VerificationDecision]> = await Promise.all(
    activeSessions.map(async (agentSession): Promise<[string, VerificationDecision]> => {
      const currentWindow = agentSession.currentWindow
      if (!currentWindow || !windowSet.has(currentWindow)) {
        const decision: VerificationDecision = {
          verification: {
            status: 'inconclusive',
            bestMatch: null,
            reason: 'no_match',
          },
          nameMatches: false,
          windowExists: false,
        }
        return [agentSession.sessionId, decision]
      }

      const excludeLogPaths = allLogPaths
        .filter((entry) => entry.sessionId !== agentSession.sessionId)
        .map((entry) => entry.logPath)

      try {
        const verification = await verifyWindowLogAssociationDetailedAsync(
          currentWindow,
          agentSession.logFilePath,
          logDirs,
          {
            context: {
              agentType: agentSession.agentType,
              projectPath: agentSession.projectPath,
            },
            excludeLogPaths,
          }
        )
        const window = windowByTarget.get(currentWindow)
        const nameMatches = Boolean(window && window.name === agentSession.displayName)
        const decision: VerificationDecision = {
          verification,
          nameMatches,
          windowExists: true,
        }
        return [agentSession.sessionId, decision]
      } catch (error) {
        logger.warn('session_verification_error', {
          sessionId: agentSession.sessionId,
          error: String(error),
        })
        const decision: VerificationDecision = {
          verification: { status: 'verified', bestMatch: null },
          nameMatches: true,
          windowExists: true,
        }
        return [agentSession.sessionId, decision]
      }
    })
  )

  return new Map(entries)
}

export function hydrateSessionsWithAgentSessions(
  deps: HydrateSessionsDeps,
  sessions: TerminalSession[],
  { precomputedVerifications }: HydrateSessionsOptions = {}
): Session[] {
  const activeSessions = deps.db.getActiveSessions()
  // Sanity guard: callers ultimately source `sessions` from a tmux query (e.g.
  // sessionRefreshWorker.refresh or listWindowsSyncOrNull). When that query
  // transiently returns an empty array — but the DB still tracks live
  // sessions — every active session would fail the windowSet membership check
  // below and be treated as orphaned, which then triggers
  // sessionManager.killWindow() for each. That mass-kills the user's working
  // tmux windows in one pass. Skip this cycle and let the next refresh
  // observe a real state. completeStartupVerification() already applies an
  // equivalent guard before hydrating.
  if (activeSessions.length > 0 && sessions.length === 0) {
    logger.warn('hydrate_sessions_skipped_empty_input', {
      activeSessionCount: activeSessions.length,
    })
    return sessions
  }
  const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
  const activeMap = new Map<string, typeof activeSessions[number]>()
  const orphaned: AgentSession[] = []

  for (const agentSession of activeSessions) {
    const precomputed = precomputedVerifications?.get(agentSession.sessionId)
    const currentWindow = agentSession.currentWindow
    const windowExists = precomputed
      ? precomputed.windowExists
      : Boolean(currentWindow && windowSet.has(currentWindow))

    if (!windowExists || !currentWindow) {
      logger.info('session_orphaned', {
        sessionId: agentSession.sessionId,
        displayName: agentSession.displayName,
        currentWindow: agentSession.currentWindow,
        windowSetSize: windowSet.size,
        windowSetSample: Array.from(windowSet).slice(0, 5),
      })
      // Kill any leftover dead window from remain-on-exit
      if (currentWindow) {
        try { deps.sessionManager.killWindow(currentWindow) } catch { /* may already be gone */ }
      }
      const orphanedSession = deps.db.orphanSession(agentSession.sessionId)
      if (orphanedSession) {
        orphaned.push(toAgentSession(orphanedSession))
      }
      continue
    }

    let verification: WindowLogVerificationResult | null = null
    let nameMatches = false

    if (precomputed) {
      verification = precomputed.verification
      nameMatches = precomputed.nameMatches
    }

    if (verification) {
      let shouldOrphan = false
      let fallbackUsed = false

      if (verification.status === 'verified') {
        shouldOrphan = false
      } else if (nameMatches) {
        shouldOrphan = false
        fallbackUsed = true
      } else {
        shouldOrphan = true
      }

      if (shouldOrphan) {
        logger.info('session_verification_failed', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow,
          logFilePath: agentSession.logFilePath,
          verificationStatus: verification.status,
          verificationReason: verification.reason ?? null,
          nameMatches,
          bestMatchLog: verification.bestMatch?.logPath ?? null,
        })
        const orphanedSession = deps.db.orphanSession(agentSession.sessionId, {
          hibernate: false,
        })
        if (orphanedSession) {
          orphaned.push(toAgentSession(orphanedSession))
        }
        continue
      }

      if (fallbackUsed) {
        logger.info('session_verification_name_fallback', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow,
          verificationStatus: verification.status,
        })
      }
    }

    activeMap.set(currentWindow, agentSession)
  }

  const hydrated = sessions.map((session) => {
    const agentSession = activeMap.get(session.tmuxWindow)
    if (!agentSession) {
      return session
    }
    if (agentSession.displayName !== session.name) {
      deps.db.updateSession(agentSession.sessionId, { displayName: session.name })
      agentSession.displayName = session.name
    }
    return {
      ...session,
      // Use log-based agentType if command-based detection failed
      agentType: session.agentType ?? agentSession.agentType,
      agentSessionId: agentSession.sessionId,
      agentSessionName: agentSession.displayName,
      logFilePath: agentSession.logFilePath,
      lastUserMessage: agentSession.lastUserMessage ?? session.lastUserMessage,
      // Use persisted log times (survives server restarts, works when tmux lacks creation time)
      lastActivity: agentSession.lastActivityAt,
      createdAt: agentSession.createdAt,
      isPinned: agentSession.isPinned,
    }
  })

  if (orphaned.length > 0) {
    for (const session of orphaned) {
      deps.broadcast({ type: 'session-orphaned', session })
    }
    deps.updateDormantAgentSessions()
  } else {
    deps.updateActiveAgentSessions()
  }
  return hydrated
}
