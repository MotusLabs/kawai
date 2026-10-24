// Server-level messages: host status, config, update state, and the
// error/terminal banners.
import { useSessionStore } from '../stores/sessionStore'
import { useUpdateStore } from '../stores/updateStore'
import { consumeSendAnswer } from '../stores/pendingSendRecovery'
import { setClientLogLevel } from '../utils/clientLog'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

export function handleHostStatus(
  message: Extract<ServerMessage, { type: 'host-status' }>,
  _deps: MessageRouterDeps
): void {
  useSessionStore.getState().setHostStatuses(message.hosts)
}

export function handleServerConfig(
  message: Extract<ServerMessage, { type: 'server-config' }>,
  _deps: MessageRouterDeps
): void {
  const session = useSessionStore.getState()
  session.setRemoteAllowControl(message.remoteAllowControl)
  session.setRemoteAllowAttach(message.remoteAllowAttach)
  session.setHostLabel(message.hostLabel)
  session.setPreferWindowName(message.preferWindowName)
  if (message.clientLogLevel) {
    setClientLogLevel(message.clientLogLevel)
  }
}

export function handleUpdateState(
  message: Extract<ServerMessage, { type: 'update-state' }>,
  _deps: MessageRouterDeps
): void {
  useUpdateStore.getState().apply(message)
}

export function handleError(
  message: Extract<ServerMessage, { type: 'error' }>,
  deps: MessageRouterDeps
): void {
  // A correlated refusal (plan-workspace §6.3, B1) settles its pending send
  // at the connection consumer first; the error itself still shows as today.
  consumeSendAnswer(message)
  deps.setTransientError(message.message)
}

export function handleTerminalError(
  message: Extract<ServerMessage, { type: 'terminal-error' }>,
  deps: MessageRouterDeps
): void {
  const selectedSessionId = useSessionStore.getState().selectedSessionId
  if (!message.sessionId || message.sessionId === selectedSessionId) {
    deps.setTransientError(`${message.code}: ${message.message}`)
  }
}

export function handleTerminalReady(
  message: Extract<ServerMessage, { type: 'terminal-ready' }>,
  deps: MessageRouterDeps
): void {
  if (message.sessionId === useSessionStore.getState().selectedSessionId) {
    deps.clearTransientError()
  }
}
