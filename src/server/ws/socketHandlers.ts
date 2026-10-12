// Bun.serve fetch + websocket handlers: upgrades `/ws` requests with a fresh
// per-connection WSData record (everything else goes to the Hono app), and on
// open registers the socket, gives it a terminal-output coalescer, sends the
// initial sessions/host-status/server-config/agent-sessions/workspace
// snapshot, and starts its persistent terminal proxy. Close tears the chat
// peer, terminal, and coalescer down before dropping the socket.
import type { Server, ServerWebSocket } from 'bun'
import type { Hono } from 'hono'
import { config } from '../config'
import { logLevel } from '../logger'
import { TerminalOutputCoalescer } from '../terminal/outputCoalescer'
import type { ChatConnection, ChatConnections } from '../chat/ChatConnections'
import type { SessionRegistry } from '../SessionRegistry'
import type { RemoteSessionService } from '../remote/RemoteSessionService'
import type { WorkspaceCoordinator } from '../workspace/workspaceCoordinator'
import type { ConnectionHub } from './ConnectionHub'
import { createConnectionId } from './ConnectionHub'
import { cleanupTerminals, type TerminalAttachContext } from './terminalAttach'
import { initializePersistentTerminal } from './terminalProxy'
import type { WSData } from './wsTypes'

export function createServerFetch(app: Hono) {
  return function serverFetch(req: Request, server: Server<WSData>) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      const requestIp =
        typeof server.requestIP === 'function' ? server.requestIP(req) : null
      if (
        server.upgrade(req, {
          data: {
            terminal: null,
            currentSessionId: null,
            currentTmuxTarget: null,
            connectionId: createConnectionId(),
            remoteAddress: requestIp?.address ?? null,
            userAgent: req.headers.get('user-agent')?.slice(0, 200) ?? null,
            terminalHost: null,
            terminalAttachSeq: 0,
            lastAttachKey: null,
            lastAttachTs: 0,
            clipboardPollTimer: null,
            clipboardPollInFlight: false,
            lastClipboardBufferKey: null,
            clipboardBufferArmedUntil: 0,
            clipboardArmedAtSec: 0,
            clipboardWatchGen: 0,
            copyModeCheckInFlight: false,
            outputCoalescer: null,
          },
        })
      ) {
        return
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    return app.fetch(req)
  }
}

export interface WebSocketHandlerDeps {
  hub: ConnectionHub
  registry: SessionRegistry
  remote: RemoteSessionService
  workspaceCoordinator: WorkspaceCoordinator
  terminal: TerminalAttachContext
  chatConnections: ChatConnections
  /** The socket's chat peer, if one was ever created (never creates one). */
  existingChatPeer: (ws: ServerWebSocket<WSData>) => ChatConnection | undefined
  handleMessage: (ws: ServerWebSocket<WSData>, message: string | BufferSource) => void
}

export function createWebSocketHandlers(deps: WebSocketHandlerDeps) {
  const { hub, registry, remote, workspaceCoordinator, terminal, chatConnections } = deps
  const { sockets, send } = hub
  return {
    idleTimeout: 40,
    sendPings: true,
    // Off by default (design D3): per-frame deflate CPU lands on the
    // keystroke-echo path; AGENTBOARD_WS_DEFLATE=true restores it.
    perMessageDeflate: config.wsPerMessageDeflate,
    open(ws: ServerWebSocket<WSData>) {
      sockets.add(ws)
      // Coalesced terminal-output frames for this connection. `sockets.has(ws)`
      // is the authoritative open predicate — the close handler removes the
      // socket and disposes the coalescer.
      ws.data.outputCoalescer = new TerminalOutputCoalescer({
        send: (payload) => ws.send(payload),
        isOpen: () => sockets.has(ws),
      })
      send(ws, { type: 'sessions', sessions: registry.getAll() })
      send(ws, { type: 'host-status', hosts: remote.getHostStatuses() })
      send(ws, {
        type: 'server-config',
        remoteAllowControl: config.remoteAllowControl,
        remoteAllowAttach: config.remoteAllowAttach,
        hostLabel: config.hostLabel,
        preferWindowName: config.preferWindowName,
        clientLogLevel: logLevel,
      })
      const agentSessions = registry.getAgentSessions()
      send(ws, {
        type: 'agent-sessions',
        active: agentSessions.active,
        hibernating: agentSessions.hibernating,
        history: agentSessions.history,
      })
      const workspaceSnapshot = workspaceCoordinator.getSnapshot()
      if (workspaceSnapshot) {
        send(ws, { type: 'workspace-snapshot', snapshot: workspaceSnapshot })
      }
      initializePersistentTerminal(terminal, ws)
    },
    message(ws: ServerWebSocket<WSData>, message: string | BufferSource) {
      deps.handleMessage(ws, message)
    },
    close(ws: ServerWebSocket<WSData>) {
      const peer = deps.existingChatPeer(ws)
      if (peer) chatConnections.disconnect(peer)
      cleanupTerminals(ws)
      ws.data.outputCoalescer?.dispose()
      ws.data.outputCoalescer = null
      sockets.delete(ws)
    },
  }
}
