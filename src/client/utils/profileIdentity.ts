// The chat header's identity labels (design D13): the profile's label plus
// its provider's. A profile the catalog no longer defines (a renamed or
// deleted .kawai entry) falls back to the stored id for both, so the header
// keeps naming the session's stored identity.
import type { ClaudeProfileMetadata } from '@shared/chat'

export function profileIdentityLabels(
  profiles: ClaudeProfileMetadata[],
  profileId: string,
): { profileLabel: string; providerLabel: string } {
  const entry = profiles.find(profile => profile.id === profileId)
  const profileLabel = entry?.label ?? profileId
  return { profileLabel, providerLabel: entry?.providerLabel ?? profileLabel }
}
