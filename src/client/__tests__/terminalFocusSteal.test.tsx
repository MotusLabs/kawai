// A closed SettingsModal must never touch the terminal while another dialog is
// open. Its close-side "restore terminal focus" timer used to be armed by every
// effect run while closed: once on each page load and again on every settings
// or server-default change. Fired 300 ms later under the open New Session
// dialog, it re-enabled the xterm textarea and focused it, so text the user (or
// Playwright's `fill`) was typing went to the terminal and the dialog's field
// kept its default — the lost Display Name behind the generated-name e2e flake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import NewSessionModal from '../components/NewSessionModal'
import SettingsModal from '../components/SettingsModal'
import { DEFAULT_PRESETS, useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  localStorage?: Storage
}
const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalFetch = globalThis.fetch
const originalLocalStorage = globalAny.localStorage

beforeEach(() => {
  const store = new Map<string, string>()
  globalAny.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
  globalThis.fetch = (async () => Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [], groups: [], enabled: true })) as unknown as typeof fetch
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.localStorage = originalLocalStorage
  globalThis.fetch = originalFetch
})

/** One xterm textarea that records how the modals touch it, in order. */
function terminalDom() {
  const calls: string[] = []
  const textarea = {
    setAttribute: () => void calls.push('disable'),
    removeAttribute: () => void calls.push('enable'),
    focus: () => void calls.push('terminal-focus'),
    blur: () => {},
  }
  globalAny.document = { querySelector: () => textarea } as unknown as Document
  globalAny.window = { addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window & typeof globalThis
  return calls
}

/** The close-side terminal focus waits 300 ms; run past it. */
const pastCloseWindow = () => new Promise((resolve) => setTimeout(resolve, 340))

function tree(props: { projectDir: string; settingsOpen?: boolean; newSessionOpen: boolean }) {
  return (
    <>
      <SettingsModal isOpen={props.settingsOpen ?? false} onClose={() => {}} serverDefaultDir={props.projectDir} />
      <NewSessionModal
        isOpen={props.newSessionOpen}
        onClose={() => {}}
        onCreate={() => {}}
        defaultProjectDir="/base"
        commandPresets={DEFAULT_PRESETS}
        defaultPresetId="claude"
      />
    </>
  )
}

describe('terminal focus under an open dialog', () => {
  test('a closed Settings modal armed at page load does not focus the terminal under New Session', async () => {
    const calls = terminalDom()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(tree({ projectDir: '/a', newSessionOpen: false }))
    })
    act(() => {
      renderer.update(tree({ projectDir: '/a', newSessionOpen: true }))
    })
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).not.toContain('terminal-focus')
    expect(calls).not.toContain('enable')
    act(() => renderer.unmount())
  })

  test('a setting changing while Settings is closed does not re-arm the terminal focus', async () => {
    const calls = terminalDom()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(tree({ projectDir: '/a', newSessionOpen: true }))
    })
    await act(async () => {
      await pastCloseWindow()
    })
    calls.length = 0
    // Late setting change (the default project directory hydrates) while the
    // dialog is open and Settings is closed.
    act(() => {
      useSettingsStore.setState({ defaultProjectDir: '/b' })
    })
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).not.toContain('terminal-focus')
    act(() => renderer.unmount())
  })

  test('closing Settings still hands focus back to the terminal', async () => {
    const calls = terminalDom()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(tree({ projectDir: '/a', settingsOpen: true, newSessionOpen: false }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    calls.length = 0
    act(() => {
      renderer.update(tree({ projectDir: '/a', settingsOpen: false, newSessionOpen: false }))
    })
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).toEqual(['enable', 'terminal-focus'])
    act(() => renderer.unmount())
  })
})

describe('Display Name field', () => {
  test('has an accessible name and its typed text reaches onCreate', async () => {
    terminalDom()
    const created: Array<string | undefined> = []
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(_path, name) => void created.push(name)}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const input = renderer.root.findByProps({ 'aria-label': 'Display Name' })
    act(() => input.props.onChange({ target: { value: 'background-fixture' } }))
    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual(['background-fixture'])
    act(() => renderer.unmount())
  })
})
