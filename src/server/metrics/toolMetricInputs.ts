// Loaded inside the caller's metrics transaction: detail, retained carriers,
// live identities and collection horizon always belong to the same snapshot.
import type { Database } from 'bun:sqlite'
import type { StoredObservation } from '../../shared/processObservations'
import { mapStoredObservation } from './observations/store'
export interface ToolMetricInputs {
  observations:StoredObservation[]
  closures:StoredObservation[]
  live:ReadonlySet<string>
  horizon:number
}
export const toolTurnKey=(session:string|null|undefined,turn:string|null|undefined)=>JSON.stringify([session,turn])
export function loadToolMetricInputs(db:Database,team:string,from:string,to:string,end:number):ToolMetricInputs {
  const observations=(db.prepare("SELECT * FROM process_observations WHERE team_id=? AND kind IN ('tool','tool_streak') AND observed_at>=? AND observed_at<? ORDER BY observed_at,seq")
    .all(team,from,to) as Record<string,unknown>[]).map(mapStoredObservation)
  // A first's closure may be outside the detail cohort's time window. Require
  // identity probes: the team index otherwise rescans history for every turn.
  const closures=(db.prepare("SELECT c.* FROM process_observations c WHERE c.team_id=? AND c.kind='turn_ended' AND EXISTS (SELECT 1 FROM process_observations t INDEXED BY process_observations_turn WHERE t.team_id=c.team_id AND t.session_id=c.session_id AND t.turn_id=c.turn_id AND t.kind='tool' AND t.observed_at>=? AND t.observed_at<?) ORDER BY c.seq")
    .all(team,from,to) as Record<string,unknown>[]).map(mapStoredObservation)
  // Live matching is session-wide; use the same index's session prefix.
  const liveRows=db.prepare("SELECT l.session_id,json_extract(CASE WHEN json_valid(l.state) THEN l.state ELSE '{}' END,'$.scope.turnId') turn_id FROM process_live_observations l WHERE json_extract(CASE WHEN json_valid(l.state) THEN l.state ELSE '{}' END,'$.scope.sessionId')=l.session_id AND EXISTS (SELECT 1 FROM process_observations t INDEXED BY process_observations_turn WHERE t.team_id=? AND t.session_id=l.session_id AND t.kind='tool' AND t.observed_at>=? AND t.observed_at<?)")
    .all(team,from,to) as {session_id:string;turn_id:unknown}[]
  const live=new Set(liveRows.filter(r=>typeof r.turn_id==='string').map(r=>toolTurnKey(r.session_id,r.turn_id as string)))
  const checkpoints=new Map((db.prepare("SELECT source,value FROM process_collection_checkpoints WHERE source IN ('recording-start','detail-retained-since')")
    .all() as {source:string;value:string}[]).map(r=>[r.source,r.value]))
  const start=Date.parse(checkpoints.get('recording-start')??'')
  const retained=checkpoints.has('detail-retained-since')?Date.parse(checkpoints.get('detail-retained-since')!):end-14*86400000
  return {observations,closures,live,horizon:Number.isFinite(start)&&Number.isFinite(retained)?Math.max(start,retained,end-14*86400000):end}
}
