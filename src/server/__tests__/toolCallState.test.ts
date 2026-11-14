import { expect, test } from 'bun:test'
import { TEAM_TOOL_PREFIX, type TeamCatalogue } from '../metrics/observations/toolCalls'
import { admitCall, approval, finishTools, newToolState, publicToolLabel, resolveApproval, settleCall, taint, watchFailures } from '../metrics/observations/toolCallState'
const catalogue: TeamCatalogue = {prefix:TEAM_TOOL_PREFIX,members:new Set([TEAM_TOOL_PREFIX+'task_get'])}
const at='2026-11-14T00:00:00Z'
test('ST1-ST9: failures, other tools, turn end and restart preserve conservative streak ownership', () => {
  for (const row of [
    {events:'F',open:1,closed:[]},{events:'FF',open:2,closed:[]},
    {events:'FFS',open:0,closed:[['recovered',2]]},{events:'S',open:0,closed:[]},
    {events:'FOS',open:0,closed:[['recovered',1]]},
    {events:'FFE',open:0,closed:[['abandoned',2]]},{events:'E',open:0,closed:[]},
    {events:'FFR',open:0,closed:[['unknown',2]]},{events:'R',open:0,closed:[]},
  ]) {
    const s=newToolState(0), slots=new Map<string,number>()
    let n=0
    const closed: unknown[]=[]
    for (const event of row.events) {
      if (event==='E'||event==='R') closed.push(...finishTools(s,at,event==='R').closed.map(f=>[f.resolution,f.length]))
      else {
        const id='c'+n++
        admitCall(s,slots,id,event==='O'?'Read':'Bash',catalogue,at)
        closed.push(...settleCall(s,id,event==='F','neutral',at).closed.map(f=>[f.resolution,f.length]))
      }
    }
    expect(s.streaks.reduce((n,f)=>n+f.length,0)).toBe(row.open)
    expect(closed).toEqual(row.closed)
  }
})
// @covers: tool-call-metrics › First attempts are measured only for closed, untainted turns › First actual call wins regardless of result order
test('First actual call and first failed result have independent owners', () => {
  const s=newToolState(0), slots=new Map<string,number>()
  for(const id of ['c1','c2']) admitCall(s,slots,id,TEAM_TOOL_PREFIX+'task_get',catalogue,at)
  expect(settleCall(s,'c2',true,'neutral',at).first).toBe(false)
  const result=settleCall(s,'c1',false,'Refused: spoofed',at)
  expect(result.first).toBe(true)
  expect(result.failureClass).toBeUndefined()
  expect(result.closed[0]).toMatchObject({firstCallId:'c2',length:1,resolution:'recovered'})
})
// @covers: tool-call-metrics › Approval evidence retains first-resolution ownership › Policy grants leave capacity for a manual denial
test('C1: 70 policy grants leave all 64 approval slots free', () => {
  const s=newToolState(0), slots=new Map<string,number>()
  for(let i=0;i<70;i++) resolveApproval(s,'grant'+i,'allowed')
  expect(s.links).toEqual([])
  expect(s.denialIncomplete).toBe(false)
  admitCall(s,slots,'c','Write',catalogue,at)
  approval(s,'q','c');resolveApproval(s,'q','denied')
  expect(settleCall(s,'c',true,'neutral',at).failureClass).toBe('denied')
  expect(s.links).toHaveLength(1)
})
test('W3/W4: pre-call denial transfers once and 64 tombstones are never evicted', () => {
  const s=newToolState(0), slots=new Map<string,number>()
  approval(s,'q','c');resolveApproval(s,'q','denied')
  for(let i=1;i<64;i++) approval(s,'q'+i,'c'+i)
  approval(s,'q65','c65')
  expect(s.links).toHaveLength(64)
  expect(s.denialIncomplete).toBe(true)
  admitCall(s,slots,'c','Write',catalogue,at)
  resolveApproval(s,'q','allowed')
  expect(settleCall(s,'c',true,'neutral',at).failureClass).toBe('denied')
  expect(settleCall(s,'c',false,'',at).duplicate).toBe(true)
  expect(s.links[0]).toMatchObject({id:'q',callId:'c',state:'transferred'})
})
// @covers: tool-call-metrics › Approval evidence retains first-resolution ownership › Untransferred denial has no denominator
test('N2: an untransferred denial closes without a call or streak', () => {
  const s=newToolState(0)
  approval(s,'q','absent');resolveApproval(s,'q','denied')
  const result=finishTools(s,at,false)
  expect(result.coverage.toolDenialIncomplete).toBe(true)
  expect(result.closed).toEqual([])
  expect(s.calls).toEqual([])
})
test('W1/W2/W5: gaps and saturation close unknown once without evicting pending calls', () => {
  const s=newToolState(0), slots=new Map<string,number>()
  admitCall(s,slots,'first','Bash',catalogue,at);settleCall(s,'first',true,'',at)
  expect(watchFailures(s,1,at)).toMatchObject([{resolution:'unknown',length:1}])
  expect(watchFailures(s,1,at)).toEqual([])
  for(let i=1;i<512;i++) admitCall(s,slots,'c'+i,'Read',catalogue,at)
  admitCall(s,slots,'overflow','Read',catalogue,at)
  expect(s.mode).toBe('saturated');expect(s.calls).toHaveLength(512)
  expect(settleCall(s,'c1',false,'',at).eligible).toBe(true)
  expect(settleCall(s,'c1',false,'',at).duplicate).toBe(true)
  expect(taint(s,at)).toEqual([])
})
test('D4/public labels: foreign slots and labels are distinct and no raw name survives serialization', () => {
  const s=newToolState(0), slots=new Map<string,number>()
  for(let i=0;i<500;i++) {
    admitCall(s,slots,'c'+i,'mcp__PRIVATE_CANARY__tool'+i,catalogue,at)
    settleCall(s,'c'+i,false,'OUTPUT_CANARY',at)
  }
  expect(slots.size).toBe(96);expect(s.slots).toBe(96)
  expect(s.calls.filter(c=>c.identity==='unknown')).toHaveLength(404)
  expect(JSON.stringify(s)).not.toContain('PRIVATE_CANARY')
  expect(JSON.stringify(s)).not.toContain('OUTPUT_CANARY')
  expect(publicToolLabel({kind:'builtin',name:'TaskCreate'},catalogue)).toBe('other')
  const many: TeamCatalogue={prefix:TEAM_TOOL_PREFIX,members:new Set(Array.from({length:100},(_,i)=>TEAM_TOOL_PREFIX+'t'+i))}
  expect(publicToolLabel({kind:'team',name:'t75'},many)).toBe('t75')
  expect(publicToolLabel({kind:'team',name:'t76'},many)).toBe('other')
})
