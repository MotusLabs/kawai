// The session manager's join of drivers it stopped (task 6.1, A5). Archive,
// kill, discard and server shutdown forget a driver at once, but a driver
// with owned work (the package adapters' settled()) still has a terminal
// teardown and callbacks in flight. Each retired driver's settled() is
// joined here, from the manager (outside any package callback), and its raw
// failure is logged once with the session id; retiredSettled() resolves when
// every retired driver settled and lists the failures not yet listed.
// Drivers without settled() (the old in-tree runtimes) need no join.
import { logger } from '../logger'
import type { ChatAgentDriver } from './provider/driver'

export interface RetiredFailure {
  sessionId: string
  error: unknown
}

export class RetiredDrivers {
  private readonly live = new Set<Promise<void>>()
  private readonly failures: RetiredFailure[] = []
  private listed = 0

  /** Join a driver the manager just stopped. */
  retire(sessionId: string, driver: ChatAgentDriver): void {
    const settled = driver.settled?.()
    if (!settled) return
    const joined = settled.then(
      () => undefined,
      (error: unknown) => {
        this.failures.push({ sessionId, error })
        logger.warn('chat_driver_terminal_failure', { sessionId, error: error instanceof Error ? error.message : String(error) })
      },
    )
    this.live.add(joined)
    void joined.finally(() => this.live.delete(joined))
  }

  /** Every retired driver settled; the raw failures not listed by an earlier call, oldest first. */
  async settled(): Promise<RetiredFailure[]> {
    while (this.live.size > 0) await Promise.allSettled([...this.live])
    const fresh = this.failures.slice(this.listed)
    this.listed = this.failures.length
    return fresh
  }
}
