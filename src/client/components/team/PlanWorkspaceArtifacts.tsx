// The selected change's canonical artifacts (plan-workspace 5.3): the lazy
// descriptor push from the server's canonical resolver, addressed in the
// source worktree's space. Opening one routes through the existing document
// reader — every hash, size, mtime and availability fact comes only from
// that selected document-open; an unobserved artifact reads `unread`, never
// a fabricated fact. The subscription follows the selected change: leaving
// it — by selection, plan, team or unmount — sends artifacts-close (B3).
import { useEffect } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { WorkspaceArtifactDescriptor, WorkspaceArtifactsView } from '@shared/planWorkspace'
import {
  documentKey, useTeamPlanWorkspaceStore, type PlanWorkspaceView,
} from '../../stores/teamPlanWorkspaceStore'
import { shortHash } from '../chat/strategyLabels'

const KIND_LABELS: Record<string, string> = {
  proposal: 'Proposal', design: 'Design', tasks: 'Tasks', specs: 'Spec',
}

export default function PlanWorkspaceArtifacts({ teamPath, planId, change, view, connected, connectionEpoch, sendMessage }: {
  teamPath: string
  planId: string
  change: string
  view: PlanWorkspaceView
  connected: boolean
  connectionEpoch: number
  sendMessage: SendClientMessage
}) {
  // The client half of B3: the close rides this effect's cleanup, so a
  // change, plan or team switch — and unmount — ends the subscription; a
  // reconnect epoch re-sends it onto the new connection.
  useEffect(() => {
    if (!connected) return
    sendMessage({ type: 'team-plan-workspace-artifacts-open', teamPath, planId, changeName: change })
    return () => sendMessage({ type: 'team-plan-workspace-artifacts-close', teamPath, planId, changeName: change })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamPath, planId, connected, connectionEpoch, change, sendMessage])
  const enumeration = view.artifacts[change] ?? null
  if (enumeration === null) {
    return <p role="status" data-testid="plan-workspace-artifacts-loading" className="mt-2 text-chat-meta text-secondary">
      Loading canonical artifacts…
    </p>
  }
  return <div data-testid="plan-workspace-artifacts" className="mt-2 border border-border p-2">
    <h4 className="font-medium">Canonical artifacts</h4>
    <ArtifactsBody teamPath={teamPath} change={change} enumeration={enumeration} view={view} />
  </div>
}

function ArtifactsBody({ teamPath, change, enumeration, view }: {
  teamPath: string
  change: string
  enumeration: WorkspaceArtifactsView
  view: PlanWorkspaceView
}) {
  if (!enumeration.ok) {
    // The server's fixed, path-free reason for this state (missing,
    // missing-in-worktree, ambiguous, cli-unavailable, uncontained).
    return <p role="status" data-testid="plan-workspace-artifacts-unavailable" className="text-chat-meta text-secondary">
      {enumeration.message}
    </p>
  }
  const source = enumeration.source.kind === 'archive'
    ? `archive entry ${enumeration.source.entry}`
    : `${enumeration.source.kind === 'main' ? 'main checkout' : 'worktree'} ${shortHash(enumeration.source.worktreeId)}`
  return <>
    <p className="text-chat-meta text-secondary" data-testid="plan-workspace-artifacts-source">
      Current source of {change}: {source}
    </p>
    <ul className="mt-1 space-y-0.5" data-testid="plan-workspace-artifacts-list">
      {enumeration.artifacts.map(artifact => (
        <ArtifactRow key={artifact.relativePath} teamPath={teamPath}
          worktreeId={enumeration.source.worktreeId} artifact={artifact} view={view} />
      ))}
    </ul>
  </>
}

/**
 * One artifact: opening it selects the document — the existing reader and
 * its document-open subscription then provide every observed fact. Until
 * then the row reads `unread`; once read it shows that view's real
 * availability, never a fabricated hash or size.
 */
function ArtifactRow({ teamPath, worktreeId, artifact, view }: {
  teamPath: string
  worktreeId: string
  artifact: WorkspaceArtifactDescriptor
  view: PlanWorkspaceView
}) {
  const key = documentKey({ worktreeId, relativePath: artifact.relativePath })
  const observed = view.documents[key] ?? null
  const selected = view.selectedDocument !== null && documentKey(view.selectedDocument) === key
  return <li className="flex items-baseline gap-2">
    <button type="button" data-testid={`plan-workspace-artifact-${artifact.kind}`}
      aria-current={selected ? 'true' : undefined}
      className={selected ? 'text-left font-medium underline' : 'text-left underline'}
      onClick={() => useTeamPlanWorkspaceStore.getState().openDocument(teamPath, { worktreeId, relativePath: artifact.relativePath })}>
      {KIND_LABELS[artifact.kind] ?? artifact.kind}
    </button>
    <span className="text-chat-meta text-secondary">{artifact.relativePath}</span>
    <span className="text-chat-meta text-secondary" data-testid={`plan-workspace-artifact-${artifact.kind}-state`}>
      {observed === null ? 'unread' : observed.stale ? `${observed.availability} (stale)` : observed.availability}
    </span>
  </li>
}
