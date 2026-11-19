// The owner's Apply over the chat WebSocket (plan-revision-apply D6):
// `team-plan-execution-apply-preview` and `team-plan-execution-apply`, each
// answered by `team-plan-result` with `applyPreview` or `applied`. The
// execution connections route both here (their `team-plan-execution-`
// prefix). Like every plan view, a request names the team's directory
// (`teamPath`) through the shared team-scope resolver: an unknown path is
// refused `unknown-team` with no data, and another team's execution reads
// as not found. Both run through the composed ApplyService as the human
// caller — no agent tool reaches them (revision-control D15, I1) — and a
// committed Apply announces the plan, so its detail is re-pushed. The
// service rides the composed PlanService in a side table, as the hold and
// pause services do (`revisionControlServices.ts`).
import type { ClientMessage } from '../../../shared/types'
import { unknownTeamError } from '../../../shared/team'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import type { PlanService } from '../PlanService'
import type { ApplyService } from './applyService'

export const APPLY_COMMAND_TYPES = ['team-plan-execution-apply-preview', 'team-plan-execution-apply'] as const

export type ApplyClientMessage = Extract<ClientMessage, { type: (typeof APPLY_COMMAND_TYPES)[number] }>

export const isApplyCommand = (message: { type: string }): message is ApplyClientMessage =>
  (APPLY_COMMAND_TYPES as readonly string[]).includes(message.type)

const attached = new WeakMap<PlanService, ApplyService>()

/** Attach the composed ApplyService to its PlanService (the composition's one call). */
export function attachApply(plans: PlanService, service: ApplyService): void {
  attached.set(plans, service)
}

/** The ApplyService composed beside this PlanService; null when it was built outside the composition. */
export function applyOf(plans: PlanService | null | undefined): ApplyService | null {
  return plans ? attached.get(plans) ?? null : null
}

export async function handleApplyCommand(manager: ChatSessionManager, connection: ChatConnection, message: ApplyClientMessage): Promise<void> {
  const { teamPath, requestId } = message
  const answer = (payload: Record<string, unknown>) => connection.send({ type: 'team-plan-result', teamPath, requestId, ...payload })
  const team = await manager.teamScopes.resolve(teamPath)
  if (!team) {
    answer({ error: unknownTeamError(teamPath), reason: 'unknown-team' })
    return
  }
  const service = applyOf(manager.plans)
  if (service === null) {
    answer({ error: 'Apply is not available on this server.' })
    return
  }
  const caller = { kind: 'human' as const, team }
  try {
    if (message.type === 'team-plan-execution-apply-preview') {
      const outcome = await service.preview(caller, {
        executionId: message.executionId, revision: message.revision, ...(message.choices ? { choices: message.choices } : {}),
      })
      answer(outcome.ok ? { applyPreview: outcome.preview } : { error: outcome.message, reason: outcome.reason })
      return
    }
    const outcome = await service.apply(caller, {
      executionId: message.executionId, expectedRevision: message.expectedRevision, revision: message.revision,
      contentHash: message.contentHash, choices: message.choices ?? {}, rationale: message.rationale, commandId: message.commandId,
      ...(message.adaptations ? { adaptations: message.adaptations } : {}),
    })
    if (!outcome.ok) {
      answer({
        error: outcome.message, reason: outcome.reason,
        failures: outcome.failures && outcome.failures.length > 0 ? outcome.failures : [{ name: outcome.reason, message: outcome.message }],
      })
      return
    }
    answer({ replayed: outcome.replayed, applied: outcome.applied })
  } catch (error) {
    answer({ error: error instanceof Error ? error.message : String(error) })
  }
}
