// Spawned-member approval resolution (unify-approval-defaults D3): a group
// file's `approval:` key can only tighten. `approval: manual` wins; otherwise
// the team's stored default (set only by the human on the Team page) decides,
// else manual. A group's `approval: auto` never grants auto — it is reported
// as ignored instead — so no repository file can make a spawn auto when the
// human has not chosen auto for the team. The spawn, the group dispatch
// preview, and the Members row all call this one function, so they can never
// disagree; the client only renders what the server resolved.
import type { ChatApprovalPolicy } from './chat'

/** Where a spawned member's policy came from. `group` only for `approval: manual`. */
export type SpawnApprovalSource = 'group' | 'team' | 'built-in'

export interface SpawnApproval {
  policy: ChatApprovalPolicy
  source: SpawnApprovalSource
  /** The group asks for `approval: auto`, which decided nothing. */
  ignoredGroupAuto: boolean
}

export function resolveSpawnApproval(
  groupApproval: ChatApprovalPolicy | undefined,
  teamDefault: ChatApprovalPolicy | null,
): SpawnApproval {
  const ignoredGroupAuto = groupApproval === 'auto'
  if (groupApproval === 'manual') return { policy: 'manual', source: 'group', ignoredGroupAuto }
  if (teamDefault !== null) return { policy: teamDefault, source: 'team', ignoredGroupAuto }
  return { policy: 'manual', source: 'built-in', ignoredGroupAuto }
}

/** Short source label for the UI: `group file`, `team default`, `built-in`. */
export function spawnApprovalSourceLabel(source: SpawnApprovalSource): string {
  return source === 'group' ? 'group file' : source === 'team' ? 'team default' : 'built-in'
}
