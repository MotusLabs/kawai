// Update install route (`POST /api/update/install`), the update verb (see
// ../updates): verify → download → swap → restart, driven from the discovery
// state the chip was rendered against. Refusals fail closed with the named
// error and leave the install unchanged.
import { Hono } from 'hono'
import { logger } from '../logger'
import type { UpdateChecker } from '../updates/updateChecker'
import { installUpdate } from '../updates/updateInstaller'
import { detectRestartContext, restartAfterInstall } from '../updates/updateRestart'

const UPDATE_RESTART_DELAY_MS = 500

export interface UpdateInstallRouteDeps {
  updateChecker: UpdateChecker
}

export function createUpdateInstallRoutes(deps: UpdateInstallRouteDeps) {
  const { updateChecker } = deps
  const routes = new Hono()

  routes.post('/install', async (c) => {
    const release = updateChecker.getRelease()
    if (updateChecker.getState().target === null || release === null) {
      return c.json({ error: 'No update is currently available' }, 409)
    }
    let install
    try {
      install = await installUpdate({ release })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      logger.error('update_install_refused', { message, tag: release.tag })
      return c.json({ error: message }, 500)
    }
    // Respond first: the restart verb may terminate this process (that is its
    // job), and the client must hear the outcome before the connection drops.
    // A source run restarts onto the installed release binary, not this
    // process; under systemd the unit itself is adopted into that install —
    // see restartAfterInstall.
    const context = detectRestartContext()
    const restartTimer = setTimeout(() => {
      void restartAfterInstall(context, install).catch((cause) => {
        // The install landed; only the takeover failed. Keep serving the old
        // build and log loudly — a manual restart picks up the new files.
        logger.error('update_restart_failed', {
          message: cause instanceof Error ? cause.message : String(cause),
          mode: context.mode,
        })
      })
    }, UPDATE_RESTART_DELAY_MS)
    restartTimer.unref?.()
    return c.json({ ok: true, restarting: true })
  })

  return routes
}
