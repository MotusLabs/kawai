// The owner's hold and pause commands over the chat WebSocket (revision-
// control design D14): `team-plan-hold-place`, `-hold-release`,
// `-hold-extend`, `team-plan-pause`, and `team-plan-pause-resolve`, each
// answered by `team-plan-result`. Like every plan view, a request names the
// team's directory (`teamPath`) through the shared team-scope resolver: an
// unknown path is refused `unknown-team` with no data, and another team's
// plan reads as not found (the services look plans up by team). The commands
// run through the composed HoldService and PauseService as the human caller
// — no agent tool reaches them (D15, I1) — and the services' committed
// writes announce the plan, so its detail is re-pushed to every subscriber
// (D3). A refusal answers with every failing check; a replay answers with
// the stored record the first command wrote.
import type { ClientMessage } from '../../../shared/types'
import { unknownTeamError } from '../../../shared/team'
import type { PlanHold } from '../../../shared/planRevisionControl'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import type { ExecutionEventOutcome } from '../PlanService'
import { holdView } from './revisionControlRead'
import { revisionControlOf, type RevisionControlServices } from './revisionControlServices'

export const REVISION_CONTROL_COMMAND_TYPES = [
  'team-plan-hold-place', 'team-plan-hold-release', 'team-plan-hold-extend', 'team-plan-pause', 'team-plan-pause-resolve',
] as const

export type RevisionControlClientMessage = Extract<ClientMessage, { type: (typeof REVISION_CONTROL_COMMAND_TYPES)[number] }>

export const isRevisionControlCommand = (message: { type: string }): message is RevisionControlClientMessage =>
  (REVISION_CONTROL_COMMAND_TYPES as readonly string[]).includes(message.type)

type Answer = (payload: Record<string, unknown>) => void
type Refused = { ok: false; reason: string; message: string; failures?: Array<{ name: string; message: string }> }

/** A refusal's answer: every failing check, else the one reason as a check. */
function refusal(outcome: Refused): Record<string, unknown> {
  return {
    error: outcome.message, reason: outcome.reason,
    failures: outcome.failures && outcome.failures.length > 0 ? outcome.failures : [{ name: outcome.reason, message: outcome.message }],
  }
}

export async function handleRevisionControlCommand(manager: ChatSessionManager, connection: ChatConnection, message: RevisionControlClientMessage) {
  const { teamPath, requestId } = message
  const answer: Answer = payload => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
  const team = await manager.teamScopes.resolve(teamPath)
  if (!team) {
    answer({ error: unknownTeamError(teamPath), reason: 'unknown-team' })
    return
  }
  const services = revisionControlOf(manager.plans)
  if (services === null) {
    answer({ error: 'Plan holds and pauses are not available on this server.' })
    return
  }
  const caller = { kind: 'human' as const, team }
  try {
    await dispatch(services, caller, team.teamId, message, answer)
  } catch (error) {
    answer({ error: error instanceof Error ? error.message : String(error) })
  }
}

async function dispatch(services: RevisionControlServices, caller: { kind: 'human'; team: { teamId: string; groupsRoot: string } }, teamId: string,
  message: RevisionControlClientMessage, answer: Answer): Promise<void> {
  const view = (hold: PlanHold | null | undefined) => (hold ? holdView(hold, services.holds.deps.holds.releasedChangesOf(hold.id)) : undefined)
  const stored = (holdId: string) => view(services.holds.deps.holds.get(teamId, holdId))
  const settle = <T>(outcome: ExecutionEventOutcome<T> | (Refused & { result: undefined }), payload: (result: T | undefined) => Record<string, unknown>) => {
    if (!outcome.ok) answer(refusal(outcome))
    else answer({ replayed: outcome.replayed, ...payload(outcome.result) })
  }
  switch (message.type) {
    case 'team-plan-hold-place': {
      const outcome = services.holds.place(caller, {
        planId: message.planId, scope: message.scope, rationale: message.rationale, deadline: message.deadline, commandId: message.commandId,
        ...(message.changes !== undefined ? { changes: message.changes } : {}),
        ...(message.cites ? { cites: message.cites } : {}),
      })
      // A replay carries the hold the first command placed (UNIQUE (plan_id, command_id)).
      settle(outcome, result => ({
        hold: view(result?.hold ?? services.holds.deps.holds.forPlan(teamId, message.planId).find(hold => hold.commandId === message.commandId.trim())),
      }))
      return
    }
    case 'team-plan-hold-release': {
      const outcome = services.holds.release(caller, {
        planId: message.planId, holdId: message.holdId, reason: message.reason, commandId: message.commandId,
        ...(message.changes !== undefined ? { changes: message.changes } : {}),
        ...(message.retain !== undefined ? { retain: message.retain } : {}),
      })
      settle(outcome, result => ({
        hold: result ? view(result.released) : stored(message.holdId),
        narrowed: result ? view(result.narrowed) ?? null : stored(`hold-${message.commandId.trim()}-narrowed`) ?? null,
      }))
      return
    }
    case 'team-plan-hold-extend': {
      const outcome = services.holds.extend(caller, {
        planId: message.planId, holdId: message.holdId, deadline: message.deadline, commandId: message.commandId,
        ...(message.reason !== undefined ? { reason: message.reason } : {}),
      })
      settle(outcome, result => ({ hold: result ? view(result.hold) : stored(message.holdId) }))
      return
    }
    case 'team-plan-pause': {
      if (services.pauses === null) {
        answer({ error: 'Pauses are not available on this server.' })
        return
      }
      const outcome = services.pauses.pause(caller, {
        planId: message.planId, holdId: message.holdId, deadline: message.deadline, commandId: message.commandId,
        ...(message.note !== undefined ? { note: message.note } : {}),
      })
      settle(outcome, result => {
        // A replay carries the pause the first command opened (UNIQUE (plan_id, command_id)).
        const pauseId = result?.pause.id
          ?? services.pauses!.deps.pauses.forPlan(teamId, message.planId).find(pause => pause.commandId === message.commandId.trim())?.id
        const pause = services.read(teamId, message.planId).pauses.find(entry => entry.id === pauseId)
        return pause ? { pause } : {}
      })
      return
    }
    case 'team-plan-pause-resolve': {
      if (services.pauses === null) {
        answer({ error: 'Pauses are not available on this server.' })
        return
      }
      const outcome = await services.pauses.resolve(caller, {
        planId: message.planId, pauseId: message.pauseId, change: message.change, choice: message.choice,
        rationale: message.rationale ?? '', commandId: message.commandId,
        ...(message.adapt !== undefined ? { adapt: message.adapt } : {}),
        ...(message.releaseHold !== undefined ? { releaseHold: message.releaseHold } : {}),
      })
      settle(outcome, result => {
        if (result) return { resolution: { change: result.target.change, decision: result.target.decision, ...(result.releaseHold ? { releaseHold: result.releaseHold } : {}) } }
        // A replay carries the decision the first command recorded.
        const target = services.pauses!.deps.pauses.target(message.pauseId, message.change)
        return target?.decision ? { resolution: { change: target.change, decision: target.decision } } : {}
      })
      return
    }
  }
}
