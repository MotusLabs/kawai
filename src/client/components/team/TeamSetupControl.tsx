// TeamSetupControl.tsx - the Members tab's Set up team (starter-team-setup
// D1–D3): its only control that writes group files. Shown while the snapshot
// says the main checkout holds no project group file (`available`), or while
// this page shows a run's answer. Choosing it asks the server for the preview
// — the starter groups with their workers and caps, the cross-model flag, the
// target directory, and a warning per worker the catalog lacks — and nothing
// is written until Confirm; Cancel sends nothing. The answer (created,
// skipped, or the refusal) shows inline; the server's push then lists the new
// groups in every open view. Every control is disabled while disconnected.
import type { SendClientMessage } from '@shared/types'
import type { TeamSetupGroup, TeamSetupResult } from '@shared/teamSetup'
import { useTeamSetupStore } from '../../stores/teamSetupStore'

function workersText(group: TeamSetupGroup): string {
  return group.workers.map(worker => `${worker.cap ?? 'any'} × ${worker.profileId}`).join(', ')
}

function resultText(result: TeamSetupResult): string {
  if (!result.ok) return result.error ?? 'Set up team failed.'
  const created = result.created.length > 0 ? `Created ${result.created.join(', ')}.` : 'Created nothing.'
  return result.skipped.length > 0 ? `${created} Kept existing ${result.skipped.join(', ')}.` : created
}

export default function TeamSetupControl({ teamPath, available, connected, sendMessage }: {
  teamPath: string
  /** The snapshot's `setupAvailable`: no project group file exists. */
  available: boolean
  connected: boolean
  sendMessage: SendClientMessage
}) {
  const setup = useTeamSetupStore(state => state.setups[teamPath])
  const store = useTeamSetupStore.getState
  const pending = setup?.pending ?? null
  const preview = setup?.preview ?? null
  const result = setup?.result ?? null
  if (!available && !result) return null

  const open = () => {
    if (!connected || pending) return
    store().beginPreview(teamPath)
    sendMessage({ type: 'team-workspace-setup-preview', teamPath })
  }
  const confirm = () => {
    if (!connected || pending) return
    store().beginRun(teamPath)
    sendMessage({ type: 'team-workspace-setup-run', teamPath })
  }

  return <section className="border border-border p-3" data-testid="team-setup">
    {available && <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-primary">Set up team</div>
          <div className="text-chat-meta text-secondary">
            This project has no group files. Write a starter team — a lead, devs, and cross-model reviewers — as editable files.
          </div>
        </div>
        {!preview && <button type="button" className="btn btn-primary text-xs px-3" data-testid="team-setup-open"
          disabled={!connected || pending !== null} onClick={open}>
          {pending === 'preview' ? 'Loading…' : 'Set up team'}
        </button>}
      </div>
      {preview && <div role="group" aria-label="Set up team preview" className="mt-2 border border-border p-2" data-testid="team-setup-preview">
        <p className="text-chat-meta">Writes to <code data-testid="team-setup-target">{preview.targetDir}</code>; nothing is staged or committed.</p>
        <ul className="mt-1 space-y-1 text-chat-meta">
          {preview.groups.map(group => <li key={group.id} data-testid="team-setup-group" data-group-id={group.id}>
            <span className="font-medium">{group.label}</span> <span className="text-secondary">({group.id}.md)</span>
            {' · '}{workersText(group)}{' · '}max {group.max}
            {group.crossModelReview && <span data-testid="team-setup-cross-model"> · cross-model review</span>}
            {group.description && <div className="text-secondary">{group.description}</div>}
          </li>)}
        </ul>
        {preview.warnings.length > 0 && <ul className="mt-1 text-chat-meta" data-testid="team-setup-warnings">
          {preview.warnings.map(warning => <li key={warning}>Warning: {warning}</li>)}
        </ul>}
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn btn-primary text-chat-meta" data-testid="team-setup-confirm"
            disabled={!connected || pending !== null} onClick={confirm}>{pending === 'run' ? 'Writing…' : 'Confirm'}</button>
          <button type="button" className="btn text-chat-meta" data-testid="team-setup-cancel"
            disabled={pending === 'run'} onClick={() => store().cancel(teamPath)}>Cancel</button>
        </div>
      </div>}
    </>}
    {result && <p className="mt-1 text-chat-meta" data-testid="team-setup-result" role={result.ok ? 'status' : 'alert'}>
      {resultText(result)}{result.ok && ' Edit the files directly; prompt changes apply to future agent starts.'}
    </p>}
    {!connected && available && <p className="text-chat-meta text-secondary" role="status">Disconnected: Set up team is unavailable.</p>}
  </section>
}
