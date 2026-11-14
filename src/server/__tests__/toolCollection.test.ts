import { expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { schemaCopy } from './schemaDb'
import { ObservationStore } from '../metrics/observations/store'
import { ObservationRecorder } from '../metrics/observations/recorder'
import { ChatObservationTracker } from '../metrics/observations/chatTracker'
import { TEAM_TOOL_PREFIX, type TeamCatalogue } from '../metrics/observations/toolCalls'
import { firstAttemptEligible } from '../metrics/observations/toolFirstAttempts'
const origin=Date.parse('2026-11-14T00:00:00Z')
const catalogue: TeamCatalogue={prefix:TEAM_TOOL_PREFIX,members:new Set([TEAM_TOOL_PREFIX+'task_get'])}
function harness() {
  const db=schemaCopy();let now=origin,seq=0,turn='t'
  const store=new ObservationStore(db,()=>now),recorder=new ObservationRecorder(store)
  const identity=()=>({sessionId:'s',teamId:'team'})
  let tracker=new ChatObservationTracker(recorder,identity,catalogue)
  const emit=(body:Record<string,unknown>)=>{
    now+=1000
    tracker.event('s',{id:'e'+(++seq),turnId:turn,at:new Date(now).toISOString(),...body} as ChatEvent)
  }
  const rows=()=>store.forTeam('team',0,1000)
  return {db,store,recorder,emit,rows,get tracker(){return tracker},setTurn(id:string){turn=id},
    advance(ms:number){now+=ms},
    restart(){tracker.checkpoint();tracker=new ChatObservationTracker(recorder,identity,catalogue);tracker.recover()},
    state(){return JSON.parse((db.prepare('SELECT state FROM process_live_observations WHERE session_id=?').get('s') as {state:string}).state)},
  }
}
// @covers: tool-call-metrics › Tool calls are admitted and identified within bounds › Replayed history stays outside
test('PC1 fences reject duplicate starts, closed turns and wrong-turn events before mutation',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    const before=h.state()
    h.emit({type:'turn_started'})
    h.emit({type:'tool_call',turnId:'other',toolCallId:'x',tool:'Bash'})
    expect(h.state()).toEqual(before)
    h.emit({type:'tool_call',toolCallId:'constructor',tool:'Bash'})
    h.emit({type:'tool_result',toolCallId:'constructor',output:'ok'})
    h.emit({type:'turn_completed',subtype:'success'})
    const count=h.rows().length
    h.emit({type:'turn_started'})
    expect(h.rows()).toHaveLength(count)
    expect(h.db.prepare('SELECT count(*) n FROM process_live_observations').get()).toEqual({n:0})
  } finally {h.db.close()}
})
// @covers: tool-call-metrics › Failure streaks close conservatively › Recording gap taints the turn
test('W2: event abort restores state and gap closes unknown before a later success',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    h.emit({type:'tool_call',toolCallId:'c1',tool:'Bash'})
    h.emit({type:'tool_result',toolCallId:'c1',isError:true,output:'neutral'})
    h.emit({type:'tool_call',toolCallId:'c2',tool:'Bash'})
    const before=h.state()
    h.db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON process_observations WHEN NEW.tool_call_id='c2' BEGIN SELECT RAISE(ABORT,'injected'); END")
    h.emit({type:'tool_result',toolCallId:'c2',isError:false,output:'not retained'})
    expect(h.state()).toEqual(before)
    expect(h.recorder.failures).toBe(1)
    h.db.exec('DROP TRIGGER fail_result')
    h.recorder.safe(()=>{})
    h.emit({type:'tool_call',toolCallId:'c3',tool:'Bash'})
    h.emit({type:'tool_result',toolCallId:'c3',output:'ok'})
    h.emit({type:'turn_completed',subtype:'success'})
    expect(h.rows().filter(r=>r.kind==='tool_streak').map(r=>r.data)).toMatchObject([{resolution:'unknown',length:1}])
    expect(h.rows().find(r=>r.kind==='turn_ended')?.data).toMatchObject({toolFirstHistoryUnknown:true})
  } finally {h.db.close()}
})
test('W2 checkpoint: a second closure abort rolls both facts and all maps back',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    for(const tool of ['Bash','Read']) {
      h.emit({type:'tool_call',toolCallId:tool,tool})
      h.emit({type:'tool_result',toolCallId:tool,isError:true,output:'neutral'})
    }
    h.recorder.safe(()=>{throw Error('known gap')})
    const before=h.state()
    h.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON process_observations WHEN NEW.kind='tool_streak' AND json_extract(NEW.data,'$.tool')='Read' BEGIN SELECT RAISE(ABORT,'second closure'); END")
    h.tracker.checkpoint()
    expect(h.rows().filter(r=>r.kind==='tool_streak')).toHaveLength(0)
    expect(h.state()).toEqual(before)
    h.db.exec('DROP TRIGGER fail_second')
    h.tracker.checkpoint();h.tracker.checkpoint()
    expect(h.rows().filter(r=>r.kind==='tool_streak').map(r=>[r.data.tool,r.data.length,r.data.resolution])).toEqual([['Bash',1,'unknown'],['Read',1,'unknown']])
  } finally {h.db.close()}
})
test('Foreign-name allocation rolls back and its raw map never enters persisted bytes',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    h.emit({type:'tool_call',toolCallId:'a',tool:'mcp__PRIVATE_CANARY_A__one'})
    h.db.exec("CREATE TRIGGER fail_slot BEFORE UPDATE ON process_live_observations WHEN json_extract(NEW.state,'$.tm.calls[1].id')='b' BEGIN SELECT RAISE(ABORT,'slot allocation'); END")
    h.emit({type:'tool_call',toolCallId:'b',tool:'mcp__PRIVATE_CANARY_B__two'})
    expect(h.state().tm.calls).toHaveLength(1)
    h.db.exec('DROP TRIGGER fail_slot')
    h.emit({type:'tool_call',toolCallId:'c',tool:'mcp__PRIVATE_CANARY_C__three'})
    h.emit({type:'tool_call',toolCallId:'b',tool:'mcp__PRIVATE_CANARY_B__two'})
    expect(h.state().tm.calls.map((c:{identity:string})=>c.identity)).toEqual(['slot-1','slot-2','slot-3'])
    h.emit({type:'tool_result',toolCallId:'a',isError:true,output:'OUTPUT_CANARY',input:'INPUT_CANARY'})
    const persisted=JSON.stringify([
      h.db.prepare('SELECT * FROM process_observations').all(),
      h.db.prepare('SELECT * FROM process_live_observations').all(),
      h.db.prepare('SELECT * FROM process_collection_checkpoints').all(),
      h.db.prepare('SELECT * FROM process_export_aliases').all(),
    ])
    for(const canary of ['PRIVATE_CANARY','OUTPUT_CANARY','INPUT_CANARY'])expect(persisted).not.toContain(canary)
  } finally {h.db.close()}
})
// @covers: tool-call-metrics › Tool calls are admitted and identified within bounds › Saturation stops measurement honestly
test('W11: first-seen tombstones survive saturation and detail pruning',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    for(let i=1;i<=511;i++) {
      h.emit({type:'tool_call',toolCallId:'c'+i,tool:'Read'})
      if(i!==1) h.emit({type:'tool_result',toolCallId:'c'+i,output:'ok'})
    }
    h.emit({type:'tool_result',toolCallId:'orphan',output:'orphan'})
    h.emit({type:'tool_call',toolCallId:'c513',tool:'Read'})
    h.emit({type:'tool_call',toolCallId:'c514',tool:'Read'})
    expect(h.state().tm.calls).toHaveLength(512)
    expect(h.state().tm.mode).toBe('saturated')
    h.emit({type:'tool_call',toolCallId:'c2',tool:'Read'})
    h.emit({type:'tool_result',toolCallId:'c1',output:'ok'})
    h.emit({type:'tool_result',toolCallId:'c1',output:'duplicate'})
    expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='tool' AND tool_call_id='c1'").get()).toEqual({n:1})
    h.advance(15*86400000)
    while(h.store.prune()===500) { /* existing bounded prune batches */ }
    h.emit({type:'tool_result',toolCallId:'c2',output:'after prune'})
    expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='tool' AND tool_call_id='c2'").get()).toEqual({n:0})
    expect(h.state().tm.calls).toHaveLength(512)
  } finally {h.db.close()}
})
// @covers: tool-call-metrics › Approval evidence retains first-resolution ownership › Question and late cards do not fabricate approval evidence
test('C1: question and late-card variants preserve generic dedupe without D2 slots',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    h.emit({type:'question_request',requestId:'question',questions:[]})
    h.emit({type:'request_resolved',requestId:'question',outcome:'answered'})
    for(let i=0;i<70;i++) h.emit({type:'request_resolved',requestId:'policy'+i,outcome:'allowed'})
    for(const outcome of ['answered','cancelled']) {
      h.emit({type:'request_resolved',requestId:outcome,outcome})
      h.emit({type:'approval_request',requestId:outcome,toolCallId:'x',tool:'Write',input:{}})
      h.emit({type:'request_resolved',requestId:outcome,outcome:'denied'})
    }
    h.emit({type:'approval_request',requestId:'question',toolCallId:'x',tool:'Write',input:{}})
    h.emit({type:'request_resolved',requestId:'question',outcome:'denied'})
    h.emit({type:'approval_request',requestId:'policy1',toolCallId:'x',tool:'Write',input:{}})
    expect(h.state().tm.links).toEqual([])
    expect(h.state().tm.denialIncomplete).toBe(false)
    h.emit({type:'tool_call',toolCallId:'c',tool:'Write'})
    h.emit({type:'approval_request',requestId:'manual',toolCallId:'c',tool:'Write',input:{}})
    h.emit({type:'request_resolved',requestId:'manual',outcome:'denied'})
    h.emit({type:'tool_result',toolCallId:'c',isError:true,output:'neutral'})
    h.emit({type:'turn_completed',subtype:'success'})
    expect(h.rows().find(r=>r.kind==='tool')?.data.failureClass).toBe('denied')
    expect(h.rows().find(r=>r.kind==='turn_ended')?.data).toMatchObject({unmatchedResolutions:72,toolDenialIncomplete:false})
  } finally {h.db.close()}
})
// @covers: tool-call-metrics › First attempts are measured only for closed, untainted turns › Orphan taint excludes an earlier first
// @covers: tool-call-metrics › Failure streaks close conservatively › Orphan result taints first history
// @covers: tool-call-metrics › First attempts are measured only for closed, untainted turns › Known first outside the window
test('R1: closure joins exclude orphan-tainted and unclosed first attempts without promotion',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    h.emit({type:'tool_call',toolCallId:'c',tool:TEAM_TOOL_PREFIX+'task_get'})
    h.emit({type:'tool_result',toolCallId:'c',output:'ok'})
    const first=h.rows().find(r=>r.kind==='tool')!
    expect(firstAttemptEligible(first,undefined,origin,origin+86400000)).toBe(false)
    h.emit({type:'tool_result',toolCallId:'orphan',output:'no call'})
    h.emit({type:'turn_completed',subtype:'success'})
    const closure=h.rows().find(r=>r.kind==='turn_ended')!
    expect(firstAttemptEligible(first,closure,origin,origin+86400000)).toBe(false)
    expect(first.data.first).toBe(true)
    expect(closure.data.toolFirstHistoryUnknown).toBe(true)
    expect(firstAttemptEligible(first,{...closure,data:{}},origin,origin+86400000)).toBe(false)
    expect(firstAttemptEligible(first,{...closure,data:{toolCoverageVersion:1,toolFirstHistoryUnknown:false}},origin+86400000,origin+2*86400000)).toBe(false)
  } finally {h.db.close()}
})

test('W3 W4: 64 real approval tombstones settle after overflow and pre-call transfer stays terminal',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    for(let i=0;i<65;i++)h.emit({type:'approval_request',requestId:'q'+i,toolCallId:'c'+i,tool:'Write',input:{}})
    expect(h.state().tm.links).toHaveLength(64)
    expect(h.state().tm.denialIncomplete).toBe(true)
    for(let i=0;i<64;i++) {
      h.emit({type:'request_resolved',requestId:'q'+i,outcome:i===0?'denied':i%2?'allowed':'cancelled'})
      h.emit({type:'tool_call',toolCallId:'c'+i,tool:'Write'})
      h.emit({type:'request_resolved',requestId:'q'+i,outcome:'denied'})
      h.emit({type:'tool_result',toolCallId:'c'+i,isError:true,output:'neutral'})
    }
    const results=h.rows().filter(r=>r.kind==='tool')
    expect(results).toHaveLength(64)
    expect(results.filter(r=>r.data.failureClass==='denied')).toHaveLength(1)
    expect(h.state().tm.links[0].state).toBe('transferred')
    h.emit({type:'turn_completed',subtype:'success'})
  } finally {h.db.close()}
})
test('R1: clean closed first remains eligible and tainted carrier survives detail pruning',()=>{
  const h=harness()
  try {
    h.emit({type:'turn_started'})
    h.emit({type:'tool_call',toolCallId:'first',tool:TEAM_TOOL_PREFIX+'task_get'})
    h.emit({type:'tool_result',toolCallId:'first',output:'ok'})
    const first=h.rows().find(r=>r.kind==='tool')!
    h.emit({type:'turn_completed',subtype:'success'})
    const clean=h.rows().find(r=>r.kind==='turn_ended')!
    expect(firstAttemptEligible(first,clean,origin,origin+86400000)).toBe(true)
    h.setTurn('tainted');h.emit({type:'turn_started'})
    h.emit({type:'tool_call',toolCallId:'next',tool:TEAM_TOOL_PREFIX+'task_get'})
    h.emit({type:'tool_result',toolCallId:'next',output:'ok'})
    const next=h.rows().filter(r=>r.kind==='tool').at(-1)!
    h.emit({type:'tool_result',toolCallId:'orphan',output:'neutral'})
    h.emit({type:'turn_completed',subtype:'success'})
    h.advance(20*86400000)
    while(h.store.prune()===500) { /* detail only */ }
    const tainted=h.rows().find(r=>r.kind==='turn_ended'&&r.turnId==='tainted')!
    expect(h.rows().filter(r=>r.kind==='tool')).toHaveLength(0)
    expect(firstAttemptEligible(next,tainted,origin,origin+86400000)).toBe(false)
  } finally {h.db.close()}
})
