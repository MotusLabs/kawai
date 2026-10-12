// Session preview route (`/api/session-preview/:sessionId`): a paged window
// of a session's log lines for the history/preview pane, read through the
// line-offset cache in ../logContent. `limit` is clamped to 1..500 (default
// 200); `beforeLine`/`beforeByte` page backwards from the newest window.
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import type { initDatabase } from '../db'
import { readLogLineWindow } from '../logContent'
import { isValidSessionId } from '../validators'

type SessionDatabase = ReturnType<typeof initDatabase>

export interface SessionPreviewRouteDeps {
  db: SessionDatabase
}

export function createSessionPreviewRoutes(deps: SessionPreviewRouteDeps) {
  const { db } = deps
  const routes = new Hono()

  routes.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'Invalid session id' }, 400)
    }

    const DEFAULT_LIMIT = 200
    const MAX_LIMIT = 500
    // Treat a missing OR empty `?limit=` as absent — `'' ?? DEFAULT` keeps '', and
    // Number('') is 0, which would otherwise collapse the window to a single line.
    const limitQuery = c.req.query('limit')
    const rawLimit = limitQuery === undefined || limitQuery === ''
      ? DEFAULT_LIMIT
      : Number(limitQuery)
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
      : DEFAULT_LIMIT

    const record = db.getSessionById(sessionId)
    if (!record) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const logPath = record.logFilePath
    if (!logPath) {
      return c.json({ error: 'No log file for session' }, 404)
    }

    try {
      const stats = await fs.stat(logPath)
      if (!stats.isFile()) {
        return c.json({ error: 'Log file not found' }, 404)
      }

      const beforeLineQuery = c.req.query('beforeLine')
      // Missing or empty means "latest window"; a non-numeric value falls back to
      // the same (selectLineWindow treats a non-finite cursor as the end).
      const rawBeforeLine = beforeLineQuery === undefined || beforeLineQuery === ''
        ? Number.POSITIVE_INFINITY
        : Number(beforeLineQuery)
      const beforeByteQuery = c.req.query('beforeByte')
      const rawBeforeByte = beforeByteQuery === undefined || beforeByteQuery === ''
        ? undefined
        : Number(beforeByteQuery)
      const beforeByte = rawBeforeByte !== undefined && Number.isFinite(rawBeforeByte)
        ? Math.max(0, Math.trunc(rawBeforeByte))
        : undefined
      const lineWindow = await readLogLineWindow(
        logPath,
        stats,
        limit,
        rawBeforeLine,
        beforeByte
      )

      return c.json({
        sessionId,
        displayName: record.displayName,
        projectPath: record.projectPath,
        agentType: record.agentType,
        lastActivityAt: record.lastActivityAt,
        ...lineWindow,
      })
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        return c.json({ error: 'Log file not found' }, 404)
      }
      return c.json({ error: 'Unable to read log file' }, 500)
    }
  })

  return routes
}
