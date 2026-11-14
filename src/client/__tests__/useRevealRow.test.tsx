import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { useRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import { REVEAL_MS, useRevealRow, type RevealContainer, type RevealTarget } from '../components/chat/useRevealRow'
import { emptyTranscript, useChatStore } from '../stores/chatStore'

interface FakeRow extends RevealTarget {
  classes: Set<string>
  scrolls: ScrollIntoViewOptions[]
}
function row(tagName = 'ARTICLE'): FakeRow {
  const classes = new Set<string>()
  const scrolls: ScrollIntoViewOptions[] = []
  return {
    tagName, open: false, classes, scrolls,
    scrollIntoView: options => { scrolls.push(options ?? {}) },
    classList: { add: token => { classes.add(token) }, remove: token => { classes.delete(token) } },
  }
}

function Harness({ sessionId, loaded, sendMessage, eventCount,archived }: {
  sessionId: string; loaded: boolean; sendMessage?: (message: ClientMessage) => void; eventCount?: number;archived?:boolean
}) {
  const ref = useRef<RevealContainer | null>(null)
  const outcome=useRevealRow({ sessionId, loaded, container: ref, sendMessage, eventCount,archived })
  return <div ref={ref as never} data-outcome={outcome?.status??null} />
}

const mounted: TestRenderer.ReactTestRenderer[] = []
function mount(rows: Record<string, FakeRow>, props: { sessionId?: string; loaded?: boolean; sendMessage?: (message: ClientMessage) => void; eventCount?: number;archived?:boolean } = {}) {
  const selectors: string[] = []
  const container: RevealContainer = {
    querySelector: selector => {
      selectors.push(selector)
      const id = /^\[data-anchor-id="(.*)"\]$/.exec(selector)?.[1]?.replace(/\\(["\\])/g, '$1')
      return (id !== undefined && rows[id]) || null
    },
  }
  let renderer!: TestRenderer.ReactTestRenderer
  const element = (loaded: boolean, eventCount?: number) =>
    <Harness sessionId={props.sessionId ?? 's1'} loaded={loaded} archived={props.archived} sendMessage={props.sendMessage} eventCount={eventCount} />
  act(() => { renderer = TestRenderer.create(element(props.loaded ?? true, props.eventCount), { createNodeMock: () => container }) })
  mounted.push(renderer)
  return {
    renderer,
    selectors,
    setLoaded: (loaded: boolean) => act(() => renderer.update(element(loaded, props.eventCount))),
    setEventCount: (eventCount: number) => act(() => renderer.update(element(props.loaded ?? true, eventCount))),
  }
}
const request = (sessionId: string, anchorId: string) =>
  act(() => { useChatStore.getState().requestReveal(sessionId, anchorId) })

describe('useRevealRow', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useChatStore.getState().clearReveal()
    useChatStore.setState({sessions:{}})
  })
  afterEach(() => {
    act(() => { for (const renderer of mounted.splice(0)) renderer.unmount() })
    jest.useRealTimers()
    useChatStore.getState().clearReveal()
  })

  test('scrolls the row to the middle, highlights it, and drops the highlight after two seconds', () => {
    const target = row()
    mount({ 'tool:call_1': target })
    request('s1', 'tool:call_1')
    expect(target.scrolls).toEqual([{ block: 'center' }])
    expect(target.classes.has('chat-reveal')).toBe(true)
    expect(useChatStore.getState().pendingReveal).toBeNull()
    jest.advanceTimersByTime(REVEAL_MS - 1)
    expect(target.classes.has('chat-reveal')).toBe(true)
    jest.advanceTimersByTime(1)
    expect(target.classes.has('chat-reveal')).toBe(false)
  })

  test('opens a collapsed tool card so the match is visible', () => {
    const card = row('DETAILS')
    mount({ 'tool:c': card })
    request('s1', 'tool:c')
    expect(card.open).toBe(true)
  })

  test('leaves other rows closed', () => {
    const article = row('ARTICLE')
    mount({ u1: article })
    request('s1', 'u1')
    expect(article.open).toBe(false)
  })

  test('a row that is gone reports not-found explicitly', () => {
    const { selectors,renderer } = mount({})
    request('s1', 'hist-missing')
    expect(renderer.root.findByType('div').props['data-outcome']).toBe('not-found')
    expect(selectors).toEqual(['[data-anchor-id="hist-missing"]'])
    expect(useChatStore.getState().pendingReveal).toBeNull()
  })

  test('waits for the transcript to load before looking for the row', () => {
    const target = row()
    const { selectors, setLoaded } = mount({ u1: target }, { loaded: false })
    request('s1', 'u1')
    expect(selectors).toEqual([])
    expect(useChatStore.getState().pendingReveal).not.toBeNull()
    setLoaded(true)
    expect(target.classes.has('chat-reveal')).toBe(true)
    expect(useChatStore.getState().pendingReveal).toBeNull()
  })

  test("another chat's reveal is left pending", () => {
    const target = row()
    mount({ u1: target })
    request('other', 'u1')
    expect(target.scrolls).toEqual([])
    expect(useChatStore.getState().pendingReveal).toEqual({ sessionId: 'other', anchorId: 'u1' })
  })

  test('a new reveal moves the highlight', () => {
    const first = row()
    const second = row()
    mount({ a: first, b: second })
    request('s1', 'a')
    request('s1', 'b')
    expect(first.classes.has('chat-reveal')).toBe(false)
    expect(second.classes.has('chat-reveal')).toBe(true)
    jest.advanceTimersByTime(REVEAL_MS)
    expect(second.classes.has('chat-reveal')).toBe(false)
  })

  test('unmounting removes the highlight and its timer', () => {
    const target = row()
    const { renderer } = mount({ a: target })
    request('s1', 'a')
    act(() => renderer.unmount())
    mounted.splice(mounted.indexOf(renderer), 1)
    expect(target.classes.has('chat-reveal')).toBe(false)
    jest.advanceTimersByTime(REVEAL_MS * 2)
    expect(target.classes.has('chat-reveal')).toBe(false)
  })

  test('unmounting with nothing highlighted is harmless', () => {
    const { renderer } = mount({})
    act(() => renderer.unmount())
    mounted.splice(mounted.indexOf(renderer), 1)
  })

  test('quotes and backslashes in an anchor id cannot break the selector', () => {
    const target = row()
    const { selectors } = mount({ 'a"b\\c': target })
    request('s1', 'a"b\\c')
    expect(selectors).toEqual(['[data-anchor-id="a\\"b\\\\c"]'])
    expect(target.classes.has('chat-reveal')).toBe(true)
  })

  test('an old tool anchor pages once with throughId, then reveals (chat-history-window 5.1)', () => {
    const sent: ClientMessage[] = []
    const rows: Record<string, FakeRow> = {}
    useChatStore.setState({
      sessions: {
        s1: { ...emptyTranscript(), historyHasOlder: true, historyStartId: 'hist-a' },
      },
    })
    const { setEventCount } = mount(rows, { sendMessage: message => { sent.push(message) }, eventCount: 2 })
    const target = row('DETAILS')
    request('s1', 'tool:call-old')
    // The anchor is not rendered: exactly one page request, reveal pending.
    expect(sent).toEqual([
      { type: 'chat-history-page', sessionId: 's1', beforeId: 'hist-a', throughId: 'tool:call-old' },
    ])
    expect(useChatStore.getState().pendingReveal).toEqual({ sessionId: 's1', anchorId: 'tool:call-old' })
    // The page lands carrying the tool call; the reveal resolves there.
    rows['tool:call-old'] = target
    act(() => {
      useChatStore.getState().applyHistoryPage({
        type: 'chat-history-page', sessionId: 's1', beforeId: 'hist-a',
        events: [{ type: 'tool_call', id: 'hist-t', sequence: 0, at: '', turnId: 't', toolCallId: 'call-old', tool: 'Bash', input: {} }],
        hasOlder: true,
      })
    })
    setEventCount(3)
    expect(target.open).toBe(true)
    expect(target.classes.has('chat-reveal')).toBe(true)
    expect(useChatStore.getState().pendingReveal).toBeNull()
    expect(sent).toHaveLength(1)
  })

  test('an anchor no page ever holds is dropped after exactly one request', () => {
    const sent: ClientMessage[] = []
    useChatStore.setState({
      sessions: {
        s1: { ...emptyTranscript(), historyHasOlder: true, historyStartId: 'hist-a' },
      },
    })
    const { setEventCount } = mount({}, { sendMessage: message => { sent.push(message) }, eventCount: 2 })
    request('s1', 'hist-gone')
    expect(sent).toHaveLength(1)
    expect(useChatStore.getState().pendingReveal).toEqual({ sessionId: 's1', anchorId: 'hist-gone' })
    // The page lands without the anchor and still offers older history, so
    // only the one-request guard stops a second page: removing it would page
    // the whole history back one landing at a time (the loop D5 forbids).
    act(() => {
      useChatStore.getState().applyHistoryPage({
        type: 'chat-history-page', sessionId: 's1', beforeId: 'hist-a',
        events: [{ type: 'user_message', id: 'hist-x', sequence: 0, at: '', turnId: 't', text: 'unrelated' }],
        hasOlder: true,
      })
    })
    setEventCount(3)
    expect(useChatStore.getState().pendingReveal).toBeNull()
    expect(sent).toHaveLength(1)
  })

  test('a reveal waits for a page another click already started, without a second request', () => {
    const sent: ClientMessage[] = []
    useChatStore.setState({
      sessions: {
        s1: { ...emptyTranscript(), historyHasOlder: true, historyStartId: 'hist-a', historyLoading: true },
      },
    })
    mount({}, { sendMessage: message => { sent.push(message) }, eventCount: 2 })
    request('s1', 'hist-gone')
    // Loading is in flight: no second request, the reveal stays pending.
    expect(sent).toEqual([])
    expect(useChatStore.getState().pendingReveal).toEqual({ sessionId: 's1', anchorId: 'hist-gone' })
  })

// @covers: team-process-metrics › Tool metric drill-down opens the first failed call › Open an abandoned streak
test('D7: an archived readable first-call anchor still reveals after tool detail pruning; missing archived and unreadable are explicit',()=>{
  useChatStore.setState({sessions:{s1:emptyTranscript()}})
  const target=row('DETAILS'),anchor='tool:'+'x'.repeat(129)
  const readable=mount({[anchor]:target},{archived:true})
  request('s1',anchor)
  expect(readable.renderer.root.findByType('div').props['data-outcome']).toBe('revealed')
  expect(target.open).toBe(true)
  expect(target.scrolls).toEqual([{block:'center'}])
  const missing=mount({},{archived:true,sessionId:'archived'})
  request('archived','tool:missing')
  expect(missing.renderer.root.findByType('div').props['data-outcome']).toBe('archived')
  useChatStore.setState({sessions:{unreadable:{...emptyTranscript(),events:[
    {type:'notice',id:'hist-unavailable',sequence:0,at:'',text:'opaque unavailable notice'},
  ]}}})
  const unreadable=mount({},{sessionId:'unreadable'})
  request('unreadable','tool:missing')
  expect(unreadable.renderer.root.findByType('div').props['data-outcome']).toBe('unreadable')
})
test('D7: an empty older page wakes a missing reveal without changing eventCount and never loops',()=>{
  const sent:ClientMessage[]=[]
  useChatStore.setState({sessions:{s1:{...emptyTranscript(),historyHasOlder:true,historyStartId:'hist-a'}}})
  const {renderer}=mount({},{eventCount:0,sendMessage:m=>{sent.push(m)}})
  request('s1','tool:missing')
  expect(sent).toHaveLength(1)
  expect(useChatStore.getState().pendingReveal).not.toBeNull()
  act(()=>useChatStore.getState().applyHistoryPage({type:'chat-history-page',sessionId:'s1',
    beforeId:'hist-a',events:[],hasOlder:false}))
  expect(renderer.root.findByType('div').props['data-outcome']).toBe('not-found')
  expect(useChatStore.getState().pendingReveal).toBeNull()
  expect(sent).toHaveLength(1)
})

test('D7 reconnect with unchanged history leaves the same-count reveal pending until a terminal page arrives',()=>{
  const sent:ClientMessage[]=[]
  const snapshot=()=>useChatStore.getState().snapshot({
    type:'chat-snapshot',sessionId:'s1',profileId:'default',status:'waiting',throughSequence:0,
    events:[],pendingRequests:[],commands:{status:'unavailable',commands:[]},activity:null,
    contextUsage:null,usage:null,workers:[],backgroundTasks:[],notifications:[],model:null,
    historyHasOlder:true,historyStartId:'hist-a',
  })
  act(snapshot)
  const {renderer}=mount({},{eventCount:0,sendMessage:m=>{sent.push(m)}})
  request('s1','tool:missing')
  const previous=useChatStore.getState().sessions.s1
  expect(sent).toHaveLength(1)
  expect(previous?.historyLoading).toBe(true)
  act(snapshot)
  expect(useChatStore.getState().sessions.s1).not.toBe(previous)
  expect(useChatStore.getState().sessions.s1?.historyLoading).toBe(false)
  expect(useChatStore.getState().pendingReveal).toEqual({sessionId:'s1',anchorId:'tool:missing'})
  expect(renderer.root.findByType('div').props['data-outcome']).toBeNull()
  expect(sent).toHaveLength(1)
  act(()=>useChatStore.getState().applyHistoryPage({type:'chat-history-page',sessionId:'s1',
    beforeId:'hist-a',events:[],hasOlder:false}))
  expect(renderer.root.findByType('div').props['data-outcome']).toBe('not-found')
  expect(useChatStore.getState().pendingReveal).toBeNull()
  expect(sent).toHaveLength(1)
})
})
