// Server-level messages: host status, config, update state, and the
// error/terminal banners.
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUpdateStore } from '../stores/updateStore'
import { setClientLogLevel } from '../utils/clientLog'
import type { ServerMessage } from '@shared/types'
import type { MessageRouterDeps } from './types'

/**
 * The server's question auto-answer wait changed (question-auto-answer D5):
 * the settings store follows, so an open Settings dialog updates live and a
 * bad value is ignored by the setter's validation.
 */
export function handleQuestionAutoAnswerChanged(
  message: Extract<ServerMessage, { type: 'question-auto-answer-changed' }>,
  _deps: MessageRouterDeps
): void {
  useSettingsStore.getState().setQuestionAutoAnswerMinutes(message.minutes)
}

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
