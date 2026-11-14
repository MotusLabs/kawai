
import { expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { schemaCopy } from './schemaDb'
import { ObservationStore } from '../metrics/observations/store'
import { ObservationRecorder } from '../metrics/observations/recorder'
import { ChatObservationTracker } from '../metrics/observations/chatTracker'
import { ProcessObservationService } from '../metrics/observations/service'
const origin=Date.parse('2026-11-14T00:00:00Z')
function fixture() {
  const db=schemaCopy();let now=origin,n=0
  const store=new ObservationStore(db,()=>now), recorder=new ObservationRecorder(store)
  const tracker=new ChatObservationTracker(recorder,id=>({sessionId:id,teamId:'team'}))
  const emit=(session:string,body:Record<string,unknown>)=>{
    now+=1000
    tracker.event(session,{id:'e'+(++n),turnId:'t',at:new Date(now).toISOString(),...body} as ChatEvent)
  }
  const open=(id:string)=>{emit(id,{type:'turn_started'});emit(id,{type:'tool_call',toolCallId:'c',tool:'Bash'});emit(id,{type:'tool_result',toolCallId:'c',isError:true,output:'neutral'})}
  const raw=(id:string)=>(db.prepare('SELECT state FROM process_live_observations WHERE session_id=?').get(id) as {state:string}|null)?.state
  const service=()=>new ProcessObservationService(db,()=>{throw Error('manager not restored')},()=>now)
  const facts=()=>db.prepare("SELECT kind,data FROM process_observations WHERE kind IN ('tool_streak','turn_ended') ORDER BY seq").all() as {kind:string,data:string}[]
  return {db,store,tracker,emit,open,raw,service,facts,advance(ms:number){now+=ms}}
}
// @covers: tool-call-metrics › Unresolved recovery fails closed › Valid row recovers once
// @covers: tool-call-metrics › Unresolved recovery fails closed › Malformed row quarantined and blocked
// @covers: tool-call-metrics › Unresolved recovery fails closed › Quarantine persists across restart
test('W6 D9: intrinsic inventory recovers valid rows once and preserves quarantined bytes across restart',()=>{
  const h=fixture()
  let a:ProcessObservationService|undefined,b:ProcessObservationService|undefined
  try {
    h.open('a')
    const invalid=['{CORRUPT_CANARY',JSON.stringify({...JSON.parse(h.raw('a')!),scope:{sessionId:'foreign',turnId:'t'}}),
      JSON.stringify({...JSON.parse(h.raw('a')!),tm:{version:99}})]
    invalid.forEach((raw,i)=>h.db.prepare('INSERT INTO process_live_observations VALUES (?,?)').run('bad'+i,raw))
    a=h.service()
    expect(a.health().toolMeasurement.recovery.status).toBe('unknown')
    // Admission before inventory must not overwrite any checkpoint.
    a.chat.event('a',{type:'turn_started',id:'early',turnId:'new',at:new Date(origin).toISOString()} as ChatEvent)
    expect(h.raw('a')).toBeDefined()
    a.start();a.start()
    expect(h.raw('a')).toBeUndefined()
    expect(a.health().toolMeasurement.recovery).toMatchObject({status:'quarantined',quarantinedCount:3,pendingCount:0})
    expect(h.facts().filter(r=>r.kind==='tool_streak').map(r=>JSON.parse(r.data))).toMatchObject([{length:1,resolution:'unknown'}])
    expect(h.facts().filter(r=>r.kind==='turn_ended').map(r=>JSON.parse(r.data))).toMatchObject([{toolFirstHistoryUnknown:true}])
    a.stop();b=h.service();b.start()
    for(let i=0;i<invalid.length;i++) {
      b.chat.event('bad'+i,{type:'turn_started',id:'blocked'+i,turnId:'new',at:new Date(origin).toISOString()} as ChatEvent)
      expect(h.raw('bad'+i)).toBe(invalid[i])
    }
    expect(h.facts().filter(r=>r.kind==='tool_streak')).toHaveLength(1)
    expect(h.facts().filter(r=>r.kind==='turn_ended')).toHaveLength(1)
  } finally {a?.stop();b?.stop();h.db.close()}
})
test('D9: a failed valid-row transaction stays blocked until one existing tick retries it',()=>{
  const h=fixture();let service:ProcessObservationService|undefined
  try {
    h.open('a');const before=h.raw('a')
    h.db.exec("CREATE TRIGGER recovery_abort BEFORE INSERT ON process_observations WHEN NEW.kind='tool_streak' BEGIN SELECT RAISE(ABORT,'recovery'); END")
    service=h.service();let subscriptions=0,releases=0
    const subscribe=()=>{subscriptions++;return ()=>{releases++}}
    service.start([subscribe,subscribe,subscribe]);service.start([subscribe])
    expect(subscriptions).toBe(3)
    expect(h.raw('a')).toBe(before)
    expect(service.chat.blocked.has('a')).toBe(true)
    expect(service.health().toolMeasurement.recovery).toMatchObject({status:'pending',pendingCount:1})
    service.chat.event('a',{type:'turn_started',id:'blocked',turnId:'new',at:new Date(origin).toISOString()} as ChatEvent)
    expect(h.raw('a')).toBe(before)
    expect(h.facts()).toEqual([])
    h.db.exec('DROP TRIGGER recovery_abort')
    service.tick();service.tick()
    expect(h.raw('a')).toBeUndefined()
    expect(service.chat.blocked.has('a')).toBe(false)
    expect(h.facts().filter(r=>r.kind==='tool_streak')).toHaveLength(1)
    expect(subscriptions).toBe(3)
    service.stop();expect(releases).toBe(3)
  } finally {service?.stop();h.db.close()}
})
// @covers: tool-call-metrics › Unresolved recovery fails closed › Count write failure leaves health unknown
test('D9 recovery-key failure masks unchanged bytes while admission blocking remains independent',()=>{
  const h=fixture();let service:ProcessObservationService|undefined
  try {
    h.db.prepare('INSERT INTO process_live_observations VALUES (?,?)').run('bad','{CORRUPT_CANARY')
    service=h.service();service.start()
    const before=h.store.checkpoint('tool-recovery-quarantine')
    expect(service.health().toolMeasurement.recovery.status).toBe('quarantined')
    h.db.exec("CREATE TRIGGER recovery_key_abort BEFORE UPDATE ON process_collection_checkpoints WHEN NEW.source='tool-recovery-quarantine' BEGIN SELECT RAISE(ABORT,'key'); END")
    // A new process must verify even identical bytes; a healthy old tick has no write.
    service.stop();service=h.service();service.start()
    service.tick()
    expect(h.store.checkpoint('tool-recovery-quarantine')).toBe(before)
    expect(service.health().toolMeasurement.recovery).toEqual({status:'unknown',quarantinedCount:null,pendingCount:null,checkedAt:null})
    expect(service.health().toolMeasurement.export.state).toBe('active')
    expect(service.chat.blocked.has('bad')).toBe(true)
    expect(h.raw('bad')).toBe('{CORRUPT_CANARY')
    h.db.exec('DROP TRIGGER recovery_key_abort');service.tick()
    expect(service.health().toolMeasurement.recovery.status).toBe('quarantined')
    expect(h.store.checkpoint('tool-recovery-quarantine')).toBe(before)
  } finally {service?.stop();h.db.close()}
})
// @covers: tool-call-metrics › Approval evidence retains first-resolution ownership › Partial live closure taints first history
// @covers: tool-call-metrics › Approval evidence retains first-resolution ownership › Untransferred denial has no denominator
test('C2 N2: partial and replacement closes taint once; untransferred denials create no result or streak',()=>{
  const h=fixture()
  try {
    h.open('a');h.tracker.processEnded('a')
    h.open('b');h.emit('b',{type:'turn_started',turnId:'replacement'})
    h.emit('denial',{type:'turn_started'})
    h.emit('denial',{type:'approval_request',requestId:'q',toolCallId:'never',tool:'Write',input:{}})
    h.emit('denial',{type:'request_resolved',requestId:'q',outcome:'denied'})
    h.emit('denial',{type:'turn_completed',subtype:'success'})
    const ends=h.facts().filter(r=>r.kind==='turn_ended').map(r=>JSON.parse(r.data))
    expect(ends).toHaveLength(3)
    expect(ends.slice(0,2)).toMatchObject([{toolFirstHistoryUnknown:true},{toolFirstHistoryUnknown:true}])
    expect(ends[2]).toMatchObject({toolDenialIncomplete:true})
    expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE session_id='denial' AND kind IN ('tool','tool_streak')").get()).toEqual({n:0})
    h.advance(20*86400000)
    while(h.store.prune()===500) { /* bounded retention batches */ }
    expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='tool'").get()).toEqual({n:0})
    expect(h.facts().filter(r=>r.kind==='tool_streak')).toHaveLength(2)
    expect(h.facts().filter(r=>r.kind==='turn_ended')).toHaveLength(3)
  } finally {h.db.close()}
})

// @covers: tool-call-metrics › Unresolved recovery fails closed › Valid row recovers once
// @covers: tool-call-metrics › Unresolved recovery fails closed › Malformed row quarantined and blocked
test('R5: unknown activity phase recovers open work once while non-string phases remain quarantined',()=>{
  // An active phase and pending request cannot coexist in the generic producer:
  // the request closes the phase. Exercise both its open and accumulated forms.
  for(const pendingRequest of [false,true]) {
    const h=fixture();let service:ProcessObservationService|undefined
    try {
      h.emit('valid',{type:'turn_started'})
      h.emit('valid',{type:'tool_call',toolCallId:'open',tool:'Bash'})
      h.tracker.activity('valid',{phase:'foo'} as never)
      h.advance(2000)
      if(pendingRequest)h.emit('valid',{type:'approval_request',requestId:'open-q',tool:'Write',input:{}})
      h.advance(4000);h.tracker.checkpoint()
      const before=h.raw('valid')!
      const state=JSON.parse(before)
      expect(state.phase?.category??null).toBe(pendingRequest?null:'foo')
      expect(Object.keys(state.tools)).toEqual(['open'])
      const badRows=pendingRequest?[]:[null,17,{unexpected:true}].map((category,i)=>{
        const bad=structuredClone(state),id='bad-phase-'+i
        bad.scope.sessionId=id;bad.phase.category=category
        const raw=JSON.stringify(bad)
        h.db.prepare('INSERT INTO process_live_observations VALUES (?,?)').run(id,raw)
        return {id,raw}
      })
      h.db.exec("CREATE TRIGGER unknown_phase_abort BEFORE INSERT ON process_observations WHEN NEW.kind='turn_ended' AND NEW.session_id='valid' BEGIN SELECT RAISE(ABORT,'closure'); END")
      service=h.service();service.start()
      expect(h.raw('valid')).toBe(before)
      expect(service.chat.pendingRecovery.has('valid')).toBe(true)
      expect(service.chat.quarantined.has('valid')).toBe(false)
      expect(h.facts()).toEqual([])
      h.db.exec('DROP TRIGGER unknown_phase_abort')
      service.tick();service.tick()
      expect(h.raw('valid')).toBeUndefined()
      expect(service.chat.blocked.has('valid')).toBe(false)
      expect(service.chat.quarantined.has('valid')).toBe(false)
      const ends=h.facts().filter(r=>r.kind==='turn_ended').map(r=>JSON.parse(r.data))
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({outcome:'process-ended',partial:true,otherPhaseSeconds:pendingRequest?3:6,toolFirstHistoryUnknown:true})
      const rows=h.db.prepare("SELECT kind,data FROM process_observations WHERE session_id='valid' AND kind IN ('tool','request') ORDER BY seq").all() as {kind:string,data:string}[]
      expect(rows.filter(r=>r.kind==='tool').map(r=>JSON.parse(r.data))).toEqual([
        {category:'shell',startedAt:new Date(origin+2000).toISOString(),durationSeconds:pendingRequest?3:6,outcome:'unavailable',partial:true},
      ])
      expect(rows.filter(r=>r.kind==='request')).toHaveLength(pendingRequest?1:0)
      if(pendingRequest)expect(JSON.parse(rows.find(r=>r.kind==='request')!.data)).toMatchObject({requestKind:'approval',durationSeconds:4,partial:true,outcome:'unavailable'})
      for(const bad of badRows) {
        expect(h.raw(bad.id)).toBe(bad.raw)
        expect(service.chat.blocked.has(bad.id)).toBe(true)
        expect(service.chat.quarantined.has(bad.id)).toBe(true)
      }
      expect(service.health().toolMeasurement.recovery).toMatchObject({pendingCount:0,quarantinedCount:badRows.length})
    } finally {service?.stop();h.db.close()}
  }
})

// @covers: tool-call-metrics › Failure streaks close conservatively › Long opening call survives closure and recovery
test('Q1: a 129-character opening call survives normal restart and tick closure without blocking other sessions',()=>{
  for(const mode of ['normal','restart','tick']) {
    const h=fixture();let service:ProcessObservationService|undefined
    try {
      const create=()=>new ProcessObservationService(h.db,id=>({sessionId:id,teamId:'team'}),h.store.now)
      service=create();service.start()
      let seq=0
      const emit=(id:string,body:Record<string,unknown>)=>{
        h.advance(1000)
        service!.chat.event(id,{id:'long-e'+(++seq),turnId:'t',at:new Date(h.store.now()).toISOString(),...body} as ChatEvent)
      }
      const opening='external-call-'+ 'x'.repeat(115)
      expect(opening).toHaveLength(129)
      emit('a',{type:'turn_started'})
      emit('a',{type:'tool_call',toolCallId:opening,tool:'Bash'})
      emit('a',{type:'tool_result',toolCallId:opening,isError:true,output:'neutral'})
      if(mode==='normal') {
        emit('a',{type:'tool_call',toolCallId:'success',tool:'Bash'})
        emit('a',{type:'tool_result',toolCallId:'success',output:'ok'})
        emit('a',{type:'turn_completed',subtype:'success'})
      } else {
        service.chat.checkpoint();service.stop()
        if(mode==='tick')h.db.exec("CREATE TRIGGER long_recovery_abort BEFORE INSERT ON process_observations WHEN NEW.kind='tool_streak' AND NEW.session_id='a' BEGIN SELECT RAISE(ABORT,'first recovery'); END")
        service=create();service.start()
        if(mode==='tick') {
          expect(service.chat.pendingRecovery.has('a')).toBe(true)
          h.db.exec('DROP TRIGGER long_recovery_abort')
          service.tick();service.tick()
        }
      }
      const rows=h.db.prepare("SELECT tool_call_id,data FROM process_observations WHERE session_id='a' AND kind='tool_streak'").all() as {tool_call_id:string,data:string}[]
      expect(rows).toHaveLength(1)
      expect(rows[0]!.tool_call_id).toBe(opening)
      expect(JSON.parse(rows[0]!.data)).toMatchObject({length:1,resolution:mode==='normal'?'recovered':'unknown'})
      expect(JSON.parse(rows[0]!.data).firstCallId).toBeUndefined()
      expect(h.raw('a')).toBeUndefined()
      expect(service.chat.pendingRecovery.has('a')).toBe(false)
      expect(service.chat.blocked.has('a')).toBe(false)
      const failures=service.recorder.failures
      emit('other',{type:'turn_started'})
      emit('other',{type:'tool_call',toolCallId:'other-c',tool:'Read'})
      emit('other',{type:'tool_result',toolCallId:'other-c',output:'ok'})
      emit('other',{type:'turn_completed',subtype:'success'})
      service.tick()
      expect(service.recorder.failures).toBe(failures)
      expect(h.db.prepare("SELECT count(*) n FROM process_observations WHERE session_id='other' AND kind='turn_ended'").get()).toEqual({n:1})
    } finally {service?.stop();h.db.close()}
  }
})
test('Q2: healthy recovery ticks preserve bytes and checkedAt while a new process must verify them',()=>{
  const h=fixture();let service:ProcessObservationService|undefined
  try {
    service=h.service();service.start()
    const before=h.store.checkpoint('tool-recovery-quarantine')
    const status=service.health().toolMeasurement.recovery
    h.db.exec("CREATE TRIGGER stable_recovery BEFORE UPDATE ON process_collection_checkpoints WHEN NEW.source='tool-recovery-quarantine' BEGIN SELECT RAISE(ABORT,'healthy must not rewrite'); END")
    for(let i=0;i<3;i++) {
      h.advance(30000);service.tick()
      expect(h.store.checkpoint('tool-recovery-quarantine')).toBe(before)
      expect(service.health().toolMeasurement.recovery).toEqual(status)
      expect(service.recorder.failures).toBe(0)
    }
    service.stop();service=h.service();service.start()
    expect(service.health().toolMeasurement.recovery).toEqual({status:'unknown',quarantinedCount:null,pendingCount:null,checkedAt:null})
    expect(h.store.checkpoint('tool-recovery-quarantine')).toBe(before)
    h.db.exec('DROP TRIGGER stable_recovery');service.tick()
    expect(service.health().toolMeasurement.recovery).toEqual(status)
    expect(h.store.checkpoint('tool-recovery-quarantine')).toBe(before)
  } finally {service?.stop();h.db.close()}
})
