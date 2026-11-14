// D7 paging through the real chat dispatcher, MetricsReader and retained store.
import { expect,test } from 'bun:test'
import { ObservationStore } from '../metrics/observations/store'
import { MetricsReader } from '../metrics/computeMetrics'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ClientMessage,ServerMessage } from '../../shared/types'
import type { MetricsClientMessage } from '../../shared/metricsMessages'
import { DAY,END,Seed,TEAM } from './metricsSeed'
type Request=Extract<MetricsClientMessage,{type:'process-tool-drill-page'}>
type Reply=Extract<ServerMessage,{type:'process-tool-drill-page'}>
function fixture() {
  const seed=new Seed(),store=new ObservationStore(seed.db,()=>END)
  let now=END
  const metrics=new MetricsReader(seed.db,()=>now)
  const manager={whenRestored:()=>Promise.resolve(),metrics,
    teamScopes:{resolve:async(path:string)=>path==='/repo'?{teamId:TEAM}:path==='/other'?{teamId:'other'}:null},
  } as unknown as ChatSessionManager
  const wire=new ChatConnections(manager),messages:ServerMessage[]=[]
  const connection={send:(message:ServerMessage)=>messages.push(message)}
  const base:Request={type:'process-tool-drill-page',teamPath:'/repo',window:'3d',slice:null,pageSize:50,cursor:null}
  return {seed,store,wire,base,
    tick(){now+=DAY},
    fact(i:number,resolution='abandoned',team=TEAM,at=END-DAY+Math.floor(i/3)){
      const closedAt=new Date(at).toISOString()
      return store.record({kind:'tool_streak',sourceKey:'drill-'+team+'-'+i,teamId:team,sessionId:'session-'+i,
        turnId:'turn-'+i,toolCallId:i===0?'x'.repeat(129):'opening-'+i,observedAt:closedAt,
        data:{tool:'Bash',toolKind:'builtin',label:'Bash',length:i%7+1,resolution,
          firstAt:new Date(at-500).toISOString(),closedAt}})!
    },
    async page(extra:Partial<Request>={}) {
      const before=messages.length
      await wire.handle(connection,{...base,...extra} as ClientMessage)
      expect(messages.length).toBe(before+1)
      const message=messages.at(-1)!
      expect(message.type).toBe('process-tool-drill-page')
      return message as Reply
    },
    close(){wire.disconnect(connection);seed.db.close()},
  }
}
// @covers: team-process-metrics › Tool metric drill-down opens the first failed call › More abandoned streaks than one page
// @covers: team-process-metrics › Tool metric drill-down opens the first failed call › Later streaks do not shift pages
test('W12: actual chat paging reaches 2501 facts in 51 stable pages with total 2501 and excludes three later commits',async()=>{
  const h=fixture()
  try {
    const expected=h.seed.db.transaction(()=>Array.from({length:2501},(_,i)=>h.fact(i)))()
      .sort((a,b)=>String(b.data.closedAt).localeCompare(String(a.data.closedAt))||b.seq-a.seq)
    h.fact(3000,'recovered');h.fact(3001,'unknown');h.fact(3002,'abandoned','other')
    h.fact(3003,'abandoned',TEAM,END-4*DAY)
    expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain('process-tool-drill-page')
    let page=await h.page(),pages=0
    const ids:number[]=[],anchors:string[]=[]
    for(;;) {
      if('error'in page)throw Error(page.error)
      pages++;expect(page.entries.length).toBeLessThanOrEqual(50)
      expect(page.total).toBe(2501)
      ids.push(...page.entries.map(e=>e.factId));anchors.push(...page.entries.map(e=>e.firstCallId))
      if(pages===1) {
        h.seed.db.transaction(()=>{for(let i=4000;i<4003;i++)h.fact(i,'abandoned',TEAM,END-DAY/2)})()
        h.tick()
      }
      if(page.nextCursor===null)break
      page=await h.page({cursor:page.nextCursor})
    }
    expect(pages).toBe(51)
    expect(ids).toEqual(expected.map(e=>e.seq))
    expect(new Set(ids).size).toBe(2501)
    expect(anchors.at(-1)).toBe('x'.repeat(129))
    const fresh=await h.page()
    expect('error'in fresh).toBe(false)
    if(!('error'in fresh))expect(fresh.total).toBe(2504)
  }finally{h.close()}
})
// @covers: team-process-metrics › Tool metric drill-down opens the first failed call › Cursor bound to its request
test('W12 refusals: malformed or mismatched cursor, unknown team, invalid window and page size produce reason without entries',async()=>{
  const h=fixture()
  try {
    for(let i=0;i<3;i++)h.fact(i)
    const first=await h.page({pageSize:1,slice:{kind:'profile'}})
    if('error'in first)throw Error(first.error)
    expect(first.nextCursor).not.toBeNull()
    const cursor=first.nextCursor!
    const raw=JSON.parse(Buffer.from(cursor,'base64url').toString())
    const cases:[Partial<Request>,string][]=[
      [{cursor,pageSize:1,slice:{kind:'group'}},'slice mismatch'],
      [{cursor,pageSize:2,slice:{kind:'profile'}},'page size mismatch'],
      [{cursor,pageSize:1,slice:{kind:'profile'},window:'7d'},'window mismatch'],
      [{cursor,pageSize:1,slice:{kind:'profile'},teamPath:'/other'},'team mismatch'],
      [{cursor:'!'},'Malformed'],
      [{cursor:Buffer.from(JSON.stringify({...raw,highWater:-1})).toString('base64url')},'Malformed'],
      [{cursor:Buffer.from(JSON.stringify({...raw,last:{closedAt:'invalid',seq:1}})).toString('base64url')},'Malformed'],
      [{pageSize:0},'page size'],[{pageSize:51},'page size'],[{pageSize:1.5},'page size'],
      [{teamPath:'/missing'},'unknown-team'],
      [{window:'30d' as '3d'},'window'],
    ]
    for(const [request,reason]of cases) {
      const reply=await h.page(request)
      expect(reply).toHaveProperty('error',expect.stringContaining(reason))
      expect(reply).not.toHaveProperty('entries')
      expect(reply).not.toHaveProperty('total')
    }
  }finally{h.close()}
})
