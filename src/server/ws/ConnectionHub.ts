// WebSocket connection hub: the set of open sockets plus the broadcast/send
// primitives every server module uses to reach clients, the registry ->
// broadcast wiring, and the connection-id/fire-and-forget helpers. `send`
// routes terminal output through the per-connection coalescer and drains it
// before any other message, so ordering holds across both paths; `broadcast`
// drains every socket's pending output first for the same reason.
import type { ServerWebSocket } from 'bun'
import { logger } from '../logger'
import type { ServerMessage } from '../../shared/types'
import type { SessionRegistry } from '../SessionRegistry'
import type { WSData } from './wsTypes'

export class ConnectionHub {
  /** Open sockets; `sockets.has(ws)` is the authoritative open predicate. */
  readonly sockets = new Set<ServerWebSocket<WSData>>()

  readonly broadcast = (message: ServerMessage): void => {
    const payload = JSON.stringify(message)
    for (const socket of this.sockets) {
      // Drain pending terminal output first so a broadcast cannot overtake
      // output already queued for that connection.
      socket.data.outputCoalescer?.flush()
      socket.send(payload)
    }
  }

  readonly send = (ws: ServerWebSocket<WSData>, message: ServerMessage): void => {
    const coalescer = ws.data.outputCoalescer
    if (!coalescer) {
      ws.send(JSON.stringify(message))
      return
    }
    if (message.type === 'terminal-output') {
      // Coalesced per connection: one frame per event-loop turn, with every
      // non-output message draining pending output first (see sendOrdered).
      coalescer.enqueue(message.sessionId, message.data)
      return
    }
    coalescer.sendOrdered(message)
  }

  /** Forward registry change events to every connected client. */
  wireRegistry(registry: SessionRegistry): void {
    registry.on('session-update', (session) => {
      this.broadcast({ type: 'session-update', session })
    })

    registry.on('sessions', (sessions) => {
      this.broadcast({ type: 'sessions', sessions })
    })

    registry.on('session-removed', (sessionId) => {
      this.broadcast({ type: 'session-removed', sessionId })
    })

    registry.on('agent-sessions', ({ active, hibernating, history }) => {
      this.broadcast({ type: 'agent-sessions', active, hibernating, history })
    })

    registry.on('agent-sessions-active', (active) => {
      this.broadcast({ type: 'agent-sessions-active', active })
    })
  }
}

export function createConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((err) => {
    logger.error('unhandled_async_error', {
      context,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}
