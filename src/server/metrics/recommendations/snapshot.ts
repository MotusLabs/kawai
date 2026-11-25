// The routing facts frozen at an incident (process-quota-history-and-
// incident-advice D4): the affected group's workers exactly as
// `team_capacity` counts them at that moment (cap, live members with pending
// reservations, effective cooldown, detected login sharing), each worker's
// account scope (B12), the message's hard worker choice and cross-model
// review restriction, and the worktree's writer occupancy. Pure: the caller
// reads `TeamCapacity.readTeam` (read-only and fetch-free, I4) and the
// restriction sources; nothing here is recomputed later from today's
// configuration.
import type { TeamCapacityAnswer } from '../../../shared/teamCapacity'
import type { IncidentCandidate, IncidentSnapshot } from './evaluator'

export interface SnapshotInput {
  limited: { profileId: string; providerId: string; window: string | null; resetsAt: string | null }
  groupId: string | null
  /** The team's capacity at the incident; null when the session has no team catalog. */
  capacity: TeamCapacityAnswer | null
  scopeOf: (profileId: string) => string | null
  restriction: (profileId: string) => IncidentCandidate['restriction']
  writer: { required: boolean; occupants: string[] }
}

export function incidentSnapshot(input: SnapshotInput): IncidentSnapshot {
  const group = input.capacity?.groups.find(entry => entry.id === input.groupId) ?? null
  const providers = new Map((input.capacity?.providers ?? []).map(provider => [provider.id, provider]))
  const limitedWorker = group?.workers.find(worker => worker.model === input.limited.profileId)
  const limitedProvider = providers.get(input.limited.providerId)
  const candidates: IncidentCandidate[] = (group?.workers ?? []).map(worker => ({
    profileId: worker.model,
    providerId: worker.provider,
    accountScope: input.scopeOf(worker.model),
    cooldownUntil: worker.cooldownUntil,
    cap: worker.cap,
    live: worker.live,
    sharesLoginWith: providers.get(worker.provider)?.sharesLoginWith ?? [],
    restriction: input.restriction(worker.model),
  }))
  return {
    version: 1,
    limited: {
      ...input.limited,
      accountScope: input.scopeOf(input.limited.profileId),
      cooldownUntil: limitedWorker?.cooldownUntil ?? limitedProvider?.cooldownUntil ?? null,
    },
    group: group ? { id: group.id, max: group.max, live: group.live } : null,
    candidates,
    writer: input.writer,
  }
}
