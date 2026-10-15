// The Team page's bands above the tab strip (team-workspace D2 as reshaped by
// team-workspace-pages): the attention queue and the morning summary, both
// read from the workspace snapshot, on every tab. Each collapses on its own;
// the state lives per team in `teamWorkspaceStore` (attention starts open,
// the summary collapsed) and the header buttons state the counts, so a
// collapsed band still says what is waiting.
import type { AttentionItem, SummaryItem, TeamWorkspaceSnapshot } from '@shared/teamWorkspace'
import { attentionCounts } from '../../stores/teamWorkspaceDataStore'
import { DEFAULT_OPEN_BANDS, useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import type { TeamLocation } from '../../utils/teamLocation'
import { openAttentionLink } from './attentionLinks'
import TeamAttentionQueue from './TeamAttentionQueue'
import TeamMorningSummary from './TeamMorningSummary'

function BandToggle({ open, label, onClick, controls }: { open: boolean; label: string; onClick: () => void; controls: string }) {
  return <button type="button" className="btn text-chat-meta" aria-expanded={open} aria-controls={controls}
    data-testid={`band-toggle-${controls}`} onClick={onClick}>
    {open ? 'Hide' : 'Show'} {label}
  </button>
}

export default function TeamWorkspaceBands({ teamKey, snapshot, navigate }: {
  teamKey: string
  /** Null until the first snapshot arrives. */
  snapshot: TeamWorkspaceSnapshot | null
  navigate: (location: TeamLocation) => void
}) {
  const openBands = useTeamWorkspaceStore(state => state.views[teamKey]?.openBands) ?? DEFAULT_OPEN_BANDS
  const toggle = (band: string) => useTeamWorkspaceStore.getState().toggleBand(teamKey, band)
  const attentionOpen = openBands.includes('attention')
  const summaryOpen = openBands.includes('summary')
  const items = snapshot?.attention ?? []
  const counts = attentionCounts(items)
  const open = (item: AttentionItem | SummaryItem) => openAttentionLink(teamKey, item.link, navigate)
  return <div className="border-b border-border px-3 py-2" data-testid="team-workspace-bands">
    <div className="flex flex-wrap items-center gap-2">
      <BandToggle open={attentionOpen} controls="attention" label={`attention (${counts.human} need you, ${counts.agent} waiting)`}
        onClick={() => toggle('attention')} />
      <BandToggle open={summaryOpen} controls="summary" label="morning summary" onClick={() => toggle('summary')} />
    </div>
    {attentionOpen && <div id="attention" className="mt-2 max-h-72 overflow-auto">
      <TeamAttentionQueue items={items} loaded={snapshot !== null} onOpen={open} />
    </div>}
    {summaryOpen && snapshot && <div id="summary" className="mt-2 max-h-72 overflow-auto">
      <TeamMorningSummary summary={snapshot.summary} onOpen={open} />
    </div>}
  </div>
}
