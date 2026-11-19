// compact-observation-detail T1 rows E3, E7 and E8 through the production
// composition (oracle hazard M1): SDK frames enter the fake query, the driver
// maps them to chat events, ChatSessionManager feeds the observation tracker,
// and the rows are read back from the database the server opened.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ChatConnections } from '../chat/ChatConnections'
import { SessionRegistry } from '../SessionRegistry'
import type { ChatEvent } from '../../shared/chat'
import type { ServerMessage } from '../../shared/types'
import { initDatabase, type SessionDatabase } from '../db'
import { managedManager, closeDispatchers, createHarness, flush, initMessage, installManagerCleanup, resultWithWindow, spawned, waitForCondition } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

const toolUse = (id: string, name: string): SDKMessage => ({
  type: 'assistant',
  message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }], role: 'assistant' },
  parent_tool_use_id: null,
  uuid: `uuid-${id}`,
  session_id: 'sdk-1',
}) as unknown as SDKMessage

const toolResult = (id: string): SDKMessage => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out' }] },
  parent_tool_use_id: null,
  uuid: `uuid-result-${id}`,
  session_id: 'sdk-1',
}) as unknown as SDKMessage

describe('ChatSessionManager observation rows', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalHome = process.env.HOME
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatobs-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })

  afterEach(() => {
    for (const [name, value] of [['ANTHROPIC_API_KEY', originalApiKey], ['HOME', originalHome], ['CLAUDE_CONFIG_DIR', originalConfigDir]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // @covers: process-observations › Unmatched request resolutions are counted, not stored › Auto-approved tool
  // @covers: process-observations › Tool calls and requests are stored once, at completion › Call open at turn end
  test('an auto-approved call stores one tool row, a policy grant is only counted, and an open call closes partial', async () => {
    const h = await createHarness(db)
    const created = h.manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    expect(h.manager.setApprovalPolicy(id, 'auto')).toEqual({ ok: true })
    expect((await h.manager.send(id, 'run a command')).ok).toBe(true)
    await spawned(h.handles)
    const handle = h.handles[0]!
    handle.push(initMessage('sdk-obs'))
    handle.push(toolUse('toolu_1', 'Bash'))
    await flush()
    const grant = handle.options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'sdk-req-1' })
    await expect(grant).resolves.toMatchObject({ behavior: 'allow' })
    handle.push(toolResult('toolu_1'))
    handle.push(resultWithWindow())
    await flush()
    // Second turn: a call still running when the turn ends.
    expect((await h.manager.send(id, 'start another')).ok).toBe(true)
    handle.push(toolUse('toolu_2', 'Read'))
    handle.push(resultWithWindow())
    await flush()

    const rows = (db.db.prepare("SELECT kind,tool_call_id,data FROM process_observations WHERE kind IN ('tool','request','turn_ended','activity') ORDER BY seq").all() as { kind: string; tool_call_id: string | null; data: string }[])
      .map(row => ({ kind: row.kind, toolCallId: row.tool_call_id, data: JSON.parse(row.data) as Record<string, unknown> }))
    // E3: one row for the completed call.
    expect(rows.filter(row => row.kind === 'tool' && row.toolCallId === 'toolu_1').map(row => row.data)).toEqual([
      expect.objectContaining({ category: 'shell', outcome: 'success', partial: false }),
    ])
    // E7: the policy grant had no approval request; nothing stored, one counted.
    expect(rows.filter(row => row.kind === 'request')).toEqual([])
    const ends = rows.filter(row => row.kind === 'turn_ended').map(row => row.data)
    expect(ends).toHaveLength(2)
    expect(ends[0]).toMatchObject({ outcome: 'success', unmatchedResolutions: 1 })
    // E8: the open call closes as one partial row.
    expect(rows.filter(row => row.kind === 'tool' && row.toolCallId === 'toolu_2').map(row => row.data)).toEqual([
      expect.objectContaining({ outcome: 'unavailable', partial: true }),
    ])
    expect(ends[1]).toMatchObject({ unmatchedResolutions: 0, thinkingSeconds: expect.any(Number) })
    expect(rows.filter(row => row.kind === 'activity')).toEqual([])
    expect(db.db.prepare("SELECT count(*) AS n FROM process_observation_keys WHERE source_key LIKE 'chat:%'").get()).toEqual({ n: 0 })
    h.manager.shutdown()
  })
  async function deniedWitness(native:boolean) {
    const h=await createHarness(db)
    const created=h.manager.createSession({projectPath:'/tmp/proj'})
    if(!created.ok)throw Error(created.error)
    const id=created.session.id
    expect(h.manager.setApprovalPolicy(id,'manual')).toEqual({ok:true})
    expect((await h.manager.send(id,'write a file')).ok).toBe(true)
    await spawned(h.handles)
    const handle=h.handles[0]!
    try {
      handle.push(initMessage('sdk-denial'))
      // Exact same tool/input populates the adapter's audit fallback even without native ID.
      handle.push(toolUse('native-c','Write'))
      await flush()
      expect(h.events.some(e=>e.event.type==='tool_call'&&e.event.toolCallId==='native-c')).toBe(true)
      const permission=handle.options.canUseTool!('Write',{},{
        signal:new AbortController().signal,...(native?{toolUseID:'native-c'}:{}),
      } as never)
      await flush()
      const card=h.events.find(e=>e.event.type==='approval_request')?.event
      if(!card||card.type!=='approval_request')throw Error('real approval card missing')
      expect(card.tool).toBe('Write')
      expect(h.manager.resolveApproval(id,card.requestId,'deny')).toEqual({ok:true})
      await expect(permission).resolves.toMatchObject({behavior:'deny'})
      const failed=toolResult('native-c') as unknown as {message:{content:Record<string,unknown>[]}}
      failed.message.content[0]!.is_error=true
      failed.message.content[0]!.content='neutral failed result'
      handle.push(failed as unknown as SDKMessage)
      handle.push(resultWithWindow())
      await flush()
      const rows=db.db.prepare("SELECT kind,data FROM process_observations WHERE session_id=? AND kind IN ('tool','turn_ended') ORDER BY seq").all(id) as {kind:string,data:string}[]
      const result=rows.filter(r=>r.kind==='tool').map(r=>JSON.parse(r.data))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({eligible:true,outcome:'failed',partial:false})
      expect(rows.filter(r=>r.kind==='turn_ended')).toHaveLength(1)
      return {result:result[0],card}
    } finally {h.manager.shutdown();await flush()}
  }
  // @covers: tool-call-metrics › Tool results are classified once › Trusted denial precedes text
  test('native denial reaches the real SDK adapter manager tracker and one eligible failed result',async()=>{
    const actual=await deniedWitness(true)
    expect(actual.result.failureClass).toBe('denied')
    expect(actual.card.toolCallId).toBe('native-c')
  })
  // @covers: tool-call-metrics › Approval evidence retains first-resolution ownership › Audit fallback is not a native link
  test('native-ID-absent with a matching audit fallback remains unlinked and non-denied',async()=>{
    const actual=await deniedWitness(false)
    expect(actual.result.failureClass).toBe('other')
    expect(actual.card.toolCallId).toBeUndefined()
  })

  // @covers: team-process-metrics › Tool metrics › Status change reaches open views without a refresh
  test('actual manager status getter and committed callback push budget refusal to both warm subscriptions',async()=>{
    const a=path.join(tempDir,'team-a'),b=path.join(tempDir,'team-b')
    fs.mkdirSync(a);fs.mkdirSync(b)
    let connections:ChatConnections|undefined,publications=0
    const events:{sessionId:string;event:ChatEvent}[]=[]
    const manager=await managedManager({db,registry:new SessionRegistry(),isDirectory:fs.existsSync,
      onEvent:(sessionId,event)=>events.push({sessionId,event}),
      onToolMeasurementStatusChange:()=>{publications++;connections?.publishMetricsAll()}})
    connections=new ChatConnections(manager)
    try {
      // Startup verification publishes status too. Settle that notification
      // before subscription opens, so it cannot add a third initial snapshot.
      await waitForCondition(()=>publications>0)
      const first=manager.createSession({projectPath:a}),second=manager.createSession({projectPath:b})
      if(!first.ok||!second.ok)throw Error('real manager session setup failed')
      await manager.teams.track(first.session.id,a);await manager.teams.track(second.session.id,b)
      const sent:ServerMessage[]=[]
      const connection={send:(message:ServerMessage)=>sent.push(message)}
      for(const teamPath of [a,b])await connections.handle(connection,{type:'process-metrics-open',teamPath,window:'7d',slice:null})
      const snapshots=()=>sent.filter((m):m is Extract<ServerMessage,{type:'process-metrics-snapshot'}>=>m.type==='process-metrics-snapshot')
      expect(snapshots()).toHaveLength(2)
      expect(manager.observations.toolStatus().export.state).toBe('active')
      for(const initial of snapshots())expect(initial.metrics.metrics.length).toBeGreaterThan(0)
      await new Promise(resolve=>setTimeout(resolve,280))
      const before=snapshots().slice(-2),count=snapshots().length,publishes=publications
      db.db.transaction(()=>{
        for(const family of ['task_stage_duration_seconds','task_acceptance_duration_seconds']){
          const insert=db.db.prepare("INSERT INTO process_export_totals VALUES (?,?,'admitted',0)")
          for(let i=0;i<10000;i++)insert.run(family,JSON.stringify({team:'old-'+i}))
        }
      })()
      expect(manager.observations.toolExport.ensure()).toBe(true)
      expect(manager.observations.toolStatus().export).toMatchObject({state:'budget-unavailable',reason:'series-budget'})
      // The direct getter assertion discriminates an omitted fourth argument.
      expect(manager.metrics.read(before[0]!.teamId,'7d',null).toolMeasurement.export.state).toBe('budget-unavailable')
      await new Promise(resolve=>setTimeout(resolve,280))
      expect(publications).toBe(publishes+1)
      expect(snapshots()).toHaveLength(count+2)
      for(let i=0;i<2;i++){
        const pushed=snapshots().slice(-2)[i]!
        expect(pushed.metrics.toolMeasurement.export.state).toBe('budget-unavailable')
        expect(pushed.metrics.metrics).toBe(before[i]!.metrics.metrics)
        expect(pushed.metrics.computedAt).toBe(before[i]!.metrics.computedAt)
        expect(before[i]!.metrics.toolMeasurement.export.state).toBe('active')
      }
    }finally{manager.shutdown()}
  })

})
