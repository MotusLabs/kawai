// The human execution commands (plan-execution D17): preview, Start, Stop,
// and Retry over the chat WebSocket, answered by `team-plan-result` with
// `execution` (or `preview` for the standing read). Like every plan view,
// each request names the team's directory (`teamPath`) through the shared
// team-scope resolver; an unknown path and another team's ids are refused
// with no data. The commands run through ExecutionService as the human
// caller — no agent tool can start, stop, or retry an execution — and the
// changes they cause reach plan subscribers through the manager's publish.
import type { ClientMessage } from '../../../shared/types'
import { unknownTeamError } from '../../../shared/team'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'

type ExecutionClientMessage = Extract<ClientMessage, { type: `team-plan-execution-${string}` }>

export class ExecutionConnections {
  constructor(private readonly manager: ChatSessionManager) {}

  async handle(connection: ChatConnection, message: ExecutionClientMessage) {
    const { teamPath, requestId } = message
    const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      answer({ error: unknownTeamError(teamPath) })
      return
    }
    const caller = { kind: 'human' as const, team }
    const executions = this.manager.executions
    try {
      switch (message.type) {
        case 'team-plan-execution-preview': {
          if (!this.manager.plans.store.forTeam(team.teamId, message.planId)) {
            answer({ error: `Plan not found in this team: ${message.planId}` })
            return
          }
          const outcome = await executions.preview(caller, { planId: message.planId, revision: message.revision })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason })
            return
          }
          answer({ preview: { failures: outcome.failures, ready: outcome.failures.length === 0 } })
          return
        }
        case 'team-plan-execution-start': {
          const outcome = await executions.start(caller, {
            planId: message.planId, revision: message.revision, contentHash: message.contentHash, commandId: message.commandId,
          })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason, ...(outcome.failures ? { failures: outcome.failures } : {}) })
            return
          }
          answer({
            execution: { id: outcome.execution.id, state: outcome.execution.state, outcome: outcome.execution.outcome },
            replayed: outcome.replayed,
          })
          return
        }
        case 'team-plan-execution-stop': {
          const outcome = await executions.stop(caller, { executionId: message.executionId, reason: message.reason, commandId: message.commandId })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason, ...(outcome.failures ? { failures: outcome.failures } : {}) })
            return
          }
          answer({ replayed: outcome.replayed })
          return
        }
        case 'team-plan-execution-retry': {
          const outcome = await executions.retry(caller, { executionId: message.executionId, change: message.change, commandId: message.commandId })
          if (!outcome.ok) {
            answer({ error: outcome.message, reason: outcome.reason, ...(outcome.failures ? { failures: outcome.failures } : {}) })
            return
          }
          answer({ replayed: outcome.replayed })
          return
        }
      }
    } catch (error) {
      answer({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
