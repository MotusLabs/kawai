// D7 client composition: actual router -> store -> pager -> exact reveal anchor.
import { afterEach,expect,test } from 'bun:test'
import TestRenderer,{act} from 'react-test-renderer'
import ToolDrill,{ToolMeasurement} from '../components/team/metrics/ToolDrill'
import { createMessageRouter } from '../protocol/messageRouter'
import type { MessageRouterDeps } from '../protocol/types'
import { useMetricsStore } from '../stores/metricsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import type { ClientMessage,Session } from '@shared/types'
import type { ToolStreakEntry } from '@shared/processMetrics'
const initialSessions=useSessionStore.getState(),initialChat=useChatStore.getState()
const mounted:TestRenderer.ReactTestRenderer[]=[]
afterEach(()=>{act(()=>{for(const r of mounted.splice(0))r.unmount()})
  useMetricsStore.setState({views:{}});useSessionStore.setState(initialSessions,true);useChatStore.setState(initialChat,true)})
function setup() {
  const sent:ClientMessage[]=[]
  const send=(m:ClientMessage)=>{sent.push(m)}
  const deps:MessageRouterDeps={getConnectionEpoch:()=>1,sendClient:send,setTransientError:()=>{throw Error('unexpected generic error')},
    clearTransientError:()=>{},openSessionFormPrefilled:()=>{},setPendingHibernatingSession:()=>{},
    pendingKills:{current:new Map()},pendingHibernateSelection:{current:null},pendingWakeSelection:{current:null},
    pendingWorktreeLaunch:{current:null},pendingChangeLaunch:{current:null}}
  const route=createMessageRouter(deps)
  useMetricsStore.getState().request('/repo',{window:'3d',slice:null})
  const entry=(i:number):ToolStreakEntry=>({factId:2501-i,tool:'Bash',length:2,sessionId:'s1',turnId:'t'+i,
    firstCallId:i===0?'first-'+'x'.repeat(129):'first-'+i,firstAt:'2026-10-15T00:00:00.000Z',closedAt:'2026-10-15T00:00:01.000Z'})
  const inline={entries:[entry(0)],total:2501,longestRecovered:[]}
  function Harness(){const view=useMetricsStore(s=>s.views['/repo'])!
    return <ToolDrill teamPath="/repo" view={view} inline={inline} connected sendMessage={send}/>}
  let render!:TestRenderer.ReactTestRenderer
  act(()=>{render=TestRenderer.create(<Harness/>)})
  mounted.push(render)
  const click=(label:string)=>act(()=>render.root.findAllByType('button').find(b=>b.children.join('')===label)!.props.onClick())
  const reply=(start:number,cursor:string|null,nextCursor:string|null)=>act(()=>route({
    type:'process-tool-drill-page',teamPath:'/repo',teamId:'team',window:'3d',slice:null,pageSize:50,cursor,
    entries:Array.from({length:Math.min(50,2501-start)},(_,i)=>entry(start+i)),total:2501,nextCursor,
  }))
  return {render,entry,click,sent,route,reply}
}
const text=(n:TestRenderer.ReactTestInstance|string):string=>typeof n==='string'?n:n.children.map(text).join('')
// @covers: team-process-metrics › Tool metric drill-down opens the first failed call › More abandoned streaks than one page
test('D7 client follows all 51 nextCursor pages through createMessageRouter, keeps total and reaches every entry',()=>{
  const h=setup();h.click('Show all abandoned streaks')
  for(let page=0;page<51;page++){
    const cursor=page===0?null:'cursor-'+page,next=page===50?null:'cursor-'+(page+1)
    expect(h.sent.at(-1)).toEqual({type:'process-tool-drill-page',teamPath:'/repo',window:'3d',slice:null,pageSize:50,cursor})
    h.reply(page*50,cursor,next)
    expect(text(h.render.root.findByProps({'data-testid':'tool-drill-total'}))).toBe('Abandoned streaks: 2501')
    if(next)h.click('Load next page')
  }
  expect(h.sent).toHaveLength(51)
  const page=useMetricsStore.getState().views['/repo']!.toolDrill!
  expect(page.entries.map(e=>e.factId)).toEqual(Array.from({length:2501},(_,i)=>2501-i))
  expect(h.render.root.findAllByType('button').some(b=>b.children.join('')==='Load next page')).toBe(false)
})
// @covers: team-process-metrics › Tool metric drill-down opens the first failed call › Open an abandoned streak
test('Open an abandoned streak selects its chat and reveals untruncated FIRST failed call, with explicit missing session refusal',()=>{
  const h=setup()
  const session:Session={id:'s1',name:'reader',tmuxWindow:'',projectPath:'/repo',status:'waiting',
    lastActivity:'',createdAt:'',source:'managed'}
  useSessionStore.setState({sessions:[session]})
  act(()=>useChatStore.getState().snapshot({
    type:'chat-snapshot',sessionId:'s1',profileId:'default',status:'waiting',throughSequence:3,
    events:[
      {type:'tool_call',id:'first-call',sequence:0,at:'',turnId:'t',toolCallId:h.entry(0).firstCallId,tool:'Bash',input:{}},
      {type:'tool_result',id:'first-result',sequence:1,at:'',turnId:'t',toolCallId:h.entry(0).firstCallId,isError:true,output:'first failure'},
      {type:'tool_call',id:'last-call',sequence:2,at:'',turnId:'t',toolCallId:'last-failed-call',tool:'Bash',input:{}},
      {type:'tool_result',id:'last-result',sequence:3,at:'',turnId:'t',toolCallId:'last-failed-call',isError:true,output:'later failure'},
    ],pendingRequests:[],commands:{status:'unavailable',commands:[]},activity:null,contextUsage:null,usage:null,
    workers:[],backgroundTasks:[],notifications:[],model:null,
  }))
  expect(useChatStore.getState().sessions.s1?.events.filter(e=>e.type==='tool_result')).toHaveLength(2)
  act(()=>h.render.root.findByProps({'aria-label':'Open abandoned streak 2501'}).props.onClick())
  expect(useSessionStore.getState().selectedSessionId).toBe('s1')
  expect(useChatStore.getState().pendingReveal).toEqual({sessionId:'s1',anchorId:'tool:'+h.entry(0).firstCallId})
  expect(useChatStore.getState().pendingReveal?.anchorId).not.toBe('tool:last-failed-call')
  useSessionStore.setState({sessions:[]})
  act(()=>h.render.root.findByProps({'aria-label':'Open abandoned streak 2501'}).props.onClick())
  expect(text(h.render.root.findByProps({role:'alert'}))).toBe('not-found')
})
test('D7 client ignores stale window/cursor pages, surfaces a refusal without entries, and resets paging on refresh/close',()=>{
  const h=setup();h.click('Show all abandoned streaks')
  const base={type:'process-tool-drill-page' as const,teamPath:'/repo',window:'3d' as const,slice:null,pageSize:50,cursor:null}
  act(()=>h.route({...base,window:'7d',error:'stale'}))
  expect(useMetricsStore.getState().views['/repo']!.toolDrill?.loading).toBe(true)
  act(()=>h.route({...base,cursor:'wrong',error:'stale'}))
  expect(useMetricsStore.getState().views['/repo']!.toolDrill?.error).toBeNull()
  act(()=>h.route({...base,error:'Malformed tool drill cursor'}))
  expect(text(h.render.root.findByProps({role:'alert'}))).toContain('Malformed')
  expect(useMetricsStore.getState().views['/repo']!.toolDrill?.entries).toEqual([])
  act(()=>useMetricsStore.getState().request('/repo',{window:'3d',slice:null}))
  expect(useMetricsStore.getState().views['/repo']!.toolDrill).toBeUndefined()
  h.click('Show all abandoned streaks')
  act(()=>useMetricsStore.getState().close('/repo'))
  h.reply(0,null,null)
  expect(useMetricsStore.getState().views['/repo']!.toolDrill).toBeUndefined()
})
test('Tool status keeps recovery counts separate from export activation and explicitly preserves unknown',()=>{
  let r!:TestRenderer.ReactTestRenderer
  act(()=>{r=TestRenderer.create(<ToolMeasurement status={{export:{state:'budget-unavailable',reason:'series-budget',availableSince:null},
    recovery:{status:'quarantined',pendingCount:2,quarantinedCount:3,checkedAt:null}}}/>)})
  mounted.push(r)
  expect(text(r.root)).toContain('recovery: quarantined; pending 2; quarantined 3')
  expect(text(r.root)).toContain('export: budget-unavailable')
  expect(text(r.root)).toContain('does not establish collection completeness')
  act(()=>r.update(<ToolMeasurement status={{export:{state:'active',reason:null,availableSince:'2026-10-15'},
    recovery:{status:'unknown',pendingCount:null,quarantinedCount:null,checkedAt:null}}}/>))
  expect(text(r.root)).toContain('pending unknown')
  expect(text(r.root)).toContain('active since 2026-10-15')
})
