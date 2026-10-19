// Provider-aware cooldown resolution (providers-and-workers D8) for the
// team-mail readers: session-bound readers resolve the provider at the
// session's project path, group-level ones in the ambient catalog — the same
// resolution each session's launch settings use. Kept beside the store so
// no reader re-derives the context by hand.
import { providerLabelOf, providerOf } from '../chat/profileCatalog'
import type { ChatSessionRecord } from '../db'
import type { EffectiveCooldown, LimitEventStore } from './routing/limitEvents'

export { LimitEventStore } from './routing/limitEvents'

/** The router's per-profile provider resolver (D10) over the ambient catalog. */
export const ambientProviderOf = (homeDir: string | undefined) => (profileId: string) => providerOf(profileId, catalogCtx(homeDir))

/** The router's provider label resolver (the D14 rule context) over the ambient catalog. */
export const ambientProviderLabel = (homeDir: string | undefined) => (providerId: string) => providerLabelOf(providerId, catalogCtx(homeDir))

/** The catalog context providerOf reads: the ambient home plus a project path when one is at hand. */
export function catalogCtx(homeDir: string | undefined, projectPath?: string | null) {
  return { ...(homeDir ? { homeDir } : {}), ...(projectPath ? { projectPath } : {}) }
}

/** The profile's effective cooldown (D8) at a session's project path, else the ambient catalog. */
export function sessionCooldown(limits: Pick<LimitEventStore, 'cooldownFor'>, homeDir: string | undefined,
  profileId: string, projectPath?: string | null): EffectiveCooldown {
  return limits.cooldownFor(profileId, providerOf(profileId, catalogCtx(homeDir, projectPath)))
}

/** A recipient row's cooldown fields (D8/D15): the effective end plus the deciding provider and its catalog label (O1), when it decided. */
export function recipientCooldown(limits: Pick<LimitEventStore, 'cooldownFor'>, homeDir: string | undefined,
  profileId: string, record: Pick<ChatSessionRecord, 'projectPath'>): { cooldownUntil: string | null; cooldownProvider?: string; cooldownProviderLabel?: string } {
  const cooldown = sessionCooldown(limits, homeDir, profileId, record.projectPath)
  return {
    cooldownUntil: cooldown.until,
    ...(cooldown.provider && cooldown.providerId
      ? {
          cooldownProvider: cooldown.providerId,
          cooldownProviderLabel: providerLabelOf(cooldown.providerId, catalogCtx(homeDir, record.projectPath)) ?? undefined,
        }
      : {}),
  }
}
