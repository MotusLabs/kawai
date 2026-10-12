// Local-host stamping for sessions leaving the discovery paths: every local
// session (fresh from tmux or hydrated from the DB) is tagged with the boot
// host label and remote: false so remote merge logic can tell them apart.
import { config } from './config'
import type { Session } from '../shared/types'

const localHostLabel = config.hostLabel

export function stampLocalSession<S extends Session>(session: S): S {
  return {
    ...session,
    host: localHostLabel,
    remote: false,
  }
}

export function stampLocalSessions<T extends Session>(sessions: T[]): T[] {
  return sessions.map(stampLocalSession)
}
