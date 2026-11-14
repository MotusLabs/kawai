// The abandoned-streak pager owns no offset or page cap; it follows the
// server's frozen cursor until completion and keeps the authoritative total.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { ToolStreakDrill,ToolStreakEntry,ToolMeasurementStatus } from '@shared/processMetrics'
import { useMetricsStore,type MetricsView } from '../../../stores/metricsStore'
import { useSessionStore } from '../../../stores/sessionStore'
import { useChatStore } from '../../../stores/chatStore'

export function openToolStreak(entry:ToolStreakEntry):string|null {
  if(!useSessionStore.getState().sessions.some(s=>s.id===entry.sessionId))return 'not-found'
  useSessionStore.getState().setSelectedSessionId(entry.sessionId)
  useChatStore.getState().requestReveal(entry.sessionId,'tool:'+entry.firstCallId)
  return null
}
export function ToolMeasurement({status}:{status:ToolMeasurementStatus}) {
  return <div className="text-sm" data-testid="tool-measurement-status">
    <p>Tool collection recovery: {status.recovery.status}; pending {status.recovery.pendingCount??'unknown'};
      quarantined {status.recovery.quarantinedCount??'unknown'}.</p>
    <p>Tool export: {status.export.state}{status.export.availableSince?' since '+status.export.availableSince:''}{status.export.reason?' ('+status.export.reason+')':''}.</p>
    <p className="text-secondary">Export status does not establish collection completeness or source continuity.</p>
  </div>
}
export default function ToolDrill({teamPath,view,inline,connected,sendMessage}:{
  teamPath:string;view:MetricsView;inline:ToolStreakDrill;connected:boolean;sendMessage:SendClientMessage
}) {
  const [error,setError]=useState<string|null>(null)
  const page=view.toolDrill
  const rows=page?.entries??inline.entries
  const ask=(cursor:string|null)=>{
    const message=useMetricsStore.getState().requestToolPage(teamPath,cursor)
    if(message)sendMessage(message)
  }
  const list=(entries:ToolStreakEntry[])=>entries.map(e=><li key={e.factId}>
    <button type="button" className="btn text-sm" onClick={()=>setError(openToolStreak(e))}
      aria-label={'Open abandoned streak '+e.factId}>{e.tool}: {e.length} failures</button>
    <span className="text-secondary"> {new Date(e.closedAt).toLocaleString()}</span>
  </li>)
  return <section className="mt-2" aria-label="Tool streak drill">
    <p data-testid="tool-drill-total">Abandoned streaks: {page?.total??inline.total}</p>
    <ul>{list(rows)}</ul>
    {!page&&<button type="button" className="btn text-sm" disabled={!connected} onClick={()=>ask(null)}>Show all abandoned streaks</button>}
    {page?.nextCursor&&<button type="button" className="btn text-sm" disabled={!connected||page.loading}
      onClick={()=>ask(page.nextCursor)}>Load next page</button>}
    {page?.loading&&<p role="status">Loading streaks…</p>}
    {(page?.error||error)&&<p role="alert">{page?.error??error}</p>}
    {inline.longestRecovered.length>0&&<details><summary>Five longest recovered streaks</summary>
      <ul>{list(inline.longestRecovered)}</ul></details>}
  </section>
}
