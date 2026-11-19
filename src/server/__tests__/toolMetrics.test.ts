// Tools aggregates through the actual observation service and readMetrics.
import { expect,test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import { ObservationStore } from '../metrics/observations/store'
import type { ChatEvent } from '../../shared/chat'
import { ProcessObservationService } from '../metrics/observations/service'
import { readMetrics } from '../metrics/computeMetrics'
import { TEAM_TOOL_PREFIX } from '../metrics/observations/toolCalls'
import { DAY,END,Seed,TEAM } from './metricsSeed'
function fixture() {
  const seed=new Seed(),db=seed.db
  let now=END-8*DAY,serial=0
  const starts=new Map<string,string>()
  const catalogue={prefix:TEAM_TOOL_PREFIX,members:new Set([
    TEAM_TOOL_PREFIX+'task_submit_result',TEAM_TOOL_PREFIX+'task_get',
  ])} as const
  const service=new ProcessObservationService(db,id=>({sessionId:id,teamId:TEAM,startId:starts.get(id)??null}),()=>now,250,catalogue)
  service.start();now=END-DAY
  const emit=(session:string,turn:string,body:Record<string,unknown>)=>{
    now++
    service.chat.event(session,{id:'metric-e'+(++serial),turnId:turn,at:new Date(now).toISOString(),...body} as ChatEvent)
  }
  return {seed,db,service,starts,emit,
    time(at:number){now=at},
    start(session:string,profile='default'){const id=seed.start(session,72,{profile});starts.set(session,id);return id},
    open(session:string,turn:string){emit(session,turn,{type:'turn_started'})},
    call(session:string,turn:string,id:string,tool:string,failed=false,output='neutral'){
      emit(session,turn,{type:'tool_call',toolCallId:id,tool})
      emit(session,turn,{type:'tool_result',toolCallId:id,isError:failed,output})
    },
    end(session:string,turn:string){emit(session,turn,{type:'turn_completed',subtype:'success'})},
    read(){return readMetrics(db,TEAM,'7d',null,END)},
    close(){service.stop();db.close()},
  }
}
function tools(h:ReturnType<typeof fixture>,id:string) {
  const metric=h.read().metrics.find(m=>String(m.id)===id)
  expect(metric,'Tools metric '+id).toBeDefined()
  return metric!
}
// @covers: tool-call-metrics › Tool results are classified once › Successes count in the failure ratio
test('S3 A2: tool-only-origin results retain the ten-call failure denominator and pinned attribution',()=>{
  const h=fixture()
  try {
    h.start('only-tools','profile-tools');h.open('only-tools','t')
    for(let i=0;i<10;i++)h.call('only-tools','t','c'+i,'Bash',i===9)
    h.end('only-tools','t')
    expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='tool'").get()).toEqual({n:10})
    expect(h.db.prepare('SELECT count(*) n FROM chat_turn_usage').get()).toEqual({n:0})
    expect(h.db.prepare('SELECT count(*) n FROM team_tasks').get()).toEqual({n:0})
    const metric=tools(h,'tool_failure_rate')
    expect(metric).toMatchObject({value:0.1,n:10})
    expect(metric.breakdown?.find(r=>r.key==='Bash · command-failed')).toMatchObject({value:0.1,n:10})
  }finally{h.close()}
})

// @covers: team-process-metrics › Tool metrics › Misleading schema shows up
test('Misleading schema shows up: two of ten firsts give task_submit_result 20 percent without diluting it with other tools',()=>{
  const h=fixture()
  try{
    h.start('s')
    for(let i=0;i<10;i++){
      const t='schema-'+i;h.open('s',t)
      h.call('s',t,'submit-'+i,TEAM_TOOL_PREFIX+'task_submit_result',i>=2,'Input validation error: synthetic')
      // Later retries never replace the owned first.
      h.call('s',t,'retry-'+i,TEAM_TOOL_PREFIX+'task_submit_result',false)
      h.call('s',t,'get-'+i,TEAM_TOOL_PREFIX+'task_get',false);h.end('s',t)
    }
    const first=tools(h,'tool_first_attempt_success')
    expect(first.breakdown?.find(r=>r.key==='task_submit_result')).toMatchObject({value:0.2,n:10})
    expect(first.breakdown?.find(r=>r.key==='task_get')).toMatchObject({value:1,n:10})
    expect(first).toMatchObject({value:0.6,n:20,toolCoverage:{pending:0,tainted:0,unrecorded:0,unavailable:0}})
  }finally{h.close()}
})
// @covers: team-process-metrics › Tool metrics › Weak model gives up more
test('Weak model gives up more: three abandoned facts stay on their pinned profile; recovered mean excludes unknown lower bounds',()=>{
  const h=fixture()
  try{
    h.start('weak','weak-profile');h.start('strong','strong-profile')
    for(let i=0;i<3;i++){h.open('weak','w'+i);h.call('weak','w'+i,'w'+i,'Bash',true);h.end('weak','w'+i)}
    h.open('strong','r');h.call('strong','r','r1','Bash',true);h.call('strong','r','r2','Bash',true);h.call('strong','r','r3','Bash');h.end('strong','r')
    h.open('strong','unknown');h.call('strong','unknown','u','Read',true);h.service.chat.processEnded('strong')
    const metrics=readMetrics(h.db,TEAM,'7d',{kind:'profile'},END)
    const abandoned=metrics.metrics.find(m=>String(m.id)==='tool_abandoned_streaks')!
    expect(abandoned).toMatchObject({value:3,n:3,partial:true})
    expect(abandoned.slices?.map(r=>[r.key,r.value,r.n])).toEqual([['weak-profile',3,3]])
    expect(tools(h,'tool_mean_failures_before_recovery')).toMatchObject({value:2,n:1,partial:true})
  }finally{h.close()}
})
// @covers: tool-call-metrics › First attempts are measured only for closed, untainted turns › Orphan taint excludes an earlier first
// @covers: team-process-metrics › Tool metrics › Tainted turn excluded, not failed
test('S3 W1 W2: orphan and recorder-gap carriers exclude firsts at the metric layer without inventing failures or recovery',()=>{
  for(const gap of [false,true]){
    const h=fixture()
    try{
      h.start('s');h.open('s','t')
      h.call('s','t','first',TEAM_TOOL_PREFIX+'task_get',gap)
      if(gap){
        h.emit('s','t',{type:'tool_call',toolCallId:'lost',tool:TEAM_TOOL_PREFIX+'task_get'})
        h.db.exec("CREATE TRIGGER metric_abort BEFORE INSERT ON process_observations WHEN NEW.tool_call_id='lost' BEGIN SELECT RAISE(ABORT,'lost'); END")
        h.emit('s','t',{type:'tool_result',toolCallId:'lost',isError:true,output:'neutral'})
        h.db.exec('DROP TRIGGER metric_abort');h.service.recorder.safe(()=>undefined)
      }else h.emit('s','t',{type:'tool_result',toolCallId:'orphan',isError:true,output:'neutral'})
      h.call('s','t','later',TEAM_TOOL_PREFIX+'task_get');h.end('s','t')
      expect(tools(h,'tool_first_attempt_success')).toMatchObject({value:null,n:0,partial:true,toolCoverage:{tainted:1}})
      expect(tools(h,'tool_failure_rate')).toMatchObject({value:gap?0.5:0,n:2})
      expect(tools(h,'tool_mean_failures_before_recovery')).toMatchObject({value:null,n:0})
      const facts=h.db.prepare("SELECT data FROM process_observations WHERE kind='tool_streak'").all() as {data:string}[]
      expect(facts.map(r=>JSON.parse(r.data).resolution)).toEqual(gap?['unknown']:[])
    }finally{h.close()}
  }
})
test('S3 closed cohort excludes live, absent, legacy and partial carriers rather than reporting successes or zeros',()=>{
  for(const variant of ['live','missing','legacy','legacy-detail','partial'] as const){
    const h=fixture()
    try{
      h.start('s');h.open('s','t')
      if(variant==='legacy-detail'){
        h.service.store.record({sourceKey:'legacy-detail',teamId:TEAM,sessionId:'s',turnId:'t',toolCallId:'legacy',
          kind:'tool',observedAt:new Date(END-DAY+100).toISOString(),data:{category:'mcp',startedAt:new Date(END-DAY).toISOString(),
            durationSeconds:0.1,outcome:'success',partial:false}})
        h.end('s','t')
      }else if(variant==='partial'){
        h.emit('s','t',{type:'tool_call',toolCallId:'unfinished',tool:TEAM_TOOL_PREFIX+'task_get'});h.end('s','t')
      }else{
        h.call('s','t','c',TEAM_TOOL_PREFIX+'task_get')
        if(variant!=='live')h.end('s','t')
        if(variant==='missing')h.db.exec("DELETE FROM process_observations WHERE kind='turn_ended'")
        if(variant==='legacy')h.db.exec("UPDATE process_observations SET data=json_remove(data,'$.toolCoverageVersion') WHERE kind='turn_ended'")
      }
      const metric=tools(h,'tool_first_attempt_success')
      expect(metric).toMatchObject({value:null,n:0,partial:true})
      const coverage=metric.toolCoverage!
      expect(coverage.pending+coverage.tainted+coverage.unrecorded+coverage.unavailable).toBeGreaterThan(0)
      if(variant==='live')expect(coverage.pending).toBe(1)
      if(variant==='missing'||variant==='legacy')expect(coverage.unrecorded).toBe(1)
    }finally{h.close()}
  }
})
// @covers: tool-call-metrics › First attempts are measured only for closed, untainted turns › Known first outside the window
test('S3 first completion before the window is not promoted; a retained closure outside the cohort still joins',()=>{
  const h=fixture()
  try{
    h.starts.set('s',h.seed.start('s',10*24));h.time(END-8*DAY);h.open('s','t');h.call('s','t','first',TEAM_TOOL_PREFIX+'task_get')
    h.time(END-DAY);h.call('s','t','retry',TEAM_TOOL_PREFIX+'task_get');h.end('s','t')
    const metric=tools(h,'tool_first_attempt_success')
    expect(metric).toMatchObject({value:null,n:0,partial:false,baseline:{value:1,n:1}})
  }finally{h.close()}
  const later=fixture()
  try{
    later.start('s');later.open('s','t');later.call('s','t','first',TEAM_TOOL_PREFIX+'task_get')
    later.time(END+DAY);later.end('s','t')
    expect(tools(later,'tool_first_attempt_success')).toMatchObject({value:1,n:1})
  }finally{later.close()}
})
test('S3 tool-only starts and manifests slice by the pinned start, never a later start or profile guess',()=>{
  const h=fixture()
  try{
    const pinned=h.seed.start('s',72,{profile:'original',group:'original-group',groupFileHash:'g1',memoryHash:'m1'})
    h.seed.manifest('m1',{'MEMORY.md':'file-hash'});h.starts.set('s',pinned)
    h.seed.start('s',30,{profile:'later-profile',group:'later-group'})
    h.open('s','t');h.call('s','t','c','Bash',true);h.end('s','t')
    for(const [slice,key]of [[{kind:'profile'},'original'],[{kind:'group'},'original-group'],[{kind:'groupFileHash'},'g1'],[{kind:'memoryFile',file:'MEMORY.md'},'file-hash']] as const){
      const metric=readMetrics(h.db,TEAM,'7d',slice,END).metrics.find(m=>String(m.id)==='tool_failure_rate')!
      expect(metric.slices?.map(r=>[r.key,r.n])).toEqual([[key,1]])
    }
    h.starts.set('s','absent-pin');h.open('s','missing');h.call('s','missing','c2','Read',true);h.end('s','missing')
    const metric=readMetrics(h.db,TEAM,'7d',{kind:'profile'},END).metrics.find(m=>String(m.id)==='tool_failure_rate')!
    expect(metric.slices?.map(r=>[r.key,r.n])).toEqual([['original',1],['unrecorded',1]])
    expect(metric.slices?.some(r=>r.key==='later-profile')).toBe(false)
  }finally{h.close()}
})
test('S3 inline drill is capped at 50 plus total and keeps five longest recovered opening anchors through detail pruning',()=>{
  const h=fixture()
  try{
    h.start('s')
    for(let i=0;i<65;i++){const t='a'+i;h.open('s',t);h.call('s',t,'a-first-'+i,'Bash',true);h.end('s',t)}
    const long='opening-'+'x'.repeat(129)
    for(let length=1;length<=7;length++){
      const t='r'+length;h.open('s',t)
      for(let i=0;i<length;i++)h.call('s',t,i===0?long+length:'later-'+length+'-'+i,'Read',true)
      h.call('s',t,'success-'+length,'Read');h.end('s',t)
    }
    const drill=tools(h,'tool_abandoned_streaks').drill.toolStreaks!
    expect(drill.total).toBe(65);expect(drill.entries).toHaveLength(50)
    expect(drill.entries[0]!.firstCallId).toBe('a-first-64')
    expect(drill.longestRecovered.map(r=>r.length)).toEqual([7,6,5,4,3])
    expect(drill.longestRecovered[0]!.firstCallId).toBe(long+'7')
    h.time(END+20*DAY)
    while(h.service.store.prune()===500){}
    expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='tool'").get()).toEqual({n:0})
    expect(tools(h,'tool_abandoned_streaks')).toMatchObject({value:65,n:65})
    expect(tools(h,'tool_abandoned_streaks').drill.toolStreaks!.longestRecovered[0]!.firstCallId).toBe(long+'7')
  }finally{h.close()}
})

// @covers: tool-call-metrics › First attempts are measured only for closed, untainted turns › First actual call wins regardless of result order
test('S3 result ordering never promotes a later success over the first actual failed call',()=>{
  const h=fixture()
  try{
    h.start('s');h.open('s','t')
    for(const id of ['first','later'])h.emit('s','t',{type:'tool_call',toolCallId:id,tool:TEAM_TOOL_PREFIX+'task_get'})
    h.emit('s','t',{type:'tool_result',toolCallId:'later',isError:false,output:'ok'})
    h.emit('s','t',{type:'tool_result',toolCallId:'first',isError:true,output:'neutral'});h.end('s','t')
    expect(tools(h,'tool_first_attempt_success')).toMatchObject({value:0,n:1})
  }finally{h.close()}
})
// @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Concurrent closure commit
test('S3 detail and retained carrier share one real WAL read snapshot across a concurrent closure commit',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-cohort-read-')),file=path.join(dir,'test.db')
  const db=schemaDb(file);db.exec('PRAGMA journal_mode=WAL')
  const writer=new Database(file);let now=END-8*DAY,serial=0,interleaved=false
  const service=new ProcessObservationService(db,id=>({sessionId:id,teamId:TEAM}),()=>now,250,
    {prefix:TEAM_TOOL_PREFIX,members:new Set([TEAM_TOOL_PREFIX+'task_get'])})
  const originalDescriptor=Object.getOwnPropertyDescriptor(db,'prepare')
  const originalPrepare=db.prepare.bind(db)
  try{
    service.start();now=END-DAY
    const emit=(body:Record<string,unknown>)=>{now++;service.chat.event('s',{id:'race'+(++serial),turnId:'t',at:new Date(now).toISOString(),...body} as ChatEvent)}
    emit({type:'turn_started'});emit({type:'tool_call',toolCallId:'first',tool:TEAM_TOOL_PREFIX+'task_get'})
    emit({type:'tool_result',toolCallId:'first',isError:false,output:'ok'})
    const store=new ObservationStore(writer,()=>now+1)
    Object.defineProperty(db,'prepare',{configurable:true,writable:true,value:(...args:Parameters<typeof db.prepare>)=>{
      const statement=originalPrepare(...args)
      if(String(args[0]).startsWith('SELECT * FROM process_observations WHERE team_id=')){
        const all=statement.all.bind(statement)
        Object.defineProperty(statement,'all',{value:(...bindings:Parameters<typeof statement.all>)=>{
          expect(bindings).toEqual([TEAM,new Date(END-14*DAY).toISOString(),new Date(END).toISOString()])
          const rows=all(...bindings)
          if(!interleaved){
            interleaved=true
            writer.transaction(()=>{
              store.record({sourceKey:'concurrent-close',teamId:TEAM,sessionId:'s',turnId:'t',kind:'turn_ended',
                observedAt:new Date(now+1).toISOString(),data:{outcome:'success',partial:false,toolCoverageVersion:1,
                  toolFirstHistoryUnknown:false,toolStreakTainted:false,toolDenialIncomplete:false}})
              writer.prepare("DELETE FROM process_live_observations WHERE session_id='s'").run()
            })()
          }
          return rows
        }})
      }
      return statement
    }})
    const first=readMetrics(db,TEAM,'7d',null,END).metrics.find(m=>String(m.id)==='tool_first_attempt_success')!
    expect(interleaved).toBe(true)
    expect(first).toMatchObject({value:null,n:0,partial:true,toolCoverage:{pending:1}})
    if(originalDescriptor)Object.defineProperty(db,'prepare',originalDescriptor);else Reflect.deleteProperty(db,'prepare')
    const after=readMetrics(db,TEAM,'7d',null,END).metrics.find(m=>String(m.id)==='tool_first_attempt_success')!
    expect(after).toMatchObject({value:1,n:1})
  }finally{
    if(originalDescriptor)Object.defineProperty(db,'prepare',originalDescriptor);else Reflect.deleteProperty(db,'prepare')
    service.stop();writer.close();db.close();fs.rmSync(dir,{recursive:true,force:true})
  }
})
