import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import SettingsModal from '../components/SettingsModal'
import { Switch } from '../components/Switch'
import {
  DEFAULT_PRESETS,
  DEFAULT_PROJECT_DIR,
  useSettingsStore,
} from '../stores/settingsStore'
import { useThemeStore } from '../stores/themeStore'

const globalAny = globalThis as typeof globalThis & {
  localStorage?: Storage
}

const originalLocalStorage = globalAny.localStorage

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

beforeEach(() => {
  globalAny.localStorage = createStorage()
  useSettingsStore.setState({
    defaultProjectDir: '/projects',
    defaultCommand: 'codex',
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'codex',
    lastProjectPath: null,
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    defaultApprovalPolicy: 'manual',
    hostFilters: [],
  })
  useThemeStore.setState({ theme: 'dark' })
})

afterEach(() => {
  globalAny.localStorage = originalLocalStorage
  useSettingsStore.setState({
    defaultProjectDir: DEFAULT_PROJECT_DIR,
    defaultCommand: 'claude',
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'claude',
    lastProjectPath: null,
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    defaultApprovalPolicy: 'manual',
    hostFilters: [],
  })
  useThemeStore.setState({ theme: 'dark' })
})

describe('SettingsModal', () => {
  test('keeps terminal colors disabled until the initial setting loads', async () => {
    const originalFetch = globalThis.fetch
    let resolveTerminalColors!: (response: Response) => void
    const terminalColorsResponse = new Promise<Response>((resolve) => {
      resolveTerminalColors = resolve
    })

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/settings/terminal-colors') {
        return terminalColorsResponse
      }
      const payload = url.includes('history-max-age-hours')
        ? { hours: 24 }
        : { enabled: true }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(
          <SettingsModal isOpen onClose={() => {}} />
        )
        await Promise.resolve()
      })

      const findColorSwitch = () => {
        const colorSwitch = renderer.root
          .findAllByType(Switch)
          .find((component) => component.props.ariaLabel === 'Enable terminal colors')
        if (!colorSwitch) throw new Error('Expected terminal colors switch')
        return colorSwitch
      }

      expect(findColorSwitch().props.disabled).toBe(true)

      await act(async () => {
        resolveTerminalColors(new Response(JSON.stringify({ enabled: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
        await terminalColorsResponse
        await Promise.resolve()
      })

      expect(findColorSwitch().props.checked).toBe(false)
      expect(findColorSwitch().props.disabled).toBe(false)
    } finally {
      renderer?.unmount()
      globalThis.fetch = originalFetch
    }
  })

  test('loads and updates the global terminal colors setting', async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; method: string; body: string | null }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({
        url,
        method,
        body: typeof init?.body === 'string' ? init.body : null,
      })
      const payload = url.includes('history-max-age-hours')
        ? { hours: 24 }
        : { enabled: true }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    let renderer!: TestRenderer.ReactTestRenderer
    try {
      await act(async () => {
        renderer = TestRenderer.create(
          <SettingsModal isOpen onClose={() => {}} />
        )
        await Promise.resolve()
      })

      const colorSwitch = renderer.root
        .findAllByType(Switch)
        .find((component) => component.props.ariaLabel === 'Enable terminal colors')
      if (!colorSwitch) {
        throw new Error('Expected terminal colors switch')
      }
      expect(colorSwitch.props.checked).toBe(true)

      await act(async () => {
        colorSwitch.props.onCheckedChange(false)
        await Promise.resolve()
      })

      expect(requests).toContainEqual({
        url: '/api/settings/terminal-colors',
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    } finally {
      renderer?.unmount()
      globalThis.fetch = originalFetch
    }
  })

  test('submits trimmed values and falls back to defaults', () => {
    let closed = 0
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={() => { closed += 1 }} />
      )
    })

    const inputs = renderer.root.findAllByType('input')
    const dirInput = inputs[0]

    act(() => {
      dirInput.props.onChange({ target: { value: '   ' } })
    })

    const statusButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Status')

    if (!statusButton) {
      throw new Error('Expected status button')
    }

    act(() => {
      statusButton.props.onClick()
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    const state = useSettingsStore.getState()
    expect(state.defaultProjectDir).toBe(DEFAULT_PROJECT_DIR)
    expect(state.sessionSortMode).toBe('status')
    expect(state.sessionSortDirection).toBe('desc')
    expect(state.commandPresets.length).toBe(3)
    expect(closed).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('resets draft values when reopened', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    const onClose = () => {}

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={onClose} />
      )
    })

    let inputs = renderer.root.findAllByType('input')
    const dirInput = inputs[0]

    act(() => {
      dirInput.props.onChange({ target: { value: '/dirty' } })
    })

    act(() => {
      useSettingsStore.setState({
        defaultProjectDir: '/next',
        defaultPresetId: 'claude',
        sessionSortMode: 'status',
        sessionSortDirection: 'asc',
      })
    })

    act(() => {
      renderer.update(<SettingsModal isOpen={false} onClose={onClose} />)
    })

    act(() => {
      renderer.update(<SettingsModal isOpen onClose={onClose} />)
    })

    inputs = renderer.root.findAllByType('input')
    expect(inputs[0].props.value).toBe('/next')

    const statusButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Status')

    if (!statusButton) {
      throw new Error('Expected status button')
    }

    expect(statusButton.props.className).toContain('btn-primary')

    act(() => {
      renderer.unmount()
    })
  })

  test('chat font size stepper stops at 12 and 20 and saves without touching the terminal size', () => {
    useSettingsStore.setState({ chatFontSize: 13, fontSize: 13 })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })
    const button = (label: string) => renderer.root.findByProps({ 'aria-label': label })

    act(() => { button('Decrease Chat Font Size').props.onClick() })
    expect(button('Decrease Chat Font Size').props.disabled).toBe(true)
    act(() => { button('Decrease Chat Font Size').props.onClick() })
    expect(useSettingsStore.getState().chatFontSize).toBe(13)

    for (let i = 0; i < 10; i += 1) {
      act(() => { button('Increase Chat Font Size').props.onClick() })
    }
    expect(button('Increase Chat Font Size').props.disabled).toBe(true)

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(useSettingsStore.getState().chatFontSize).toBe(20)
    expect(useSettingsStore.getState().fontSize).toBe(13)
    act(() => { renderer.unmount() })
  })

  test('closing without saving discards the chat font size draft', () => {
    useSettingsStore.setState({ chatFontSize: 15 })
    const onClose = () => {}
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={onClose} />)
    })
    act(() => { renderer.root.findByProps({ 'aria-label': 'Increase Chat Font Size' }).props.onClick() })
    const cancel = renderer.root.findAllByType('button').find(b => b.props.children === 'Cancel' && b.props.className === 'btn')
    if (!cancel) throw new Error('Expected cancel button')
    act(() => { cancel.props.onClick() })
    expect(useSettingsStore.getState().chatFontSize).toBe(15)

    act(() => { renderer.update(<SettingsModal isOpen={false} onClose={onClose} />) })
    act(() => { renderer.update(<SettingsModal isOpen onClose={onClose} />) })
    const stepper = renderer.root.findByProps({ 'aria-label': 'Increase Chat Font Size' }).parent
    const value = stepper?.findAll(node => node.type === 'span' && String(node.props.className).includes('w-6'))[0]
    expect(value?.props.children).toBe(15)
    act(() => { renderer.unmount() })
  })

  test('tab panels are paired with their tabs and sit in strip order', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })

    const tabs = renderer.root.findAllByType('button').filter(button => button.props.role === 'tab')
    const panels = renderer.root.findAllByProps({ role: 'tabpanel' })
    expect(tabs.map(tab => tab.props.id)).toEqual([
      'settings-tab-sessions', 'settings-tab-chat', 'settings-tab-terminal', 'settings-tab-general',
    ])
    // Panels follow the same order, so document-order pairing matches too.
    expect(panels.map(panel => panel.props.id)).toEqual([
      'settings-panel-sessions', 'settings-panel-chat', 'settings-panel-terminal', 'settings-panel-general',
    ])
    for (const tab of tabs) {
      expect(tab.props['aria-controls']).toBe(`settings-panel-${String(tab.props.id).replace('settings-tab-', '')}`)
    }
    for (const panel of panels) {
      expect(panel.props['aria-labelledby']).toBe(`settings-tab-${String(panel.props.id).replace('settings-panel-', '')}`)
    }

    act(() => { renderer.unmount() })
  })

  test('arrow keys move the tab selection and only the active tab is tabbable', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })
    const tablist = renderer.root.findByProps({ role: 'tablist' })
    const tabs = () => renderer.root.findAllByType('button').filter(button => button.props.role === 'tab')
    const selected = () => tabs().findIndex(tab => tab.props['aria-selected'] === true)
    const pressed: number[] = []
    // react-test-renderer has no DOM; stand in for querySelectorAll(...)[n].focus().
    const currentTarget = {
      querySelectorAll: () => [{ focus: () => pressed.push(0) }, { focus: () => pressed.push(1) }, { focus: () => pressed.push(2) }, { focus: () => pressed.push(3) }],
    }
    const key = (value: string) =>
      act(() => { tablist.props.onKeyDown({ key: value, preventDefault: () => {}, currentTarget }) })

    expect(selected()).toBe(0)
    expect(tabs().map(tab => tab.props.tabIndex)).toEqual([0, -1, -1, -1])

    key('ArrowRight')
    expect(selected()).toBe(1)
    expect(tabs().map(tab => tab.props.tabIndex)).toEqual([-1, 0, -1, -1])
    expect(tabs()[1]!.props['aria-selected']).toBe(true)

    key('ArrowLeft')
    expect(selected()).toBe(0)

    key('End')
    expect(selected()).toBe(3)
    key('Home')
    expect(selected()).toBe(0)

    // Wraps at both ends.
    key('ArrowLeft')
    expect(selected()).toBe(3)
    key('ArrowRight')
    expect(selected()).toBe(0)

    // Every move refocused the newly selected tab.
    expect(pressed).toEqual([1, 0, 3, 0, 3, 0])
    act(() => { renderer.unmount() })
  })

  test('approval policy commits on Save and reverts the other segment', () => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'auto' })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })

    // The Sessions tab also has a "Manual" sort button, so scope to the
    // approval section of the Chat tab.
    const approvalButtons = () => {
      const section = renderer.root.findByProps({ children: 'New Chat Sessions' }).parent
      if (!section) throw new Error('Expected approval section')
      return section.findAllByType('button')
    }

    expect(approvalButtons().map((button) => button.props.children)).toEqual(['Manual', 'Auto-approve'])
    expect(approvalButtons()[1].props.className).toContain('btn-primary')

    act(() => { approvalButtons()[0].props.onClick() })
    expect(approvalButtons()[0].props.className).toContain('btn-primary')
    expect(approvalButtons()[1].props.className).not.toContain('btn-primary')

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(useSettingsStore.getState().defaultApprovalPolicy).toBe('manual')

    act(() => { renderer.unmount() })
  })

  test('closing without saving discards the approval policy draft', () => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'manual' })
    const onClose = () => {}
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={onClose} />)
    })

    const approvalButtons = () => {
      const section = renderer.root.findByProps({ children: 'New Chat Sessions' }).parent
      if (!section) throw new Error('Expected approval section')
      return section.findAllByType('button')
    }

    act(() => { approvalButtons()[1].props.onClick() })

    const cancel = renderer.root.findAllByType('button').find(b => b.props.children === 'Cancel' && b.props.className === 'btn')
    if (!cancel) throw new Error('Expected cancel button')
    act(() => { cancel.props.onClick() })
    expect(useSettingsStore.getState().defaultApprovalPolicy).toBe('manual')

    // Reopening starts from the stored default again, not the discarded draft.
    act(() => { renderer.update(<SettingsModal isOpen={false} onClose={onClose} />) })
    act(() => { renderer.update(<SettingsModal isOpen onClose={onClose} />) })
    expect(approvalButtons()[1].props.className).not.toContain('btn-primary')
    expect(approvalButtons()[0].props.className).toContain('btn-primary')
    act(() => { renderer.unmount() })
  })

  test('approval policy radiogroup exposes checked state and arrow-key selection', () => {
    useSettingsStore.setState({ defaultApprovalPolicy: 'manual' })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })

    const group = renderer.root.findByProps({ 'data-testid': 'default-approval-policy-select' })
    expect(group.props.role).toBe('radiogroup')
    const segments = () => group.findAllByType('button')
    expect(segments().map(button => button.props['aria-checked'])).toEqual([true, false])
    expect(segments().map(button => button.props.tabIndex)).toEqual([0, -1])

    const focused: number[] = []
    const currentTarget = {
      parentElement: {
        querySelectorAll: () => [{ focus: () => focused.push(0) }, { focus: () => focused.push(1) }],
      },
    }
    // Each segment's handler closes over its own index, and focus follows the
    // selection — so the key lands on whichever segment is currently selected.
    const key = (value: string) => {
      const activeIndex = segments().findIndex(button => button.props.tabIndex === 0)
      act(() => {
        segments()[activeIndex]!.props.onKeyDown({ key: value, preventDefault: () => {}, currentTarget })
      })
    }

    key('ArrowRight')
    expect(segments().map(button => button.props['aria-checked'])).toEqual([false, true])
    expect(segments().map(button => button.props.tabIndex)).toEqual([-1, 0])
    expect(focused).toEqual([1])

    // Wraps back around, and an unmatched key leaves the draft alone.
    key('ArrowRight')
    expect(segments().map(button => button.props['aria-checked'])).toEqual([true, false])
    key('Enter')
    expect(segments().map(button => button.props['aria-checked'])).toEqual([true, false])

    act(() => { renderer.unmount() })
  })

  test('updates preset command', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={() => {}} />
      )
    })

    // Find the command input for Claude preset (first preset)
    const inputs = renderer.root.findAllByType('input')
    // Input layout: [dir, Claude label, Claude command, Codex label, Codex command]
    // The command input for Claude has placeholder 'command --flags'
    const claudeCommandInput = inputs.find((input) =>
      input.props.placeholder === 'command --flags'
    )

    if (!claudeCommandInput) {
      throw new Error('Expected command input')
    }

    act(() => {
      claudeCommandInput.props.onChange({ target: { value: 'claude --model opus' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    const state = useSettingsStore.getState()
    const claudePreset = state.commandPresets.find(p => p.id === 'claude')
    expect(claudePreset?.command).toBe('claude --model opus')

    act(() => {
      renderer.unmount()
    })
  })
  test('shows the server default directory as the project dir placeholder', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={() => {}} serverDefaultDir="/srv/work" />
      )
    })

    const dirInput = renderer.root.findAllByType('input')[0]
    expect(dirInput?.props.placeholder).toBe('/srv/work')

    act(() => {
      renderer.unmount()
    })
  })

  test('falls back to generic placeholder text without a server default', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })

    const dirInput = renderer.root.findAllByType('input')[0]
    expect(dirInput?.props.placeholder).toBe('Server default directory')

    act(() => {
      renderer.unmount()
    })
  })

  test('shows the server version beside the title', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <SettingsModal isOpen onClose={() => {}} version="1.0.0-17" />
      )
    })

    const versionLabel = renderer.root.findAllByType('span').find((node) =>
      node.children.join('') === 'v1.0.0-17'
    )
    expect(versionLabel).toBeDefined()

    act(() => {
      renderer.unmount()
    })
  })

  test('omits the version label until the server reports one', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => {}} />)
    })

    const versionLabel = renderer.root.findAllByType('span').find((node) =>
      node.children.join('').startsWith('v1.')
    )
    expect(versionLabel).toBeUndefined()

    act(() => {
      renderer.unmount()
    })
  })
})
