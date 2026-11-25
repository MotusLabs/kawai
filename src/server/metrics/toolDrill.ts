// Stable D7 paging over retained abandoned facts. The cursor fixes the read
// horizon; later commits cannot shift the ordering or enter the cohort. The
// first page reads the window ending at `end` (the human pager passes now;
// an agent drill passes its fixed window end, bounded-metrics-reads D2).
import type { Database } from 'bun:sqlite'
import { WINDOW_MS,isMetricWindow,type MetricSlice,type MetricWindow } from '../../shared/processMetrics'
import type { ToolDrillPage } from '../../shared/metricsMessages'
import { mapStoredObservation } from './observations/store'
import { closedOrder,toolStreakEntry } from './toolMetrics'

interface Cursor {
  teamId:string
  slice:MetricSlice|null
  window:MetricWindow
  windowEnd:string
  pageSize:number
  highWater:number
  last:{closedAt:string;seq:number}
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===expected.sort().join(',')
const iso=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
export function validSlice(v:unknown):v is MetricSlice|null {
  if(v===null)return true
  if(!object(v))return false
  if(v.kind==='memoryFile')return keys(v,['kind','file'])&&typeof v.file==='string'&&v.file.trim()===v.file&&v.file.length>0
  return keys(v,['kind'])&&['group','profile','groupFileHash'].includes(String(v.kind))
}
function decode(raw:string):Cursor {
  try {
    if(raw.length>16384||!raw.length||!/^[A-Za-z0-9_-]+$/.test(raw))throw Error()
    const bytes=Buffer.from(raw,'base64url')
    if(bytes.toString('base64url')!==raw)throw Error()
    const v:unknown=JSON.parse(bytes.toString('utf8'))
    if(!object(v)||!keys(v,['teamId','slice','window','windowEnd','pageSize','highWater','last'])||
      typeof v.teamId!=='string'||!validSlice(v.slice)||!isMetricWindow(v.window)||!iso(v.windowEnd)||
      !integer(v.pageSize)||v.pageSize<1||v.pageSize>50||!integer(v.highWater)||
      !object(v.last)||!keys(v.last,['closedAt','seq'])||!iso(v.last.closedAt)||
      !integer(v.last.seq)||v.last.seq<1||v.last.seq>v.highWater)throw Error()
    return v as unknown as Cursor
  }catch {throw new Error('Malformed tool drill cursor')}
}
const encode=(v:Cursor)=>Buffer.from(JSON.stringify(v)).toString('base64url')
/** The window end a well-formed cursor is bound to; throws on a malformed one. */
export const toolDrillCursorEnd=(raw:string)=>decode(raw).windowEnd

export function readToolDrill(db:Database,teamId:string,window:MetricWindow,slice:MetricSlice|null,
  pageSize:number,cursor:string|null,end:number):ToolDrillPage {
  if(!isMetricWindow(window))throw new Error('Unknown tool drill window')
  if(!validSlice(slice))throw new Error('Invalid tool drill slice')
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>50)throw new Error('Tool drill page size must be 1–50')
  if(cursor!==null&&typeof cursor!=='string')throw new Error('Malformed tool drill cursor')
  const prior=cursor===null?null:decode(cursor)
  if(prior) {
    if(prior.teamId!==teamId)throw new Error('Tool drill cursor team mismatch')
    if(JSON.stringify(prior.slice)!==JSON.stringify(slice))throw new Error('Tool drill cursor slice mismatch')
    if(prior.window!==window)throw new Error('Tool drill cursor window mismatch')
    if(prior.pageSize!==pageSize)throw new Error('Tool drill cursor page size mismatch')
  }
  return db.transaction(()=>{
    const windowEnd=prior?.windowEnd??new Date(end).toISOString()
    const highWater=prior?.highWater??(db.prepare('SELECT coalesce(max(seq),0) n FROM process_observations').get() as {n:number}).n
    const from=new Date(Date.parse(windowEnd)-WINDOW_MS[window]).toISOString()
    // Validate stored facts before counting, so malformed rows never become
    // a reported total that the client cannot actually reach.
    const facts=(db.prepare("SELECT * FROM process_observations WHERE team_id=? AND kind='tool_streak' AND json_valid(data) AND json_type(CASE WHEN json_valid(data) THEN data ELSE '{}' END)='object' AND seq<=? AND observed_at>=? AND observed_at<? ORDER BY seq")
      .all(teamId,highWater,from,windowEnd) as Record<string,unknown>[])
      .map(mapStoredObservation).filter(row=>row.data.resolution==='abandoned')
      .flatMap(row=>{const e=toolStreakEntry(row);return e?[e]:[]}).sort(closedOrder)
    const remaining=prior?facts.filter(e=>e.closedAt<prior.last.closedAt||(e.closedAt===prior.last.closedAt&&e.factId<prior.last.seq)):facts
    const entries=remaining.slice(0,pageSize),last=entries.at(-1)
    const nextCursor=remaining.length>entries.length&&last?encode({teamId,slice,window,windowEnd,pageSize,highWater,
      last:{closedAt:last.closedAt,seq:last.factId}}):null
    return {teamId,window,slice,pageSize,total:facts.length,entries,nextCursor}
  })()
}
