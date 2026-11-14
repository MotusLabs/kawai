// Real tracker catalogue pressure and success-inclusive export totals.
import { expect,test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { schemaCopy } from './schemaDb'
import { ProcessObservationService } from '../metrics/observations/service'
import { TEAM_TOOL_PREFIX, type TeamCatalogue } from '../metrics/observations/toolCalls'
import { publicToolLabels } from '../metrics/observations/toolCallState'
const AT=Date.parse('2026-11-14T00:00:00Z')
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Many distinct foreign tools
test('500 foreign names share coarse export labels and at most 96 opaque detail identities; all text is absent',()=>{
  const db=schemaCopy();let serial=0
  const catalogue:TeamCatalogue={prefix:TEAM_TOOL_PREFIX,members:new Set(Array.from({length:80},(_,i)=>TEAM_TOOL_PREFIX+'member_'+i))}
  const service=new ProcessObservationService(db,id=>({sessionId:id,teamId:'team'}),()=>AT,250,catalogue)
  const emit=(body:Record<string,unknown>)=>service.chat.event('s',{id:'e'+(++serial),turnId:'t',at:new Date(AT).toISOString(),...body} as ChatEvent)
  try {
    expect(publicToolLabels(catalogue)).toHaveLength(96)
    expect(publicToolLabels(catalogue).slice(-1)).toEqual(['member_75'])
    service.start();emit({type:'turn_started'})
    for(let i=0;i<500;i++) {
      emit({type:'tool_call',toolCallId:'c'+i,tool:'mcp__foreign_canary_'+i+'__operation',input:{SECRET_INPUT:true}})
      emit({type:'tool_result',toolCallId:'c'+i,isError:true,output:'SECRET_OUTPUT'})
    }
    emit({type:'turn_completed',subtype:'success'})
    const rows=db.prepare("SELECT data FROM process_observations WHERE kind='tool'").all() as {data:string}[]
    const detail=rows.map(r=>JSON.parse(r.data))
    expect(detail).toHaveLength(500)
    expect(new Set(detail.filter(d=>d.identity!=='unknown').map(d=>d.identity)).size).toBe(96)
    const exported=db.prepare("SELECT labels,value FROM process_export_totals WHERE family='agent_tool_calls_total' AND bucket='value'").all() as {labels:string;value:number}[]
    expect(exported).toHaveLength(1);expect(exported[0]!.value).toBe(500)
    expect(JSON.parse(exported[0]!.labels)).toMatchObject({tool:'mcp:other',outcome:'failed',failure_class:'other'})
    const persisted=JSON.stringify(db.prepare("SELECT source_key,data FROM process_observations").all())+
      JSON.stringify(db.prepare('SELECT state FROM process_live_observations').all())+
      JSON.stringify(db.prepare('SELECT * FROM process_export_totals').all())
    expect(persisted).not.toContain('foreign_canary');expect(persisted).not.toContain('SECRET_INPUT');expect(persisted).not.toContain('SECRET_OUTPUT')
  }finally{service.stop();db.close()}
})
// @covers: tool-call-metrics › Tool results are classified once › Successes count in the failure ratio
test('A2: nine successes plus one failure export exactly ten committed results and no tool-call observations',()=>{
  const db=schemaCopy();let serial=0
  const service=new ProcessObservationService(db,id=>({sessionId:id,teamId:'team'}),()=>AT)
  const emit=(body:Record<string,unknown>)=>service.chat.event('s',{id:'e'+(++serial),turnId:'t',at:new Date(AT).toISOString(),...body} as ChatEvent)
  try {
    service.start();emit({type:'turn_started'})
    for(let i=0;i<10;i++) {
      emit({type:'tool_call',toolCallId:'c'+i,tool:'Bash'})
      const before=(db.prepare("SELECT coalesce(sum(value),0) n FROM process_export_totals WHERE family='agent_tool_calls_total' AND bucket='value'").get() as {n:number}).n
      expect(before).toBe(i)
      emit({type:'tool_result',toolCallId:'c'+i,isError:i===9,output:'neutral'})
    }
    emit({type:'turn_completed',subtype:'success'})
    const rows=db.prepare("SELECT labels,value FROM process_export_totals WHERE family='agent_tool_calls_total' AND bucket='value' ORDER BY labels").all() as {labels:string;value:number}[]
    expect(rows.map(r=>[JSON.parse(r.labels).outcome,JSON.parse(r.labels).failure_class,r.value]).sort()).toEqual([
      ['failed','command-failed',1],['success','none',9],
    ])
    // The metric-layer 10% ratio is checked in S3; here its durable numerator
    // and denominator are observed through the real tracker/accumulator.
    expect(rows.reduce((sum,r)=>sum+r.value,0)).toBe(10)
  }finally{service.stop();db.close()}
})
