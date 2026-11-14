// P1 uses an independent ST/W reference, not the production reducer.
import { expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { schemaCopy } from './schemaDb'
import { ProcessObservationService } from '../metrics/observations/service'
import { ObservationStore } from '../metrics/observations/store'
import { ObservationRecorder } from '../metrics/observations/recorder'
import { ChatObservationTracker } from '../metrics/observations/chatTracker'
import { TEAM_TOOL_PREFIX, type TeamCatalogue } from '../metrics/observations/toolCalls'
function mulberry32(seed:number) {
  return ()=>{let t=seed+=0x6D2B79F5;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296}
}
function runSequences(withExport:boolean):void {
  const random=mulberry32(0x7001)
  const tools=['Bash','Read',TEAM_TOOL_PREFIX+'task_get']
  for(let caseId=0;caseId<300;caseId++) {
    const db=schemaCopy();let now=Date.parse('2026-11-14T00:00:00Z'),serial=0,turn=0,tainted=false,gap=false
    const store=new ObservationStore(db,()=>now),recorder=new ObservationRecorder(store)
    const service=withExport?new ProcessObservationService(db,()=>({}),()=>now,250,{prefix:TEAM_TOOL_PREFIX,members:new Set([tools[2]!])}):undefined
    service?.start()
    const admitted=new Set<string>(),contributions=new Map<string,{calls:number;streaks:number;length:number}>()
    if(service)store.accumulate=row=>{
      const d=row.data,amount={calls:0,streaks:0,length:0}
      const accepts=(family:string,key:string)=>{
        const id=family+':'+key
        if(service.toolStatus().export.state==='active'){admitted.add(id);return true}
        return admitted.has(id)
      }
      if(row.kind==='tool'&&d.eligible===true&&d.partial===false) {
        if(accepts('calls',JSON.stringify([d.label,d.outcome,d.outcome==='success'?'none':d.failureClass])))amount.calls=1
      }
      if(row.kind==='tool_streak') {
        const key=JSON.stringify([d.label,d.resolution])
        if(accepts('streaks',key))amount.streaks=1
        if(accepts('histogram',key))amount.length=Number(d.length)
      }
      contributions.set(row.sourceKey,amount)
      service.store.accumulate!(row)
    }
    const identity=()=>({sessionId:'s',teamId:'team'})
    const catalogue:TeamCatalogue={prefix:TEAM_TOOL_PREFIX,members:new Set([tools[2]!])}
    let tracker=new ChatObservationTracker(recorder,identity,catalogue)
    const open=new Map<string,number>()
    const expected:[string,number,string][]=[],classes:[string,string|null,boolean][]=[]
    const emit=(body:Record<string,unknown>)=>{now+=1000;tracker.event('s',{id:'e'+(++serial),turnId:'t'+turn,at:new Date(now).toISOString(),...body} as ChatEvent)}
    const close=(resolution:string)=>{for(const [tool,length]of open)expected.push([tool,length,resolution]);open.clear()}
    const watch=()=>{if(gap){close('unknown');tainted=true;gap=false}}
    const start=()=>{turn++;tainted=false;gap=false;emit({type:'turn_started'})}
    const end=()=>{watch();close(tainted?'unknown':'abandoned');emit({type:'turn_completed',subtype:'success'})}
    const turns=1+Math.floor(random()*4),count=1+Math.floor(random()*60)
    start()
    try {
      for(let i=0;i<count;i++) {
        if(service&&caseId%2===1&&i===Math.floor(count/2)) {
          db.exec("CREATE TRIGGER export_abort BEFORE UPDATE ON process_collection_checkpoints WHEN NEW.source='tool-export-v2' BEGIN SELECT RAISE(ABORT,'export'); END")
          expect(service.toolExport.ensure()).toBe(false)
        }
        if(service&&caseId%2===1&&i===Math.floor(count*3/4)&&i>Math.floor(count/2)) {
          db.exec('DROP TRIGGER export_abort');expect(service.toolExport.ensure()).toBe(true)
        }
        const op=Math.floor(random()*8),tool=tools[Math.floor(random()*3)]!,short=tool===tools[2]?'task_get':tool
        if(op===5 && turn<turns) {end();start();continue}
        if(op===6) {
          watch();tracker.checkpoint();close('unknown');tainted=true
          tracker=new ChatObservationTracker(recorder,identity,catalogue);tracker.recover()
          if(turn<turns)start();else break
          continue
        }
        if(op===7) {watch();tracker.checkpoint();continue}
        if(op===4) {
          watch();close('unknown');tainted=true
          const id='orphan'+i;emit({type:'tool_result',toolCallId:id,isError:true,output:'neutral'})
          classes.push([id,null,false]);continue
        }
        watch()
        const id='c'+i;emit({type:'tool_call',toolCallId:id,tool})
        const failed=op!==2
        if(op===3) db.exec("CREATE TRIGGER p1_abort BEFORE INSERT ON process_observations WHEN NEW.tool_call_id='"+id+"' BEGIN SELECT RAISE(ABORT,'P1'); END")
        emit({type:'tool_result',toolCallId:id,isError:failed,output:'neutral'})
        if(op===3) {db.exec('DROP TRIGGER p1_abort');gap=true;continue}
        classes.push([id,failed?(tool==='Bash'?'command-failed':'other'):null,true])
        if(!tainted) {
          if(failed)open.set(short,(open.get(short)??0)+1)
          else if(open.has(short)){expected.push([short,open.get(short)!,'recovered']);open.delete(short)}
        }
        // Replays exercise F0/terminal tombstones, never another model transition.
        if(random()<0.2)emit({type:'tool_result',toolCallId:id,isError:!failed,output:'Input validation error: replay'})
      }
      end()
      const rows=db.prepare("SELECT kind,tool_call_id,data FROM process_observations WHERE kind IN ('tool','tool_streak') ORDER BY seq").all() as {kind:string,tool_call_id:string|null,data:string}[]
      expect(rows.filter(r=>r.kind==='tool_streak').map(r=>{const d=JSON.parse(r.data);return[d.tool,d.length,d.resolution]}), 'case '+caseId).toEqual(expected)
      const complete=rows.filter(r=>r.kind==='tool'&&!JSON.parse(r.data).partial).map(r=>{const d=JSON.parse(r.data);return[r.tool_call_id,d.failureClass??null,d.eligible]})
      // Orphan rows are partial generic details; eligibility is separately checked.
      expect(complete,'classes case '+caseId).toEqual(classes.filter(c=>c[2]))
      for(const c of classes.filter(c=>!c[2]))expect(rows.find(r=>r.tool_call_id===c[0])&&JSON.parse(rows.find(r=>r.tool_call_id===c[0])!.data).eligible).toBe(false)
      if(service) {
        const committed=db.prepare('SELECT source_key FROM process_observations').all() as {source_key:string}[]
        const expectedTotals=committed.reduce((sum,row)=>{
          const c=contributions.get(row.source_key)
          if(c){sum.calls+=c.calls;sum.streaks+=c.streaks;sum.length+=c.length;if(c.length)sum.histograms++}
          return sum
        },{calls:0,streaks:0,length:0,histograms:0})
        const value=(family:string,bucket:string)=>(db.prepare('SELECT coalesce(sum(value),0) n FROM process_export_totals WHERE family=? AND bucket=?').get(family,bucket) as {n:number}).n
        expect(value('agent_tool_calls_total','value'),'P2 calls '+caseId).toBe(expectedTotals.calls)
        expect(value('agent_tool_failure_streaks_total','value'),'P2 streaks '+caseId).toBe(expectedTotals.streaks)
        expect(value('agent_tool_failure_streak_length','sum'),'P2 sum '+caseId).toBe(expectedTotals.length)
        expect(value('agent_tool_failure_streak_length','count'),'P2 count '+caseId).toBe(expectedTotals.histograms)
        const before=db.prepare("SELECT * FROM process_export_totals WHERE bucket!='admitted' ORDER BY family,labels,bucket").all()
        db.exec('DROP TRIGGER IF EXISTS export_abort');service.toolExport.ensure()
        now+=91*86400000;store.prune()
        expect(db.prepare("SELECT * FROM process_export_totals WHERE bucket!='admitted' ORDER BY family,labels,bucket").all()).toEqual(before)
      }
    } finally {service?.stop();db.close()}
  }
}

// @covers: tool-call-metrics › Failure streaks close conservatively › Recovered after probing
// @covers: tool-call-metrics › Failure streaks close conservatively › Gave up
// @covers: tool-call-metrics › Failure streaks close conservatively › Restart mid-streak
test('P1 seed 0x7001: 300 real-tracker sequences match independent ST and W1-W2 reference',()=>runSequences(false))
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Scrape after pruning
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Admitted label keeps counting while unavailable
test('P2 seed 0x7001: same 300 sequences conserve only committed export-admitted results and streaks',()=>runSequences(true))
