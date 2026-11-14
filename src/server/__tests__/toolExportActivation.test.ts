// Atomic v2 reservations, exact weighted boundaries and committed event domain.
import { expect,test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { schemaCopy } from './schemaDb'
import { BoundedLabels } from '../metrics/export/boundedLabels'
import { ExportAccumulator } from '../metrics/export/accumulator'
import { ProcessObservationService } from '../metrics/observations/service'
import { MetricsSnapshot } from '../metrics/export/snapshot'
const AT=Date.parse('2026-11-14T00:00:00Z')
const CALL='agent_tool_calls_total',STREAK='agent_tool_failure_streaks_total',HIST='agent_tool_failure_streak_length'
const toolFamilies=[CALL,STREAK,HIST]
function weighted(db:Database):number {
  // Independent literal costs: four old duration families cost 13, three token
  // families cost 10, the new streak histogram costs 9; all others cost 1.
  return (db.prepare("SELECT coalesce(sum(CASE WHEN family IN ('task_acceptance_duration_seconds','task_stage_duration_seconds','agent_turn_duration_seconds','agent_compaction_duration_seconds') THEN 13 WHEN family IN ('agent_turn_tokens','agent_context_tokens','agent_context_threshold_tokens') THEN 10 WHEN family='agent_tool_failure_streak_length' THEN 9 ELSE 1 END),0) n FROM process_export_totals WHERE bucket='admitted'").get() as {n:number}).n
}
function fill(db:Database,target:number):void {
  let remaining=target-weighted(db),serial=0
  if(remaining<0)throw Error('fixture target below baseline')
  db.transaction(()=>{
    const insert=db.prepare("INSERT INTO process_export_totals VALUES (?,?,'admitted',0)")
    for(const family of ['task_acceptance_duration_seconds','task_stage_duration_seconds','agent_turn_duration_seconds']) {
      const count=Math.min(9998,Math.floor(remaining/13))
      for(let i=0;i<count;i++)insert.run(family,JSON.stringify({team:'fixture-'+(++serial)}))
      remaining-=count*13
    }
    for(let i=0;i<remaining;i++)insert.run('task_results_total',JSON.stringify({team:'fixture-'+(++serial)}))
  })()
  expect(weighted(db)).toBe(target)
}
const totals=(db:Database)=>db.prepare("SELECT * FROM process_export_totals WHERE bucket!='admitted' ORDER BY family,labels,bucket").all()
const admitted=(db:Database)=>(db.prepare("SELECT count(*) n FROM process_export_totals WHERE bucket='admitted'").get() as {n:number}).n
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Budget refusal stops all three families together
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Paid reservations are not reserved again
test('W7 W9: E+M+D exact activation boundaries and paid histogram admission',()=>{
  for(const [existing,expected]of [[249940,249986],[249954,250000],[249955,null],[249960,null]] as const) {
    const db=schemaCopy()
    try {
      const bounds=new BoundedLabels(db)
      expect(weighted(db)).toBe(107)
      fill(db,existing);const before=admitted(db)
      const marker=bounds.ensureToolExport(AT)
      if(expected===null) {
        expect(marker).toMatchObject({state:'budget-unavailable',reason:'series-budget',availableSince:null})
        expect(admitted(db)).toBe(before);expect(weighted(db)).toBe(existing)
      }else{
        expect(marker.state).toBe('active');expect(weighted(db)).toBe(expected)
        expect(admitted(db)-before).toBe(38) // three catch-alls plus 35 diagnostics.
        const after=admitted(db),raw=db.prepare("SELECT value FROM process_collection_checkpoints WHERE source='tool-export-v2'").get()
        bounds.ensureToolExport(AT+1000)
        expect(admitted(db)).toBe(after)
        expect(db.prepare("SELECT value FROM process_collection_checkpoints WHERE source='tool-export-v2'").get()).toEqual(raw)
        if(existing===249940) {
          const paid=new BoundedLabels(db,250000,10000,{exportActive:()=>true})
          expect(paid.labels(HIST,{tool:'Bash',resolution:'recovered'})).not.toBeNull()
          expect(weighted(db)).toBe(249995)
        }
      }
    }finally{db.close()}
  }
})
test('W9: normal 250000/250001 and per-family 9999/10000 are strict independent bounds',()=>{
  const db=schemaCopy()
  try {
    const bounds=new BoundedLabels(db);bounds.ensureToolExport(AT)
    fill(db,249999)
    expect(bounds.labels('task_results_total',{team:'last'})).toEqual({team:'team_1'})
    expect(weighted(db)).toBe(250000)
    expect(bounds.labels('task_results_total',{team:'over'})).toEqual({team:'other'})
    expect(weighted(db)).toBe(250000)
  }finally{db.close()}
  const familyDb=schemaCopy()
  try {
    const bounds=new BoundedLabels(familyDb);bounds.ensureToolExport(AT)
    familyDb.transaction(()=>{
      const insert=familyDb.prepare("INSERT INTO process_export_totals VALUES ('task_results_total',?,'admitted',0)")
      for(let i=0;i<9998;i++)insert.run(JSON.stringify({team:'old-'+i}))
    })()
    expect(bounds.labels('task_results_total',{team:'last'})).toEqual({team:'team_1'})
    expect((familyDb.prepare("SELECT count(*) n FROM process_export_totals WHERE family='task_results_total' AND bucket='admitted'").get() as {n:number}).n).toBe(10000)
    expect(bounds.labels('task_results_total',{team:'over'})).toEqual({team:'other'})
  }finally{familyDb.close()}
})
test('activation is one transaction: second insert abort restores marker and every reservation; diagnostic floor is 36',()=>{
  const db=schemaCopy()
  try {
    const bounds=new BoundedLabels(db),before=admitted(db)
    db.exec("CREATE TRIGGER reservation_abort BEFORE INSERT ON process_export_totals WHEN NEW.family='agent_tool_failure_streaks_total' BEGIN SELECT RAISE(ABORT,'reservation'); END")
    expect(()=>bounds.ensureToolExport(AT)).toThrow('reservation')
    expect(admitted(db)).toBe(before)
    expect(db.prepare("SELECT value FROM process_collection_checkpoints WHERE source='tool-export-v2'").get()).toBeNull()
    db.exec('DROP TRIGGER reservation_abort')
    expect(new BoundedLabels(db,250000,35).ensureToolExport(AT)).toMatchObject({state:'budget-unavailable',reason:'family-budget'})
    expect(admitted(db)).toBe(before)
    expect(new BoundedLabels(db,250000,36).ensureToolExport(AT)).toMatchObject({state:'active'})
    expect((db.prepare("SELECT count(*) n FROM process_export_totals WHERE family='export_label_overflow_total' AND bucket='admitted'").get() as {n:number}).n).toBe(36)
  }finally{db.close()}
})
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Reactivation starts a new boundary
test('W8: missing/corrupt marker is unknown until verification and a new interval never backfills',()=>{
  const db=schemaCopy();let now=AT
  const service=new ProcessObservationService(db,()=>({}),()=>now)
  try {
    expect(service.toolStatus().export.state).toBe('unknown')
    service.start();const first=service.toolStatus().export.availableSince
    for(const raw of [null,'{bad']) {
      if(raw===null)db.exec("DELETE FROM process_collection_checkpoints WHERE source='tool-export-v2'")
      else service.store.setCheckpoint('tool-export-v2',raw)
      expect(service.toolStatus().export.state).toBe('unknown')
      const before=totals(db);now+=1000;service.tick()
      expect(service.toolStatus().export.availableSince).toBe(new Date(now).toISOString())
      expect(service.toolStatus().export.availableSince).not.toBe(first)
      expect(totals(db)).toEqual(before)
    }
  }finally{service.stop();db.close()}
})
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Admitted label keeps counting while unavailable
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Scrape after pruning
// @covers: tool-call-metrics › Tool call metrics are exported behind an activation gate › Suppressed families render nothing
test('W13: admitted calls and both streak families keep committed values while closed; new labels write nothing',()=>{
  for(const state of ['budget-unavailable','unknown'] as const) {
    const db=schemaCopy();let now=AT
    const service=new ProcessObservationService(db,()=>({}),()=>now)
    try {
      service.start()
      const record=(id:string,kind:'tool'|'tool_streak',team='L')=>service.store.record({
        sourceKey:id,teamId:team,sessionId:'s',turnId:'t',toolCallId:id,kind,observedAt:new Date(now).toISOString(),
        data:kind==='tool'?{category:'tool',startedAt:new Date(now).toISOString(),durationSeconds:1,outcome:'failed',partial:false,eligible:true,first:true,identity:'Bash',toolKind:'builtin',label:'Bash',failureClass:'command-failed',identityIncomplete:false}:
          {tool:'Bash',toolKind:'builtin',label:'Bash',length:2,resolution:'recovered',firstAt:new Date(now).toISOString(),closedAt:new Date(now).toISOString()},
      })
      for(let i=0;i<10;i++){record('c'+i,'tool');record('s'+i,'tool_streak')}
      const sum=(family:string,bucket:string)=>(db.prepare('SELECT coalesce(sum(value),0) n FROM process_export_totals WHERE family=? AND bucket=?').get(family,bucket) as {n:number}).n
      expect(sum(CALL,'value')).toBe(10);expect(sum(STREAK,'value')).toBe(10);expect(sum(HIST,'count')).toBe(10)
      if(state==='unknown') {
        db.exec("CREATE TRIGGER key_abort BEFORE UPDATE ON process_collection_checkpoints WHEN NEW.source='tool-export-v2' BEGIN SELECT RAISE(ABORT,'key'); END")
        expect(service.toolExport.ensure()).toBe(false)
      }else {
        fill(db,250001);expect(service.toolExport.ensure()).toBe(true)
      }
      expect(service.toolStatus().export.state).toBe(state)
      now+=91*86400000;service.store.prune()
      expect(sum(CALL,'value')).toBe(10)
      record('L-after','tool');record('L-streak-after','tool_streak')
      expect(sum(CALL,'value')).toBe(11);expect(sum(STREAK,'value')).toBe(11);expect(sum(HIST,'count')).toBe(11);expect(sum(HIST,'sum')).toBe(22)
      const before=totals(db),aliases=db.prepare('SELECT * FROM process_export_aliases ORDER BY dimension,original').all(),rows=admitted(db)
      record('N-after','tool','N');record('N-streak-after','tool_streak','N')
      expect(totals(db)).toEqual(before);expect(admitted(db)).toBe(rows)
      expect(db.prepare('SELECT * FROM process_export_aliases ORDER BY dimension,original').all()).toEqual(aliases)
      const text=new MetricsSnapshot(service).read()
      for(const family of toolFamilies)expect(text).not.toContain('kawai_'+family+'{')
      expect(text).toContain('export='+state)
      // Unrelated non-tool contributions retain their old lifetime semantics.
      new ExportAccumulator(db).add('task_results_total',{team:'L'},1)
      expect(sum('task_results_total','value')).toBeGreaterThan(0)
    }finally{service.stop();db.close()}
  }
})
