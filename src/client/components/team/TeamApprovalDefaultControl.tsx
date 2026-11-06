// TeamApprovalDefaultControl.tsx - the Members tab's one team-level control
// (unify-approval-defaults D1/D4): the team's only default approval policy.
// It seeds the New Session dialog's Auto-approve box for chats the human
// creates in the team, and applies to members spawned later for every group
// that does not set `approval: manual` — a group's `approval: auto` grants
// nothing, so the control names those groups while the default is not auto.
// It writes only the team record, never a group file or a running agent;
// later spawns read it on the server, so it applies with no browser
// connected. The shown value is the server's snapshot; a save shows the
// server's refusal inline, and the control is disabled while disconnected
// (the last known value stays). A save in flight when the connection drops
// is released by the app-wide disconnect handler (`connectionWaits.ts`),
// mounted or not.
// Each button saves on click, so they are toggle buttons, not a radio group
// whose arrow keys would save on every step.
import type { ChatApprovalPolicy } from '@shared/chat'
import type { SendClientMessage } from '@shared/types'
import { useTeamWorkspaceDataStore } from '../../stores/teamWorkspaceDataStore'

const OPTIONS: Array<{ id: ChatApprovalPolicy; label: string }> = [
  { id: 'manual', label: 'Manual' },
  { id: 'auto', label: 'Auto-approve' },
]

export default function TeamApprovalDefaultControl({ teamPath, value, autoRequestedBy = [], connected, sendMessage }: {
  teamPath: string
  /** The team's stored default from the last snapshot; null = not set. */
  value: ChatApprovalPolicy | null
  /** Groups whose `approval: auto` has no effect under this default (the snapshot's list). */
  autoRequestedBy?: string[]
  connected: boolean
  sendMessage: SendClientMessage
}) {
  const save = useTeamWorkspaceDataStore(state => state.approvalSaves[teamPath])
  const begin = useTeamWorkspaceDataStore(state => state.beginApprovalSave)
  const pending = save?.pending === true

  const choose = (policy: ChatApprovalPolicy) => {
    if (!connected || pending || policy === value) return
    begin(teamPath)
    sendMessage({ type: 'team-workspace-approval-default-set', teamPath, policy })
  }

  return <section className="border border-border p-3" data-testid="team-approval-default">
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm text-primary">Default approval policy</div>
        <div className="text-chat-meta text-secondary" data-testid="team-approval-default-value">
          {value === null ? 'Not set: new chats and spawned members start on manual.' : `Set to ${value === 'auto' ? 'auto-approve' : 'manual'}.`}
        </div>
      </div>
      <div className="flex gap-1" role="group" aria-label="Default approval policy">
        {OPTIONS.map(option => <button
          key={option.id} type="button" aria-pressed={value === option.id}
          disabled={!connected || pending}
          data-testid={`team-approval-default-${option.id}`}
          onClick={() => choose(option.id)}
          className={`btn text-xs px-3 focus:outline-none focus:ring-2 focus:ring-primary ${value === option.id ? 'btn-primary' : ''}`}
        >{option.label}</button>)}
      </div>
    </div>
    <p className="mt-1 text-chat-meta text-muted" data-testid="team-approval-default-hint">
      Seeds Auto-approve for chats you create in this team, and applies to members spawned from now on,
      except groups that set <code>approval: manual</code>. A group’s <code>approval: auto</code> has no effect:
      only this default grants auto. Existing chats keep their policy.
    </p>
    {autoRequestedBy.length > 0 && <p className="mt-1 text-chat-meta text-secondary" data-testid="team-approval-default-auto-requested">
      {autoRequestedBy.join(', ')} {autoRequestedBy.length === 1 ? 'asks' : 'ask'} for auto; set the default to auto to grant it.
    </p>}
    {!connected && <p className="text-chat-meta text-secondary" role="status">Disconnected: the default cannot be changed.</p>}
    {save?.error && <p className="text-chat-meta text-chat-danger" role="alert" data-testid="team-approval-default-error">{save.error}</p>}
  </section>
}
