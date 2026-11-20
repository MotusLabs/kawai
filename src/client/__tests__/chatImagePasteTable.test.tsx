import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { PASTE_ORACLES, oracleRows } from '../../../tests/fixtures/chatImageOracles'
import { useChatStore } from '../stores/chatStore'
import { useChatImageDrafts } from '../stores/chatImageDrafts'
import ChatComposer from '../components/chat/ChatComposer'

let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(() => { act(() => renderer?.unmount()); useChatImageDrafts.getState().removeSession('paste-table') })

for (const [id, eventClass, capacity, result] of oracleRows(PASTE_ORACLES)) {
  test(`${id}: ${eventClass} / ${capacity} -> ${result}`, () => {
    useChatImageDrafts.getState().removeSession('paste-table')
    useChatStore.getState().setDraft('paste-table', 'kept')
    const png = () => new File(['bytes'], 'image.png', { type: 'image/png' })
    if (id === 'P3') useChatImageDrafts.getState().add('paste-table', Array.from({ length: 4 }, png))
    let prevented = false, sent = 0
    act(() => { renderer = TestRenderer.create(<ChatComposer sessionId="paste-table" status="waiting" connected
      commandState={{ status: 'unavailable', commands: [] }} onSubmit={() => { sent++ }} onInterrupt={() => {}} />) })
    const file = id === 'P4' ? new File(['svg'], 'image.svg', { type: 'image/svg+xml' }) : png()
    const clipboard = id === 'P1' ? { items: [], files: [], getData: () => 'text' }
      : { items: [{ kind: 'file', type: file.type, getAsFile: () => id === 'P5' ? null : file }], files: id === 'P5' ? [] : [file], getData: () => 'clipboard representation' }
    act(() => renderer!.root.findByType('textarea').props.onPaste({ clipboardData: clipboard, preventDefault: () => { prevented = true } }))
    expect(prevented).toBe(id !== 'P1')
    expect(useChatStore.getState().drafts['paste-table']).toBe('kept')
    expect(useChatImageDrafts.getState().drafts['paste-table']?.length ?? 0).toBe(id === 'P2' ? 1 : id === 'P3' ? 4 : 0)
    expect(sent).toBe(0)
    expect(Object.values(useChatImageDrafts.getState().attempts).filter(p => p.sessionId === 'paste-table')).toEqual([])
    if (['P3', 'P4', 'P5'].includes(id)) expect(useChatImageDrafts.getState().errors['paste-table']).toBeString()
  })
}
