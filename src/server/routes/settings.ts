// Settings routes (`/api/settings/*`): tmux mouse mode, terminal colors,
// prefer-window-name, and the history max age (plus its `inactive-` alias),
// together with the boot-time read of their persisted values. Each PUT keeps
// the runtime value and the stored value in step: a failed persist rolls the
// runtime change back. The chat provider env route stays in chatProviderEnv.
import { Hono, type Context } from 'hono'
import { config } from '../config'
import { logger, logLevel } from '../logger'
import { TmuxTimeoutError } from '../tmuxTimeout'
import {
  HISTORY_MAX_AGE_MIN_HOURS,
  HISTORY_MAX_AGE_MAX_HOURS,
  QUESTION_AUTO_ANSWER_MIN_MINUTES,
  QUESTION_AUTO_ANSWER_MAX_MINUTES,
  QUESTION_AUTO_ANSWER_DEFAULT_MINUTES,
  type ServerMessage,
} from '../../shared/types'
import { parseQuestionAutoAnswerMinutes } from '../../shared/chatQuestionAutoAnswer'
import type { initDatabase } from '../db'
import type { SessionManager } from '../SessionManager'
import type { SessionRefreshLoop } from '../refresh/SessionRefreshLoop'

type SessionDatabase = ReturnType<typeof initDatabase>

const TMUX_MOUSE_MODE_KEY = 'tmux_mouse_mode'
// Keep the DB key stable so existing settings survive the rename from
// Inactive to History.
const HISTORY_MAX_AGE_HOURS_KEY = 'inactive_max_age_hours'
const PREFER_WINDOW_NAME_KEY = 'prefer_window_name'
const TERMINAL_COLORS_ENABLED_KEY = 'terminal_colors_enabled'
const QUESTION_AUTO_ANSWER_MINUTES_KEY = 'question_auto_answer_minutes'

/** Stored booleans are the strings 'true'/'false'; null when never saved. */
function readStoredBoolean(db: SessionDatabase, key: string): boolean | null {
  const stored = db.getAppSetting(key)
  return stored === null ? null : stored === 'true'
}

export interface StoredSettings {
  /** Tmux mouse mode for the SessionManager (default: true). */
  initialMouseMode: boolean
  /** Starting runtime history max age, in hours. */
  historyMaxAgeHours: number
  /** Starting auto-answer wait for recommended questions, in minutes. */
  questionAutoAnswerMinutes: number
}

/**
 * Read the persisted settings at boot. Prefer-window-name and terminal colors
 * are folded straight into `config` (their env vars are only the initial
 * default; once saved from the UI the stored value wins).
 */
export function loadStoredSettings(db: SessionDatabase): StoredSettings {
  // Mouse mode (default: true).
  const initialMouseMode = readStoredBoolean(db, TMUX_MOUSE_MODE_KEY) ?? true

  // History max age hours (default: 24).
  const storedHistoryMaxAgeHours = db.getAppSetting(HISTORY_MAX_AGE_HOURS_KEY)
  let historyMaxAgeHours = storedHistoryMaxAgeHours !== null
    ? Number(storedHistoryMaxAgeHours)
    : config.historySessionMaxAgeHours
  if (!Number.isFinite(historyMaxAgeHours) || historyMaxAgeHours < 1) {
    historyMaxAgeHours = 24
  }

  // Question auto-answer wait (default: 5; 0 disables the deadline). A stored
  // value that fails today's validation reads as the default, like history's.
  const storedQuestionAutoAnswerMinutes = db.getAppSetting(QUESTION_AUTO_ANSWER_MINUTES_KEY)
  let questionAutoAnswerMinutes = storedQuestionAutoAnswerMinutes !== null
    ? Number(storedQuestionAutoAnswerMinutes)
    : QUESTION_AUTO_ANSWER_DEFAULT_MINUTES
  if (
    !Number.isInteger(questionAutoAnswerMinutes) ||
    questionAutoAnswerMinutes < QUESTION_AUTO_ANSWER_MIN_MINUTES ||
    questionAutoAnswerMinutes > QUESTION_AUTO_ANSWER_MAX_MINUTES
  ) {
    questionAutoAnswerMinutes = QUESTION_AUTO_ANSWER_DEFAULT_MINUTES
  }

  // Prefer window name: AGENTBOARD_PREFER_WINDOW_NAME (already folded into
  // config) is only the initial default.
  const preferWindowName = readStoredBoolean(db, PREFER_WINDOW_NAME_KEY)
  if (preferWindowName !== null) {
    config.preferWindowName = preferWindowName
  }

  // Global terminal colors: enabled by default so an ambient NO_COLOR on the
  // Agentboard process does not flatten every managed terminal.
  const terminalColorsEnabled = readStoredBoolean(db, TERMINAL_COLORS_ENABLED_KEY)
  if (terminalColorsEnabled !== null) {
    config.terminalColorsEnabled = terminalColorsEnabled
  }

  return { initialMouseMode, historyMaxAgeHours, questionAutoAnswerMinutes }
}

export interface SettingsRouteDeps {
  db: SessionDatabase
  sessionManager: SessionManager
  refresh: SessionRefreshLoop
  broadcast: (message: ServerMessage) => void
  /** Runtime history max age, shared with the refresh loop. */
  historyMaxAgeHours: { get: () => number; set: (hours: number) => void }
  /** Runtime question auto-answer wait in minutes, shared with the chat manager. */
  questionAutoAnswerMinutes: { get: () => number; set: (minutes: number) => void }
}

export function createSettingsRoutes(deps: SettingsRouteDeps) {
  const { db, sessionManager, refresh, broadcast, historyMaxAgeHours, questionAutoAnswerMinutes } = deps
  const routes = new Hono()

  // Tmux mouse mode setting
  routes.get('/tmux-mouse-mode', (c) => {
    const enabled = readStoredBoolean(db, TMUX_MOUSE_MODE_KEY) ?? true
    return c.json({ enabled })
  })

  routes.put('/tmux-mouse-mode', async (c) => {
    let body: { enabled?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400)
    }

    const previousEnabled = readStoredBoolean(db, TMUX_MOUSE_MODE_KEY) ?? true

    try {
      sessionManager.setMouseMode(body.enabled)
    } catch (error) {
      if (error instanceof TmuxTimeoutError) {
        return c.json({ error: 'Timed out applying tmux mouse mode' }, 504)
      }
      logger.warn('tmux_mouse_mode_update_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Unable to apply tmux mouse mode' }, 500)
    }

    try {
      db.setAppSetting(TMUX_MOUSE_MODE_KEY, String(body.enabled))
    } catch (error) {
      logger.warn('tmux_mouse_mode_persist_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      try {
        sessionManager.setMouseMode(previousEnabled)
      } catch (rollbackError) {
        logger.warn('tmux_mouse_mode_rollback_failed', {
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        })
      }
      return c.json({ error: 'Unable to persist tmux mouse mode' }, 500)
    }

    return c.json({ enabled: body.enabled })
  })

  // Terminal ANSI color setting
  routes.get('/terminal-colors', (c) => {
    return c.json({ enabled: config.terminalColorsEnabled })
  })

  routes.put('/terminal-colors', async (c) => {
    let body: { enabled?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400)
    }

    const previousValue = config.terminalColorsEnabled
    try {
      sessionManager.setTerminalColors(body.enabled)
    } catch (error) {
      if (error instanceof TmuxTimeoutError) {
        return c.json({ error: 'Timed out applying terminal colors' }, 504)
      }
      logger.warn('terminal_colors_update_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Unable to apply terminal colors' }, 500)
    }

    config.terminalColorsEnabled = body.enabled
    try {
      db.setAppSetting(TERMINAL_COLORS_ENABLED_KEY, String(body.enabled))
    } catch (error) {
      config.terminalColorsEnabled = previousValue
      logger.warn('terminal_colors_persist_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      try {
        sessionManager.setTerminalColors(previousValue)
      } catch (rollbackError) {
        logger.warn('terminal_colors_rollback_failed', {
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        })
      }
      return c.json({ error: 'Unable to persist terminal colors' }, 500)
    }

    return c.json({ enabled: body.enabled })
  })

  routes.get('/prefer-window-name', (c) => {
    return c.json({ enabled: config.preferWindowName })
  })

  routes.put('/prefer-window-name', async (c) => {
    let body: { enabled?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400)
    }

    const previousValue = config.preferWindowName
    config.preferWindowName = body.enabled
    try {
      db.setAppSetting(PREFER_WINDOW_NAME_KEY, String(body.enabled))
    } catch (error) {
      // Same contract as tmux-mouse-mode: never leave the runtime value
      // diverging from what will be restored after a restart.
      config.preferWindowName = previousValue
      logger.warn('prefer_window_name_persist_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Unable to persist prefer window name' }, 500)
    }
    // Connected clients keep their own copy from the open-time server-config
    // message (mobile tab labels read it); rebroadcast so they all converge.
    broadcast({
      type: 'server-config',
      remoteAllowControl: config.remoteAllowControl,
      remoteAllowAttach: config.remoteAllowAttach,
      hostLabel: config.hostLabel,
      preferWindowName: config.preferWindowName,
      clientLogLevel: logLevel,
    })
    // Names are recomputed on refresh; schedule one so the sidebar updates
    // promptly instead of waiting for the next poll tick.
    refresh.scheduleEnterRefresh()
    return c.json({ enabled: body.enabled })
  })

  // History sessions max age setting. The inactive route is kept as a
  // compatibility alias for older clients.
  const getHistoryMaxAgeHours = (c: Context) => {
    return c.json({ hours: historyMaxAgeHours.get() })
  }

  const putHistoryMaxAgeHours = async (c: Context) => {
    try {
      const body = await c.req.json()
      const hours = Number(body.hours)
      if (!Number.isFinite(hours) || hours < HISTORY_MAX_AGE_MIN_HOURS || hours > HISTORY_MAX_AGE_MAX_HOURS) {
        return c.json({ error: `hours must be a number between ${HISTORY_MAX_AGE_MIN_HOURS} and ${HISTORY_MAX_AGE_MAX_HOURS}` }, 400)
      }
      historyMaxAgeHours.set(hours)
      db.setAppSetting(HISTORY_MAX_AGE_HOURS_KEY, String(hours))
      // Re-broadcast agent sessions with new max age
      refresh.updateDormantAgentSessions()
      return c.json({ hours })
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }
  }

  routes.get('/history-max-age-hours', getHistoryMaxAgeHours)
  routes.put('/history-max-age-hours', putHistoryMaxAgeHours)
  routes.get('/inactive-max-age-hours', getHistoryMaxAgeHours)
  routes.put('/inactive-max-age-hours', putHistoryMaxAgeHours)

  // Question auto-answer wait (question-auto-answer D5): the deadline a fully
  // recommended question gets, in whole minutes; 0 disables. Persist-then-
  // apply: a failed persist leaves the runtime value untouched, so it never
  // diverges from what a restart will read.
  routes.get('/question-auto-answer', (c) => {
    return c.json({ minutes: questionAutoAnswerMinutes.get() })
  })

  routes.put('/question-auto-answer', async (c) => {
    let body: { minutes?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }
    const parsed = parseQuestionAutoAnswerMinutes(body.minutes)
    if (!parsed.valid) {
      return c.json({ error: parsed.error }, 400)
    }
    const minutes = parsed.minutes
    try {
      db.setAppSetting(QUESTION_AUTO_ANSWER_MINUTES_KEY, String(minutes))
    } catch (error) {
      logger.warn('question_auto_answer_minutes_persist_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'Unable to persist question auto-answer wait' }, 500)
    }
    questionAutoAnswerMinutes.set(minutes)
    broadcast({ type: 'question-auto-answer-changed', minutes })
    return c.json({ minutes })
  })

  return routes
}
