// Committed status, per-key process masks, warm caches and every team subscription.
// @reads: src/server/metrics/observations/service.ts
import { expect,test } from 'bun:test'
import fs from 'node:fs'
import type { ServerMessage,ClientMessage } from '../../shared/types'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { TeamMailbox } from '../team/TeamMailbox'
import { teamToolTable } from '../team/mailboxTools'
import { ChatConnections } from '../chat/ChatConnections'
import { ProcessObservationService } from '../metrics/observations/service'
import { MetricsReader } from '../metrics/computeMetrics'
import { ProcessReportService } from '../metrics/reportService'
import { MetricsSnapshot } from '../metrics/export/snapshot'
import { canonicalToolMeasurement } from '../metrics/toolMeasurementStatus'
import { Seed,END,TEAM } from './metricsSeed'
const OTHER='/other/.git'
const delay=()=>new Promise(resolve=>setTimeout(resolve,30))
function fixture() {
  const seed=new Seed(),db=seed.db;let now=END
  seed.task('one',72);seed.status('one','active','done',24)
  seed.task('other',72,'open',OTHER);seed.status('other','active','done',24,OTHER)
  db.prepare('INSERT INTO process_live_observations VALUES (?,?)').run('bad','{QUARANTINE_CANARY')
  let connections:ChatConnections|undefined,pushes=0
  const service=new ProcessObservationService(db,()=>({}),()=>now,5,undefined,{
    onEffectiveStatusChange:()=>{pushes++;connections?.publishMetricsAll()},
  })
  const reader=new MetricsReader(db,()=>now,undefined,()=>service.toolStatus())
  const reports=new ProcessReportService(db,reader,{now:()=>now})
  const manager={whenRestored:()=>Promise.resolve(),metrics:reader,reports,
    teamScopes:{resolve:async(path:string)=>path==='/repo'?{teamId:TEAM}:path==='/other'?{teamId:OTHER}:null},
  } as unknown as ChatSessionManager
  connections=new ChatConnections(manager)
  const messages:ServerMessage[]=[]
  const connection={send:(message:ServerMessage)=>messages.push(message)}
  const send=(message:ClientMessage)=>connections!.handle(connection,message)
  const snapshots=()=>messages.filter((m):m is Extract<ServerMessage,{type:'process-metrics-snapshot'}>=>m.type==='process-metrics-snapshot')
  const deps={teamOf:()=>TEAM,reader}
  const tool=teamToolTable({} as TeamMailbox,'caller',{metrics:deps}).find(t=>t.name==='team_metrics')!
  const readTool=(detail:'compact'|'full')=>tool.handler(tool.schema.parse({window:'7d',detail,teamId:OTHER}))
  const text=new MetricsSnapshot(service)
  return {db,service,reader,reports,send,snapshots,readTool,text,pushes:()=>pushes,advance(ms:number){now+=ms},
    close(){service.stop();db.close()}}
}
// @covers: team-process-metrics › Tool metrics › Failed status write shows unknown everywhere
// @covers: team-process-metrics › Tool metrics › Recovered status is pushed
// @covers: team-process-metrics › Tool metrics › Healthy recovery ticks leave views unchanged
test('W10a W10b: EACH fixed-key failure masks all real surfaces and fan-out once; identical-byte verification restores them',async()=>{
  for(const key of ['tool-export-v2','tool-recovery-quarantine'] as const) {
    const h=fixture()
    try {
      h.service.start();await delay()
      expect(h.service.toolStatus()).toMatchObject({export:{state:'active'},recovery:{status:'quarantined',quarantinedCount:1}})
      h.service.store.record({sourceKey:'result',teamId:TEAM,sessionId:'s',turnId:'t',toolCallId:'c',kind:'tool',
        observedAt:new Date(END).toISOString(),data:{category:'tool',startedAt:new Date(END).toISOString(),durationSeconds:1,
          outcome:'success',partial:false,eligible:true,first:true,identity:'Bash',toolKind:'builtin',label:'Bash',identityIncomplete:false}})
      await h.send({type:'process-metrics-open',teamPath:'/repo',window:'7d',slice:null})
      await h.send({type:'process-metrics-open',teamPath:'/other',window:'7d',slice:null})
      const beforeA=h.reader.read(TEAM,'7d',null),beforeB=h.reader.read(OTHER,'7d',null),beforeView=structuredClone(beforeA)
      const stored=h.reports.store.insertReport({teamId:TEAM,authorSession:'caller',window:'7d',periodStart:beforeA.periodStart,
        periodEnd:beforeA.periodEnd,summary:'snapshot',snapshot:beforeA,proposals:[]},new Date(END).toISOString())
      const beforeReport=h.reports.store.report(TEAM,stored.id)
      const warm=h.text.read(),raw=h.service.store.checkpoint(key),healthy=canonicalToolMeasurement(h.service.toolStatus())
      expect(warm).toContain('kawai_agent_tool_calls_total{')
      const initialPushes=h.pushes(),initialSnapshots=h.snapshots().length
      h.advance(1000);h.service.tick();h.service.tick();await delay()
      expect(canonicalToolMeasurement(h.service.toolStatus())).toBe(healthy)
      expect(h.pushes()).toBe(initialPushes);expect(h.snapshots()).toHaveLength(initialSnapshots)
      h.db.exec("CREATE TRIGGER status_abort BEFORE UPDATE ON process_collection_checkpoints WHEN NEW.source='"+key+"' BEGIN SELECT RAISE(ABORT,'status'); END")
      const fail=()=>key==='tool-export-v2'?h.service.toolExport.ensure():h.service.toolRecovery.write(true,2,0)
      expect(fail()).toBe(false)
      expect(h.service.store.checkpoint(key)).toBe(raw)
      const field=key==='tool-export-v2'?'export':'recovery'
      const assertMasked=(view:typeof beforeA.toolMeasurement)=>{
        if(field==='export')expect(view.export).toEqual({state:'unknown',reason:null,availableSince:null})
        else expect(view.recovery).toEqual({status:'unknown',quarantinedCount:null,pendingCount:null,checkedAt:null})
      }
      assertMasked(h.service.health().toolMeasurement)
      const current=h.reader.read(TEAM,'7d',null);assertMasked(current.toolMeasurement)
      expect(current.metrics).toBe(beforeA.metrics);expect(current.computedAt).toBe(beforeA.computedAt)
      expect(beforeA).toEqual(beforeView)
      for(const mode of ['compact','full'] as const) {
        const result=await h.readTool(mode) as typeof beforeA
        expect(result.teamId).toBe(TEAM);assertMasked(result.toolMeasurement)
        expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(32000)
      }
      assertMasked(h.reports.report(TEAM,stored.id)!.snapshot.toolMeasurement)
      expect(h.reports.store.report(TEAM,stored.id)).toEqual(beforeReport)
      const masked=h.text.read()
      expect(masked).not.toBe(warm)
      if(field==='export')for(const name of ['agent_tool_calls_total','agent_tool_failure_streaks_total','agent_tool_failure_streak_length'])expect(masked).not.toContain('kawai_'+name+'{')
      else expect(masked).toContain('quarantined=unknown pending=unknown')
      // Both changes before the delay coalesce; neither attempted count 2 nor stale count 1 escapes.
      expect(fail()).toBe(false);await delay()
      expect(h.pushes()).toBe(initialPushes+1)
      const pushed=h.snapshots().slice(initialSnapshots)
      expect(pushed.map(p=>p.teamId).sort()).toEqual([OTHER,TEAM].sort())
      for(const p of pushed){assertMasked(p.metrics.toolMeasurement);expect(p.metrics.metrics).toBe(p.teamId===TEAM?beforeA.metrics:beforeB.metrics)}
      expect(fail()).toBe(false);await delay();expect(h.pushes()).toBe(initialPushes+1)
      h.db.exec('DROP TRIGGER status_abort')
      expect(key==='tool-export-v2'?h.service.toolExport.ensure():h.service.toolRecovery.write(true,1,0)).toBe(true)
      expect(h.service.store.checkpoint(key)).toBe(raw)
      expect(canonicalToolMeasurement(h.service.toolStatus())).toBe(healthy)
      const restoredText=h.text.read()
      expect(restoredText).not.toBe(masked)
      expect(restoredText).toContain('export=active recovery=quarantined')
      expect(restoredText).toContain('quarantined=1 pending=0')
      expect(restoredText).toContain('kawai_agent_tool_calls_total{')
      await delay();expect(h.pushes()).toBe(initialPushes+2)
      expect(h.snapshots().slice(-2).map(p=>canonicalToolMeasurement(p.metrics.toolMeasurement))).toEqual([healthy,healthy])
      expect(()=>h.db.transaction(()=>{h.db.prepare("INSERT INTO process_collection_checkpoints VALUES ('unrelated','x')").run();throw Error('rollback')})()).toThrow('rollback')
      await delay();expect(h.pushes()).toBe(initialPushes+2)
    }finally{h.close()}
  }
})
// @covers: team-process-metrics › Tool metrics › Status change reaches open views without a refresh
// @covers: team-process-metrics › Tool metrics › Status visible while export is disabled
test('W10: a status-only budget refusal pushes both teams without recomputing cached numerics',async()=>{
  const h=fixture()
  try {
    h.service.start();await delay()
    await h.send({type:'process-metrics-open',teamPath:'/repo',window:'7d',slice:null})
    await h.send({type:'process-metrics-open',teamPath:'/other',window:'7d',slice:null})
    const old=h.snapshots(),numeric=old.map(s=>s.metrics.metrics),pushes=h.pushes()
    // A pre-existing admitted catalogue can exceed a newly effective budget;
    // activation must report the actual committed database, without deleting it.
    h.db.transaction(()=>{
      const insert=h.db.prepare("INSERT INTO process_export_totals VALUES ('task_stage_duration_seconds',?,'admitted',0)")
      for(let i=0;i<10000;i++)insert.run(JSON.stringify({team:'old-a'+i}))
      const other=h.db.prepare("INSERT INTO process_export_totals VALUES ('task_acceptance_duration_seconds',?,'admitted',0)")
      for(let i=0;i<10000;i++)other.run(JSON.stringify({team:'old-b'+i}))
    })()
    expect(h.service.toolExport.ensure()).toBe(true)
    expect(h.service.toolStatus().export).toMatchObject({state:'budget-unavailable',reason:'series-budget'})
    await delay()
    expect(h.pushes()).toBe(pushes+1)
    const latest=h.snapshots().slice(-2)
    expect(latest.map(s=>s.metrics.metrics)).toEqual(numeric)
    for(let i=0;i<2;i++) {
      expect(latest[i]!.metrics.metrics).toBe(numeric[i]!)
      expect(latest[i]!.metrics.toolMeasurement.export.state).toBe('budget-unavailable')
      expect(old[i]!.metrics.toolMeasurement.export.state).toBe('active')
    }
    for(const mode of ['compact','full'] as const)expect((await h.readTool(mode) as (typeof old)[number]['metrics']).toolMeasurement).toEqual(h.service.toolStatus())
  }finally{h.close()}
})

test('D8 service imports neither chat transport nor the team tool catalogue owner',()=>{
  const source=fs.readFileSync('src/server/metrics/observations/service.ts','utf8')
  expect(source).not.toMatch(/from\s+['"][^'"]*(?:ChatConnections|mailboxTools)['"]/)
})
