// P-I2: containment must preserve actual hidden metadata and copy feedback.
import { expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import SectionHeader from '../components/SectionHeader'
import { MessageRow } from '../components/chat/ChatRow'
import type { WorktreeSectionData } from '../utils/workspaceView'

test('P-I2: hidden labels and live feedback retain their semantics (seed 0x51c012, 16 cases)', async () => {
  let seed = 0x51c012
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const globals = ['window', 'navigator', 'document'] as const
  const saved = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  try {
    for (let i = 0; i < 16; i++) {
      const value = next()
      const section: WorktreeSectionData = {
        kind: 'worktree', key: 'tree', worktreeId: 'tree', repositoryId: '/repo/.git',
        repositoryName: 'repo', repositoryStale: !!(value & 1), worktreePath: '/repo',
        branch: 'main', detached: !!(value & 2), headRevision: 'abcdef012345', isMain: true,
        dirty: !!(value & 4), collapsed: false, entries: [], attentionCount: 0, hiddenAttentionCount: 0,
      }
      const outcome = i % 3
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true } })
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        clipboard: { writeText: async () => { if (outcome === 2) throw new Error('fixture refusal') } },
      } })
      Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        addEventListener: () => {}, removeEventListener: () => {}, execCommand: () => false,
      } })
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<>
        <SectionHeader section={section} onToggleCollapse={() => {}} />
        <MessageRow author="Claude" showAuthor={!(value & 8)} at={`2026-11-19T12:${String(i).padStart(2, '0')}:00Z`}
          role="assistant" anchorId={`row-${i}`} spacing="" copyText="payload">Message</MessageRow>
      </>) })
      try {
        const stateLabels = renderer.root.findAll(node => node.type === 'span' && node.props.className === 'sr-only')
          .map(node => node.children.join('')).join(' ')
        if (section.dirty) expect(stateLabels).toContain('dirty')
        if (section.repositoryStale) expect(stateLabels).toContain('stale')
        if (section.detached) expect(stateLabels).toContain('detached')
        const author = renderer.root.findByProps({ 'data-testid': 'chat-row-author' })
        expect(author.children).toEqual(['Claude'])
        expect(author.props.className).toBe(value & 8 ? 'sr-only' : 'font-semibold')
        const time = renderer.root.findByType('time')
        expect(time.findByProps({ className: 'sr-only' }).children.join('')).toBe(time.props.title)
        const button = renderer.root.findByProps({ 'data-testid': 'chat-message-copy' })
        expect(button.props['aria-label']).toBe('Copy message')
        if (outcome) await act(async () => { button.props.onClick(); await Promise.resolve(); await Promise.resolve() })
        const status = button.findByProps({ 'data-testid': 'chat-message-copy-status' })
        expect(status.props.role).toBe('status')
        expect(status.children.join('')).toBe(['', 'Copied', 'Copy failed'][outcome]!)
      } finally { act(() => renderer.unmount()) }
    }
  } finally {
    globals.forEach((key, i) => {
      if (saved[i]) Object.defineProperty(globalThis, key, saved[i]!)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
})
