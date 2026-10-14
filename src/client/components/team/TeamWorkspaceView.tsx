// The Team page (team-workspace-pages §5): the team's full-width surface —
// a header naming the repository with a one-line strategy status that opens
// the Strategy tab (D5 replaces team-workspace's band), then the
// Strategy | Tasks | Messages | Mailbox tab strip (Members and Plans are
// reserved keys that render no tab and no placeholder), then the active
// tab's view. The page is the team views' only eventual host (D4); each tab
// view drives its own wire subscription, keyed by the team key. The URL
// location (D3) names the tab, sub-view, and selection; navigation goes
// through `useTeamLocationStore` so Back and Forward move with it.
import { useEffect, useMemo } from 'react'
import type { SendClientMessage } from '@shared/types'
import { useSessionStore } from '../../stores/sessionStore'
import { useStrategyStore, type StrategyView } from '../../stores/strategyStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useTeamLocationStore } from '../../hooks/useTeamLocation'
import { knownTeamKeys } from '../../utils/teamKey'
import {
  RENDERED_WORKSPACE_TABS,
  type TeamLocation,
  type WorkspaceTab,
} from '../../utils/teamLocation'

const TAB_LABELS: Record<WorkspaceTab, string> = {
  strategy: 'Strategy',
  tasks: 'Tasks',
  messages: 'Messages',
  mailbox: 'Mailbox',
  members: 'Members',
  plans: 'Plans',
}

/** The one-line strategy status: approved revision or none, and reviews open. */
export function strategyStatusLine(view: StrategyView | undefined): { text: string; sub: 'overview' | 'review'; revision?: number } {
  if (!view?.seen) return { text: 'Strategy: loading…', sub: 'overview' }
  if (!view.strategy) return { text: 'No strategy captured', sub: 'overview' }
  const detail = view.detail
  const inReview = detail ? detail.revisions.filter(revision => revision.status === 'in_review') : []
  const approved = view.strategy.currentApprovedRevision
  const approvalText = approved != null ? `revision ${approved} approved` : 'no approved revision yet'
  const reviewText = inReview.length > 0 ? ` · ${inReview.length} in review` : ''
  const latest = inReview.at(-1)
  return latest
    ? { text: `Strategy: ${approvalText}${reviewText}`, sub: 'review', revision: latest.revision }
    : { text: `Strategy: ${approvalText}${reviewText}`, sub: 'overview' }
}

export default function TeamWorkspaceView({ teamKey, location, sendMessage, connected, connectionEpoch }: {
  teamKey: string
  location: TeamLocation
  sendMessage: SendClientMessage
  connected: boolean
  connectionEpoch: number
}) {
  const sessions = useSessionStore(state => state.sessions)
  const hasLoaded = useSessionStore(state => state.hasLoaded)
  const repositories = useWorkspaceStore(state => state.snapshot?.repositories)
  const workspace = useTeamWorkspaceStore(state => state.views[teamKey])
  const strategy = useStrategyStore(state => state.views[teamKey])
  const navigate = useTeamLocationStore(state => state.navigate)

  // The page is open for this team; state stays across visits (D8).
  useEffect(() => {
    useTeamWorkspaceStore.getState().open(teamKey)
    return () => useTeamWorkspaceStore.getState().close(teamKey)
  }, [teamKey])
  // The URL's tab is the last-used tab (the header Team button reopens it).
  useEffect(() => { useTeamWorkspaceStore.getState().setTab(teamKey, location.tab) }, [teamKey, location.tab])

  // A key is known when it is a discovered repository's main checkout or a
  // chat's team key (the same population the server accepts, D1); anything
  // else opens the tab's default view with a notice (D3) and no subscription.
  const known = useMemo(
    () => knownTeamKeys(repositories, sessions),
    [repositories, sessions],
  )
  const unknown = hasLoaded && !known.has(teamKey)
  useEffect(() => {
    useTeamWorkspaceStore.getState().setNotice(teamKey, unknown ? `Unknown repository ${teamKey}` : null)
  }, [teamKey, unknown])

  // The status line reads the strategy snapshot the page subscribes to.
  useEffect(() => {
    if (!connected || unknown) return
    useStrategyStore.getState().open(teamKey)
    sendMessage({ type: 'strategy-open', teamPath: teamKey })
    return () => sendMessage({ type: 'strategy-close', teamPath: teamKey })
  }, [teamKey, connected, connectionEpoch, unknown, sendMessage])

  const status = strategyStatusLine(strategy)
  const openTab = (tab: WorkspaceTab) => navigate({ teamKey, tab })
  const openStrategyStatus = () => navigate({
    teamKey, tab: 'strategy',
    ...(status.sub === 'review' && status.revision !== undefined ? { sub: 'review', id: String(status.revision) } : { sub: status.sub }),
  })

  return <main data-testid="team-workspace" data-team-key={teamKey} className="flex min-h-0 min-w-0 flex-1 flex-col bg-base text-primary">
    <header className="border-b border-border p-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="truncate font-medium" data-testid="team-workspace-title" title={teamKey}>
          {teamKey.split('/').filter(Boolean).at(-1) ?? teamKey} · Team
        </h2>
      </div>
      <button type="button" className="mt-0.5 text-left text-sm text-secondary hover:text-primary hover:underline"
        data-testid="team-strategy-status" onClick={openStrategyStatus}>
        {status.text}
      </button>
      {!connected && <p role="status" className="mt-1 text-sm text-secondary">Disconnected — reconnect to update this team.</p>}
      {workspace?.notice && <p role="status" data-testid="team-workspace-notice" className="mt-1 text-sm text-secondary">{workspace.notice}</p>}
    </header>
    <nav role="tablist" aria-label="Team views" className="flex gap-1 border-b border-border px-3 py-2" data-testid="team-tab-strip">
      {RENDERED_WORKSPACE_TABS.map(tab => (
        <button key={tab} type="button" role="tab" aria-selected={location.tab === tab}
          data-testid={`team-tab-${tab}`}
          className={`btn text-sm ${location.tab === tab ? 'btn-primary' : ''}`}
          onClick={() => openTab(tab)}>
          {TAB_LABELS[tab]}
        </button>
      ))}
    </nav>
    {/* The active tab's view; reserved keys render nothing (no placeholder). */}
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid={`team-tab-body-${location.tab}`}>
      {location.tab === 'strategy' && <p className="p-3 text-sm text-secondary" role="status">Loading…</p>}
    </div>
  </main>
}
