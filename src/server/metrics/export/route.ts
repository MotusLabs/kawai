// Optional same-listener `/metrics` export (process-observability D9): on
// only when KAWAI_METRICS_ENABLED is `true` and KAWAI_METRICS_TOKEN is a
// whitespace-free bearer token; any other configuration disables it with a
// log line. Authorization (constant-time) precedes snapshot access.
import type { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { logger } from '../../logger'
import type { ProcessObservationService } from '../observations/service'
import { MetricsSnapshot } from './snapshot'

export function registerMetricsRoute(
  app: Hono,
  service: ProcessObservationService,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const enabled = env.KAWAI_METRICS_ENABLED
  const token = env.KAWAI_METRICS_TOKEN
  if (enabled !== 'true') {
    if (enabled && enabled !== 'false') logger.warn('metrics_export_disabled_invalid_configuration')
    return false
  }
  if (!token || token.trim() !== token || /\s/.test(token)) {
    logger.warn('metrics_export_disabled_missing_or_invalid_token')
    return false
  }
  const expected = Buffer.from(`Bearer ${token}`)
  const snapshot = new MetricsSnapshot(service)
  app.get('/metrics', c => {
    const received = Buffer.from(c.req.header('Authorization') ?? '')
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' })
    }
    try {
      return c.body(snapshot.read(), 200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      })
    } catch {
      logger.warn('metrics_export_snapshot_failed')
      return c.text('Metrics temporarily unavailable', 503, { 'Cache-Control': 'no-store' })
    }
  })
  return true
}
