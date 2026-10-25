// The New Session dialog reports how its flow ended, beside the close
// (plan-workspace §6.2, review B5): a creation requested through the form
// reports `dismissed(true)` — the create-then-bind arm is settled by the
// session's `session-created` (or error) reply, not by the dialog closing —
// while every abandoning exit (Cancel, Escape, overlay) reports
// `dismissed(false)` so the panel's arm is disarmed and a later, unrelated
// same-team creation binds nothing.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import NewSessionModal from '../components/NewSessionModal'
import { DEFAULT_PRESETS } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalFetch = globalThis.fetch

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalThis.fetch = originalFetch
})

function setupDom() {
  const keyHandlers = new Map<string, EventListener>()
  globalAny.document = { querySelector: () => ({ removeAttribute: () => {}, focus: () => {} }) } as unknown as Document
  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => { keyHandlers.set(event, handler) },
    removeEventListener: (event: string) => { keyHandlers.delete(event) },
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  } as unknown as Window & typeof globalThis
  return { keyHandlers }
}

/** The chat create path needs a settled catalog offering the default profile. */
const stubCatalogFetch = () => {
  globalThis.fetch = (async (url: string) =>
    String(url).startsWith('/api/chat/groups')
      ? Response.json({ groups: [], errors: [] })
      : Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })) as unknown as typeof fetch
}

const settleCatalog = async () => {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })
}

describe('NewSessionModal dismiss reporting (plan-workspace B5)', () => {
  test('a chat creation reports created(true) beside the close, after onCreate', async () => {
    setupDom()
    stubCatalogFetch()
    const events: Array<string | boolean> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => events.push('close')}
          onDismiss={created => events.push(created)}
          onCreate={() => events.push('create')}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />)
    })
    await settleCatalog()
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Project Path' }).props.onChange({ target: { value: '/repo' } })
    })
    // The fill changes the project path, so the catalog refetches for it —
    // settle again or the chat submit's profile gate silently returns.
    await settleCatalog()
    act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    expect(events).toEqual(['create', 'close', true])
    act(() => { renderer.unmount() })
  })

  test('a terminal creation reports created(true) beside the close', async () => {
    setupDom()
    const events: Array<string | boolean> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => events.push('close')}
          onDismiss={created => events.push(created)}
          onCreate={() => events.push('create')}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />)
    })
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Session kind' }).props.onChange({ target: { value: 'terminal' } })
      renderer.root.findByProps({ 'aria-label': 'Project Path' }).props.onChange({ target: { value: '/repo' } })
    })
    act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    expect(events).toEqual(['create', 'close', true])
    act(() => { renderer.unmount() })
  })

  test('Cancel, Escape, and the overlay each report created(false)', () => {
    const { keyHandlers } = setupDom()
    const events: Array<string | boolean> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => events.push('close')}
          onDismiss={created => events.push(created)}
          onCreate={() => events.push('create')}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />)
    })
    const buttons = renderer.root.findAllByType('button')
    act(() => { buttons.find(b => b.props.children === 'Cancel')!.props.onClick() })
    act(() => { keyHandlers.get('keydown')?.({ key: 'Escape' } as KeyboardEvent) })
    const overlay = renderer.root.findByProps({ role: 'dialog' })
    act(() => { overlay.props.onClick({ target: overlay, currentTarget: overlay }) })
    // Three abandoning exits, none of them a creation.
    expect(events).toEqual(['close', false, 'close', false, 'close', false])
    act(() => { renderer.unmount() })
  })
})
