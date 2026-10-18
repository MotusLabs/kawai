// ChatConnections' Audit wiring (execution-safety-recovery D9; task rev 2):
// a committed audit row re-projects the workspace as well as the Audit tab, a
// disconnect ends the tab's pushes, and an open that waited out a restore for
// a connection already gone is moot. Each assertion is exact.
import { expect, test } from 'bun:test'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections, type ChatConnection } from '../chat/ChatConnections'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ServerMessage } from '../../shared/types'

const TEAM = { teamId: '/repo/.git' } as TeamIdentity

function harness() {
  let restored!: () => void
  const restore = new Promise<void>(resolve => { restored = resolve })
  const sent: ServerMessage[] = []
  const manager = {
    whenRestored: () => restore,
    teamScopes: { resolve: async () => TEAM },
    outboundAudit: { page: () => ({ rows: [], cursor: null }), callGroup: () => null },
  } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager)
  const connection = { send: (message: ServerMessage) => sent.push(message) } as unknown as ChatConnection
  const types = () => sent.map(message => message.type)
  return { connections, connection, sent, types, restored }
}

test('a committed audit row re-projects the workspace too', () => {
  const h = harness()
  const workspace: string[] = []
  ;(h.connections as unknown as { workspaceConnections: { publish(teamId: string): void } }).workspaceConnections.publish =
    teamId => { workspace.push(teamId) }
  h.connections.publishOutbound(TEAM.teamId)
  expect(workspace).toEqual([TEAM.teamId])
})

test('a disconnect ends the Audit pushes', async () => {
  const h = harness()
  h.restored()
  await h.connections.handle(h.connection, { type: 'team-audit-open', teamPath: '/repo', requestId: 'r1', filters: {} })
  h.connections.publishOutbound(TEAM.teamId)
  expect(h.types()).toEqual(['team-audit-page', 'team-audit-changed'])
  h.connections.disconnect(h.connection)
  h.connections.publishOutbound(TEAM.teamId)
  expect(h.types()).toEqual(['team-audit-page', 'team-audit-changed'])
})

test('an open that waited out the restore for a gone connection answers nothing', async () => {
  const h = harness()
  const open = h.connections.handle(h.connection, { type: 'team-audit-open', teamPath: '/repo', requestId: 'r1', filters: {} })
  h.connections.disconnect(h.connection)
  h.restored()
  await open
  expect(h.types()).toEqual([])
})
