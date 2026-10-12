// Server meta routes under `/api`: client log relay (`/client-log`), liveness
// (`/health`), and `/server-info` (port, Tailscale address, protocol, cwd,
// default project dir, build version, update state). Also owns Tailscale IP
// detection, which the composition root uses for the extra localhost bind.
import { Hono } from 'hono'
import { config } from '../config'
import { logger } from '../logger'
import { BUILD_VERSION } from '../version'
import type { UpdateChecker } from '../updates/updateChecker'

export function getTailscaleIp(): string | null {
  // Try common Tailscale CLI paths (standalone CLI, then Mac App Store bundle)
  const tailscalePaths = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ]

  for (const tsPath of tailscalePaths) {
    try {
      const result = Bun.spawnSync([tsPath, 'ip', '-4'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (result.exitCode === 0) {
        const ip = result.stdout.toString().trim()
        if (ip) return ip
      }
    } catch {
      // Try next path
    }
  }
  return null
}

export interface ServerInfoRouteDeps {
  /** Tailscale IP the server also bound to (localhost mode), else null. */
  getBoundTailscaleIp: () => string | null
  tlsEnabled: boolean
  updateChecker: UpdateChecker
}

export function createServerInfoRoutes(deps: ServerInfoRouteDeps) {
  const { getBoundTailscaleIp, tlsEnabled, updateChecker } = deps
  const routes = new Hono()

  routes.post('/client-log', async (c) => {
    try {
      const body = await c.req.json() as { level?: string; event: string; data?: Record<string, unknown> }
      const level = body.level === 'warn' || body.level === 'error' || body.level === 'info' ? body.level : 'debug'
      logger[level]('client_' + body.event, body.data)
    } catch {
      // ignore malformed
    }
    return c.json({ ok: true })
  })

  routes.get('/health', (c) => c.json({ ok: true }))

  routes.get('/server-info', (c) => {
    // For 0.0.0.0, detect Tailscale IP for display (already listening on all interfaces).
    // For localhost, only report if we successfully bound to the Tailscale IP.
    const tsIp = config.hostname === '0.0.0.0' ? getTailscaleIp() : getBoundTailscaleIp()
    return c.json({
      port: config.port,
      tailscaleIp: tsIp,
      protocol: tlsEnabled ? 'https' : 'http',
      // Working directory of the server process; the fallback default project
      // directory for new sessions.
      cwd: process.cwd(),
      // AGENTBOARD_PROJECT_DIR, when set: takes precedence over cwd as the
      // default project directory. An explicit browser setting still wins.
      defaultProjectDir: config.defaultProjectDir,
      // Build version of this server (see ./version), shown in the UI.
      version: BUILD_VERSION,
      // Update availability (see ./updates); `target` is null while current.
      update: updateChecker.getState(),
    })
  })

  return routes
}
