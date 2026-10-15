// The handoff request (task-results-handoffs 7.2, design D3): a role picked
// from the team's groups, instructions, and an optional expected response —
// the fields **Request review**, **Request QA**, **Return for fixes**, and
// the release dialog's review request share. The form keeps its input after
// a refusal; its command key is armed per payload in the task store, so a
// double click or a reconnect resend dispatches once.
import type { TaskHandoffKind } from '@shared/teamTasks'
import type { TeamGroupOption } from '../chat/useTeamGroups'

export interface RoleRequest {
  target: string
  instructions: string
  expectedResponse: string
}

export const emptyRoleRequest = (target = ''): RoleRequest => ({ target, instructions: '', expectedResponse: '' })

export const HANDOFF_ACTIONS: Record<TaskHandoffKind, string> = { review: 'Request review', qa: 'Request QA', fix: 'Return for fixes' }
export const HANDOFF_ROLE_HINT: Record<TaskHandoffKind, string> = {
  review: 'reviewers', qa: 'qa', fix: 'devs',
}

/** The request's command payload: what the key names (a changed field is a new intent). */
export const requestPayload = (kind: string, resultId: string, request: RoleRequest) =>
  JSON.stringify({ kind, resultId, target: request.target, instructions: request.instructions.trim(), expectedResponse: request.expectedResponse.trim() })

export function RoleRequestFields({ value, onChange, groups, disabled, label }: {
  value: RoleRequest
  onChange: (next: RoleRequest) => void
  groups: TeamGroupOption[]
  disabled: boolean
  /** Prefix for the fields' accessible names (e.g. "Review"). */
  label: string
}) {
  return <div className="flex flex-col gap-2">
    <select className="input text-chat-meta" aria-label={`${label} role`} value={value.target} disabled={disabled}
      onChange={event => onChange({ ...value, target: event.target.value })}>
      <option value="">Choose a role…</option>
      {groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
    </select>
    <textarea className="input min-h-12 text-chat-body" aria-label={`${label} instructions`} placeholder="Instructions" value={value.instructions}
      disabled={disabled} onChange={event => onChange({ ...value, instructions: event.target.value })} />
    <input className="input text-chat-body" aria-label={`${label} expected response`} placeholder="Expected response (optional)"
      value={value.expectedResponse} disabled={disabled} onChange={event => onChange({ ...value, expectedResponse: event.target.value })} />
    <p className="text-chat-meta text-secondary">Group dispatch selects one eligible member of the role.</p>
  </div>
}

export const requestReady = (request: RoleRequest) => !!request.target && !!request.instructions.trim()
