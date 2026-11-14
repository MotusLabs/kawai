// Tool metric observations and honest closed-cohort coverage. No live state
// can promote a first result or turn an unknown streak into a recovered one.
import { MIN_SAMPLE,type MetricDef,type MetricRow,type MetricValue,type ToolMetricCoverage,type ToolStreakEntry } from '../../shared/processMetrics'
import type { StoredObservation } from '../../shared/processObservations'
import { firstAttemptEligible } from './observations/toolFirstAttempts'
import type { MetricsContext } from './metricsContext'
import { toolTurnKey } from './toolMetricInputs'
import type { Observation,Attribution } from './slices'
const IDS=['tool_failure_rate','tool_first_attempt_success','tool_abandoned_streaks','tool_mean_failures_before_recovery'] as const
type Call={tool:string;failureClass:string;failed:boolean}
export interface ToolWindow {
  observations:Observation[]
  calls:Call[]
  firstCoverage:ToolMetricCoverage
  abandoned:ToolStreakEntry[]
  recovered:ToolStreakEntry[]
}
const name=(row:StoredObservation)=>row.data.toolKind==='builtin'||row.data.toolKind==='team'
  ?String(row.kind==='tool_streak'?row.data.tool:row.data.identity):String(row.data.label??'other')
export function toolStreakEntry(row:StoredObservation):ToolStreakEntry|null {
  const d=row.data
  if(row.kind!=='tool_streak'||typeof d.tool!=='string'||!Number.isSafeInteger(d.length)||Number(d.length)<=0||
    !['abandoned','recovered','unknown'].includes(String(d.resolution))||typeof d.firstAt!=='string'||typeof d.closedAt!=='string'||
    !Number.isFinite(Date.parse(d.firstAt))||!Number.isFinite(Date.parse(d.closedAt))||d.firstAt>d.closedAt||
    !row.sessionId||!row.turnId||!row.toolCallId)return null
  return {factId:row.seq,tool:d.tool,length:Number(d.length),sessionId:row.sessionId,turnId:row.turnId,
    firstCallId:row.toolCallId,firstAt:d.firstAt,closedAt:d.closedAt}
}
export const closedOrder=(a:ToolStreakEntry,b:ToolStreakEntry)=>b.closedAt.localeCompare(a.closedAt)||b.factId-a.factId
export function toolWindow(ctx:MetricsContext):ToolWindow {
  const input=ctx.inputs.toolInputs
  const out:ToolWindow={observations:[],calls:[],firstCoverage:{pending:0,tainted:0,unrecorded:0,unavailable:0},abandoned:[],recovered:[]}
  const mark=(id:typeof IDS[number])=>out.observations.push({metric:id,partial:true})
  if(!input||ctx.fromMs<input.horizon)for(const id of IDS)mark(id)
  const closures=new Map<string,StoredObservation|undefined>()
  for(const row of input?.closures??[]){
    const key=toolTurnKey(row.sessionId,row.turnId)
    closures.set(key,closures.has(key)?undefined:row)
  }
  const firstCounts=new Map<string,number>()
  for(const row of input?.observations??[])if(row.kind==='tool'&&row.data.first===true&&row.data.toolKind==='team'){
    const key=JSON.stringify([row.sessionId,row.turnId,row.data.identity])
    firstCounts.set(key,(firstCounts.get(key)??0)+1)
  }
  for(const row of input?.observations??[]){
    if(row.observedAt<ctx.from||row.observedAt>=ctx.to)continue
    const d=row.data,tool=name(row),attribution:Attribution=ctx.resolver.byStartId(row.startId??null)
    if(row.kind==='tool') {
      if(d.eligible===true&&d.partial===false&&(d.outcome==='success'||d.outcome==='failed')){
        const failed=d.outcome==='failed',failureClass=failed?String(d.failureClass??'other'):'none'
        out.calls.push({tool,failureClass,failed})
        out.observations.push({metric:'tool_failure_rate',num:failed?1:0,den:1,key:tool+' · '+failureClass,attribution})
      }else mark('tool_failure_rate')
      if(d.eligible===undefined||d.toolKind===undefined){
        out.firstCoverage.unrecorded++;mark('tool_first_attempt_success');continue
      }
      if(d.toolKind!=='team')continue
      if(d.partial===true){out.firstCoverage.unavailable++;mark('tool_first_attempt_success');continue}
      if(d.first!==true)continue
      const key=toolTurnKey(row.sessionId,row.turnId),closure=closures.get(key)
      const unique=firstCounts.get(JSON.stringify([row.sessionId,row.turnId,d.identity]))===1
      if(unique&&firstAttemptEligible(row,closure,ctx.fromMs,ctx.toMs)&&(d.outcome==='success'||d.outcome==='failed')){
        out.observations.push({metric:'tool_first_attempt_success',value:d.outcome==='success'?1:0,key:tool,attribution})
      }else {
        if(!unique||!closure||closure.data.toolCoverageVersion!==1||typeof closure.data.toolFirstHistoryUnknown!=='boolean'){
          if(unique&&!closure&&input?.live.has(key))out.firstCoverage.pending++
          else out.firstCoverage.unrecorded++
        }else if(closure.data.toolFirstHistoryUnknown!==false)out.firstCoverage.tainted++
        else out.firstCoverage.unavailable++
        mark('tool_first_attempt_success')
      }
    }else if(row.kind==='tool_streak'){
      const entry=toolStreakEntry(row)
      if(!entry){mark('tool_abandoned_streaks');mark('tool_mean_failures_before_recovery');continue}
      if(d.resolution==='abandoned'){
        out.abandoned.push(entry);out.observations.push({metric:'tool_abandoned_streaks',value:1,key:tool,attribution})
      }else if(d.resolution==='recovered'){
        out.recovered.push(entry);out.observations.push({metric:'tool_mean_failures_before_recovery',value:entry.length,key:tool,attribution})
      }else {mark('tool_abandoned_streaks');mark('tool_mean_failures_before_recovery')}
    }
  }
  out.abandoned.sort(closedOrder)
  out.recovered.sort((a,b)=>b.length-a.length||closedOrder(a,b))
  return out
}
function failureRows(current:Call[],baseline:Call[]):MetricRow[] {
  const keys=new Map<string,{tool:string;failureClass:string}>()
  for(const row of [...current,...baseline])keys.set(JSON.stringify([row.tool,row.failureClass]),row)
  const stat=(calls:Call[],tool:string,failureClass:string)=>{
    const mine=calls.filter(row=>row.tool===tool),n=mine.length
    return {value:n?mine.filter(row=>row.failed&&row.failureClass===failureClass).length/n:null,n,insufficient:n<MIN_SAMPLE}
  }
  return [...keys.values()].sort((a,b)=>(a.tool+' · '+a.failureClass).localeCompare(b.tool+' · '+b.failureClass))
    .map(({tool,failureClass})=>({key:tool+' · '+failureClass,...stat(current,tool,failureClass),baseline:stat(baseline,tool,failureClass)}))
}
export function decorateToolMetric(def:MetricDef,value:MetricValue,current:ToolWindow,baseline:ToolWindow):MetricValue {
  if(def.family!=='tools')return value
  if(def.id==='tool_failure_rate')value.breakdown=failureRows(current.calls,baseline.calls)
  if(def.id==='tool_first_attempt_success')value.toolCoverage={...current.firstCoverage}
  if(def.id==='tool_abandoned_streaks')value.drill.toolStreaks={entries:current.abandoned.slice(0,50),total:current.abandoned.length,
    longestRecovered:current.recovered.slice(0,5)}
  if(def.id==='tool_mean_failures_before_recovery')value.drill.toolStreaks={entries:[],total:0,longestRecovered:current.recovered.slice(0,5)}
  return value
}
