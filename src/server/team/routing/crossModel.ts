// Cross-model review (starter-team-setup D5/D6): a review handoff to a group
// with `crossModelReview: true` may go only to a worker whose model family
// differs from every family that authored a result on the task. This module
// is the one derivation every reader uses — routing, the dispatch preview,
// waiting reasons, and the handoff refusal — so they cannot disagree (I3).
// Pure: callers supply the authors, the session-record lookup, and the
// catalog's `familyOf`.
import type { ResultAuthorRow } from '../taskResultStore'
import type { WaitingConstraint } from '../../../shared/team'
import { crossModelReason, type CrossModelFilter } from './workerEligibility'

// The filter and its per-profile reason live in the pure eligibility module
// (it imports only shared types); they are re-exported here for callers.
export { crossModelReason, type CrossModelFilter } from './workerEligibility'

/** A session record's profile id: legacy records without one ran Default; null without a record. */
export function profileOfRecord(record: { claudeProfileId?: string } | null | undefined): string | null {
  return record ? record.claudeProfileId ?? 'default' : null
}


/** The handoff facts of one group message: its assignment's kind, result, and task. */
export interface ReviewHandoffFacts {
  handoffKind: string | null
  resultId: string | null
  taskId: string | null
}

export interface CrossModelInputs {
  /** The target group sets `crossModelReview: true`. */
  groupFlag: boolean
  /** The message's assignment; null for mail without one. */
  handoff: ReviewHandoffFacts | null
  /** Every agent author of the task's results (all rounds). */
  authors: (taskId: string) => ResultAuthorRow[]
  /** The profile a session record names, archived included; null when gone. */
  profileOfSession: (sessionId: string) => string | null
  familyOf: (profileId: string) => string
}

/**
 * The filter for one message, or null when cross-model review does not
 * apply: the group is unflagged, or the mail is not a review handoff of a
 * result. Human-submitted results add no family (the store lists agents only).
 */
export function crossModelFilter(input: CrossModelInputs): CrossModelFilter | null {
  const handoff = input.handoff
  if (!input.groupFlag || handoff === null || handoff.handoffKind !== 'review' || handoff.taskId === null || handoff.resultId === null) return null
  const families = new Set<string>()
  const unknownAuthors: string[] = []
  for (const author of input.authors(handoff.taskId)) {
    const profileId = author.profileId ?? input.profileOfSession(author.sessionId)
    if (profileId === null) unknownAuthors.push(author.sessionId)
    else families.add(input.familyOf(profileId))
  }
  return { families: [...families].sort(), unknownAuthors, familyOf: input.familyOf }
}


/** The group's worker profiles a filtered review may use, in group order. */
export function otherFamilyProfiles(filter: CrossModelFilter, profiles: readonly string[]): string[] {
  return profiles.filter(profileId => crossModelReason(filter, profileId) === null)
}

/**
 * The `cross-model` waiting constraint (D6): the authors' families, any
 * unknown author, and — when the group has no worker of another family —
 * that fact. Capacity constraints of the other-family workers come from the
 * caller's diagnosis, narrowed to those workers.
 */
export function crossModelConstraint(filter: CrossModelFilter, groupProfiles: readonly string[]): WaitingConstraint {
  const parts = [`authors' families: ${filter.families.length > 0 ? filter.families.join(', ') : 'none'}`]
  if (filter.unknownAuthors.length > 0) parts.push(`unknown author ${filter.unknownAuthors.join(', ')}`)
  else if (otherFamilyProfiles(filter, groupProfiles).length === 0) parts.push('no worker of another family is configured')
  return {
    kind: 'cross-model', detail: parts.join('; '),
    ...(filter.unknownAuthors.length > 0 ? { sessionIds: [...filter.unknownAuthors] } : {}),
  }
}

/**
 * The handoff refusal (D7): a worker choice whose every profile is of an
 * author's family. Returns the refusal text, or null when the choice keeps
 * another family (or there is no choice).
 */
export function crossModelChoiceRefusal(filter: CrossModelFilter, chosenProfiles: readonly string[] | null): string | null {
  if (chosenProfiles === null || chosenProfiles.length === 0) return null
  if (otherFamilyProfiles(filter, chosenProfiles).length > 0) return null
  const shared = [...new Set(chosenProfiles.map(filter.familyOf))].sort()
  return `worker choice is within the authors' model family ${shared.join(', ')}; a cross-model review needs a worker of another family`
}
