// The send-time worker-choice check (dispatch-worker-choice D1, agent-mailbox
// and task-results specs): the one place group mail and dispatches validate
// a sender's `worker` before anything is written. It normalizes the choice
// against the profile catalog at the team root, then requires it to name
// one of the target group's workers, and refuses it on any other target.
import { resolveProfileCatalog } from '../chat/profileCatalog'
import { catalogCtx } from './cooldowns'
import type { GroupDefinition } from './groupFile'
import { DEFAULT_PROFILE_ID } from './routing/candidates'
import { validateWorkerChoice, type WorkerCatalog } from './routing/workerSelector'

/** The refusal for a choice on a target that is not a group. */
export const WORKER_GROUP_ONLY = 'A worker choice applies only to group mail; drop worker, or send to a group. Nothing was queued.'
/** The refusal for a dispatch or handoff naming a worker on a session target. */
export const WORKER_GROUP_TARGET_ONLY = 'A worker choice applies only to group targets; drop worker, or target a group. Nothing was written.'
/** The refusal for a choice given on `reply`. */
export const WORKER_NOT_ON_REPLY = 'A reply takes no worker choice: it goes back to its sender. Drop worker, or send new group mail with it. Nothing was queued.'

/** Every catalog model key with its provider id, at the team root. */
export function workerCatalog(homeDir: string | undefined, teamRoot: string): WorkerCatalog {
  const catalog = resolveProfileCatalog(catalogCtx(homeDir, teamRoot))
  return new Map([...catalog.profiles].map(([id, profile]) => [id, profile.providerId]))
}

/**
 * The canonical selector for `raw` on mail to `group`, or a thrown refusal
 * naming the reason (unknown, ambiguous, outside the group's workers).
 */
export function checkWorkerChoice(raw: string, group: GroupDefinition, homeDir: string | undefined, teamRoot: string): string {
  const profiles = group.profiles.length > 0 ? group.profiles.map(entry => entry.profileId) : [DEFAULT_PROFILE_ID]
  const checked = validateWorkerChoice(raw, workerCatalog(homeDir, teamRoot), { id: group.id, profiles })
  if (!checked.ok) throw new Error(checked.error)
  return checked.selector
}
