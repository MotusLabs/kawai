// **Release worktree and hand off** (task-results-handoffs 7.2, design D7):
// the confirmation lists every session it would archive with its readiness,
// every other live session working in the task's worktree — never archived,
// and not covered by the spawned-writer cap — and the review request. The
// server refuses with an actionable reason while any member is busy, awaits
// a request, holds mail, or runs a background worker; the dialog keeps its
// input through that. Offered only while the preview says it applies.
import { useEffect, useState } from 'react'
import type { HumanTaskDetail } from '@shared/teamTasks'
import type { TaskActFn } from './TaskDirectionEditor'
import { RoleRequestFields, emptyRoleRequest, requestPayload, requestReady, type RoleRequest } from './TaskHandoffForm'
import type { TeamGroupOption } from './useTeamGroups'

export default function TaskReleaseDialog({ detail, groups, connected, disabled, act }: {
  detail: HumanTaskDetail
  groups: TeamGroupOption[]
  connected: boolean
  disabled: boolean
  act: TaskActFn
}) {
  const release = detail.release
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState<RoleRequest>(() => emptyRoleRequest())
  // The groups load after mount: default the role to reviewers once they do, unless one was chosen.
  useEffect(() => {
    if (groups.some(group => group.id === 'reviewers')) setRequest(current => (current.target ? current : { ...current, target: 'reviewers' }))
  }, [groups])
  if (!release) return null
  if (release.unavailable) {
    return <p className="mt-2 text-chat-meta text-secondary" data-testid="task-release-unavailable">Release worktree and hand off: {release.unavailable}</p>
  }
  if (!open) {
    return <button type="button" className="btn mt-2 text-chat-meta" data-testid="task-release" disabled={disabled}
      onClick={() => setOpen(true)}>Release worktree and hand off</button>
  }
  return <div className="mt-2 border border-border p-2" data-testid="task-release-confirm">
    <p className="font-medium">Release the worktree and hand result {release.outstandingResultId} to review</p>
    <p className="text-chat-meta text-secondary">These sessions are archived (never killed) — their results and transcripts stay:</p>
    {release.members.map(member => <p key={member.sessionId} className="text-chat-meta" data-testid="release-member" data-ready={member.ready}>
      · {member.name} — {member.ready ? 'ready' : `not ready: ${member.reason}`}
    </p>)}
    {release.others.length > 0 && <div className="text-chat-meta" data-testid="release-others">
      <p>Other live sessions in this worktree are not archived and can still edit it — the spawned-writer cap does not cover them:</p>
      {release.others.map(other => <p key={other.sessionId}>· {other.name}</p>)}
    </div>}
    <RoleRequestFields value={request} onChange={setRequest} groups={groups} disabled={!connected} label="Review" />
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn btn-primary" data-testid="task-release-confirm-button" disabled={disabled || !requestReady(request)}
        onClick={() => act('release', {
          type: 'team-task-release', target: request.target, instructions: request.instructions.trim(),
          ...(request.expectedResponse.trim() ? { expectedResponse: request.expectedResponse.trim() } : {}),
        }, { slot: `release:${detail.task.id}`, payload: requestPayload('release', release.outstandingResultId ?? '', request) })}>
        Release and hand off</button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  </div>
}
