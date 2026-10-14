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
import SessionDrawer from '../components/SessionDrawer'
import SettingsModal from '../components/SettingsModal'
import type { Session } from '@shared/types'
import { DEFAULT_PRESETS, useSettingsStore } from '../stores/settingsStore'
import { cancelTerminalFocusRestore } from '../utils/terminalFocus'

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
  cancelTerminalFocusRestore()
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.localStorage = originalLocalStorage
  globalThis.fetch = originalFetch
})

/**
 * One xterm textarea that records how the modals touch it, in order.
 * `dialogOpen` answers the `[role="dialog"]` probe: react-test-renderer has no
 * DOM, so the test says which dialogs are mounted at that moment.
 */
function terminalDom(dialogOpen: () => boolean = () => false) {
  const calls: string[] = []
  const textarea = {
    setAttribute: () => void calls.push('disable'),
    removeAttribute: () => void calls.push('enable'),
    focus: () => void calls.push('terminal-focus'),
    blur: () => {},
  }
  globalAny.document = {
    querySelector: (selector: string) => (selector.includes('dialog') ? (dialogOpen() ? {} : null) : textarea),
  } as unknown as Document
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

  test('closing only Settings under an open New Session leaves the terminal alone', async () => {
    let newSessionOpen = true
    const calls = terminalDom(() => newSessionOpen)
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(tree({ projectDir: '/a', settingsOpen: true, newSessionOpen: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    calls.length = 0
    act(() => renderer.update(tree({ projectDir: '/a', settingsOpen: false, newSessionOpen: true })))
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).toEqual([])
    newSessionOpen = false
    act(() => renderer.unmount())
  })

  test('closing only New Session under an open Settings leaves the terminal alone', async () => {
    const calls = terminalDom(() => true)
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(tree({ projectDir: '/a', settingsOpen: true, newSessionOpen: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    calls.length = 0
    act(() => renderer.update(tree({ projectDir: '/a', settingsOpen: true, newSessionOpen: false })))
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).toEqual([])
    act(() => renderer.unmount())
  })

  test('reopening Settings within 300 ms cancels the pending terminal focus', async () => {
    const calls = terminalDom()
    const settings = (settingsOpen: boolean) => tree({ projectDir: '/a', settingsOpen, newSessionOpen: false })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(settings(true))
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => renderer.update(settings(false)))
    // Reopen before the close-side 300 ms timer fires.
    act(() => renderer.update(settings(true)))
    calls.length = 0
    await act(async () => {
      await pastCloseWindow()
    })
    // The stale timer was cancelled: it neither re-enabled nor focused the
    // terminal under the reopened dialog.
    expect(calls).toEqual([])
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

describe('Settings overlay', () => {
  test('is an accessible modal dialog named Settings, so other dialogs can see it is open', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })
    const overlay = renderer.root.findByProps({ role: 'dialog' })
    expect(overlay.props['aria-modal']).toBe('true')
    const title = renderer.root.findByProps({ id: overlay.props['aria-labelledby'] })
    expect(title.children).toContain('Settings')
    act(() => renderer.unmount())
  })
})

describe('with the always-mounted session drawer (mobile layout)', () => {
  const session = {
    id: 'session-1', name: 'alpha', tmuxWindow: 'agentboard:1', projectPath: '/tmp/alpha', status: 'working',
    lastActivity: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z', source: 'managed',
  } as unknown as Session
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalNavigator = globalAny.navigator
  afterEach(() => {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    globalAny.navigator = originalNavigator
  })

  function mobileTree(settingsOpen: boolean, drawerOpen: boolean) {
    return (
      <>
        <SettingsModal isOpen={settingsOpen} onClose={() => {}} />
        <SessionDrawer
          isOpen={drawerOpen}
          onClose={() => {}}
          sessions={[session]}
          selectedSessionId={null}
          onSelect={() => {}}
          onRename={() => {}}
          onNewSession={() => {}}
          loading={false}
          error={null}
        />
      </>
    )
  }

  /** The terminal DOM stub whose dialog probe reads the dialogs actually rendered. */
  function setup() {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    const calls = terminalDom(() => (renderer?.root.findAllByProps({ role: 'dialog' }).length ?? 0) > 0)
    ;(globalAny.window as unknown as Record<string, unknown>).matchMedia = () => ({
      matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    })
    Object.assign(globalAny.document as object, { activeElement: null, addEventListener: () => {}, removeEventListener: () => {} })
    globalAny.navigator = { platform: 'Win32', userAgent: 'Chrome', maxTouchPoints: 0 } as unknown as Navigator
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval
    return { calls, set: (r: TestRenderer.ReactTestRenderer) => { renderer = r } }
  }

  test('a closed drawer does not block restoring terminal focus after Settings closes', async () => {
    const { calls, set } = setup()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(mobileTree(true, false))
      set(renderer)
    })
    await act(async () => {
      await Promise.resolve()
    })
    calls.length = 0
    act(() => renderer.update(mobileTree(false, false)))
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).toEqual(['enable', 'terminal-focus'])
    act(() => renderer.unmount())
  })

  test('an open drawer suppresses the restore', async () => {
    const { calls, set } = setup()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(mobileTree(true, true))
      set(renderer)
    })
    await act(async () => {
      await Promise.resolve()
    })
    calls.length = 0
    act(() => renderer.update(mobileTree(false, true)))
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).toEqual([])
    act(() => renderer.unmount())
  })

  test('the restore retries until the last dialog closes: the drawer closing later still restores focus', async () => {
    const { calls, set } = setup()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(mobileTree(true, true))
      set(renderer)
    })
    await act(async () => {
      await Promise.resolve()
    })
    calls.length = 0
    // Settings closes while the drawer stays open: several retry periods pass
    // with nothing touching the terminal.
    act(() => renderer.update(mobileTree(false, true)))
    await act(async () => {
      await pastCloseWindow()
    })
    await act(async () => {
      await pastCloseWindow()
    })
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).toEqual([])
    // The drawer closes last: within about one retry period the terminal is
    // enabled and focused exactly once.
    act(() => renderer.update(mobileTree(false, false)))
    await act(async () => {
      await pastCloseWindow()
    })
    expect(calls).toEqual(['enable', 'terminal-focus'])
    act(() => renderer.unmount())
  })

  test('a closed drawer panel is inert; an open one is not when it takes focus', () => {
    const { set } = setup()
    // Mock DOM nodes whose focus records how inert the panel was at that moment.
    const focusedNodes: Array<{ inert: boolean }> = []
    const createNodeMock = () => {
      const node = {
        inert: false,
        focus: () => void focusedNodes.push(node),
        addEventListener: () => {},
        removeEventListener: () => {},
      }
      return node
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(mobileTree(false, false), { createNodeMock })
      set(renderer)
    })
    // Opening: the inert effect runs before the focus effect, so the panel is
    // already not inert when focus() is called.
    act(() => {
      renderer.update(mobileTree(false, true))
    })
    expect(focusedNodes.length).toBe(1)
    expect(focusedNodes[0].inert).toBe(false)
    // Closing: the panel goes inert again while it stays mounted off-canvas.
    act(() => {
      renderer.update(mobileTree(false, false))
    })
    expect(focusedNodes[0].inert).toBe(true)
    act(() => renderer.unmount())
  })
})
