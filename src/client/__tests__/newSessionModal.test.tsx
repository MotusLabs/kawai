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

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
})

function setupDom() {
  const keyHandlers = new Map<string, EventListener>()
  const textarea = {
    removeAttribute: () => {},
    focus: () => {},
  }

  globalAny.document = {
    querySelector: () => textarea,
  } as unknown as Document

  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  } as unknown as Window & typeof globalThis

  return { keyHandlers }
}

/**
 * Claude chat is the dialog's default kind; tests that exercise the terminal
 * form (command presets, hosts, first-prompt) select Terminal first. A
 * change-section launch is the one context that opens on Terminal by itself.
 */
function selectKind(renderer: TestRenderer.ReactTestRenderer, value: 'terminal' | 'chat') {
  act(() => {
    renderer.root.findByProps({ 'aria-label': 'Session kind' }).props.onChange({ target: { value } })
  })
}

describe('NewSessionModal component', () => {
  test('defaults to Claude chat, except a change-section launch which needs Terminal', () => {
    setupDom()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })

    const kindValue = () =>
      renderer.root.findByProps({ 'aria-label': 'Session kind' }).props.value as string
    expect(kindValue()).toBe('chat')
    // Chat form: profile picker instead of command presets.
    expect(renderer.root.findAllByProps({ 'data-testid': 'command-select' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'aria-label': 'Profile' })).toHaveLength(1)

    // A change-section launch offers the first-prompt selector, a terminal-only
    // affordance, so that context opens on Terminal.
    act(() => {
      renderer.update(
        <NewSessionModal
          isOpen={false}
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })
    act(() => {
      renderer.update(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          initialPath="/repo/.worktrees/add-auth"
          initialAutoStartChange="add-auth"
        />
      )
    })
    expect(kindValue()).toBe('terminal')
    expect(renderer.root.findAllByProps({ 'data-testid': 'start-with-select' })).toHaveLength(1)

    // Reopening without a change context falls back to the chat default.
    act(() => {
      renderer.update(
        <NewSessionModal
          isOpen={false}
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })
    act(() => {
      renderer.update(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })
    expect(kindValue()).toBe('chat')

    act(() => {
      renderer.unmount()
    })
  })

  test('submits resolved values and closes', () => {
    setupDom()

    const created: Array<{ path: string; name?: string; command?: string }> = []
    let closed = 0

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={(path, name, command) => {
            created.push({ path, name, command })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          lastProjectPath="/last"
          activeProjectPath="/active"
        />
      )
    })

    selectKind(renderer, 'terminal')

    // With new field order: modifiers/command (index 0), project path (index 1), name (index 2)
    const inputs = renderer.root.findAllByType('input')
    const projectInput = inputs[1]
    const nameInput = inputs[2]

    act(() => {
      projectInput.props.onChange({ target: { value: 'repo' } })
      nameInput.props.onChange({ target: { value: ' Alpha ' } })
    })

    const buttons = renderer.root.findAllByType('button')
    const customButton = buttons.find((button) => {
      const children = Array.isArray(button.props.children)
        ? button.props.children
        : [button.props.children]
      return children.some((c: unknown) => c === 'Custom')
    })

    if (!customButton) {
      throw new Error('Expected custom command button')
    }

    act(() => {
      customButton.props.onClick()
    })

    // Custom command input is now at index 0 (first in the form)
    const commandInput = renderer.root.findAllByType('input')[0]

    act(() => {
      commandInput.props.onChange({ target: { value: ' bun run dev ' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    expect(created).toEqual([
      { path: 'repo', name: 'Alpha', command: 'bun run dev' },
    ])
    expect(closed).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('closes on overlay click and escape', () => {
    const { keyHandlers } = setupDom()
    let closed = 0

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })

    const overlay = renderer.root.findByProps({ role: 'dialog' })

    act(() => {
      overlay.props.onClick({ target: overlay, currentTarget: overlay })
    })

    act(() => {
      keyHandlers.get('keydown')?.({ key: 'Escape' } as KeyboardEvent)
    })

    expect(closed).toBe(2)

    act(() => {
      renderer.unmount()
    })
  })

  test('allows editing full command', () => {
    setupDom()

    const created: Array<{ path: string; name?: string; command?: string }> = []

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, name, command) => {
            created.push({ path, name, command })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          lastProjectPath="/last"
          activeProjectPath="/active"
        />
      )
    })

    selectKind(renderer, 'terminal')

    // Command input is the first input field
    const inputs = renderer.root.findAllByType('input')
    const commandInput = inputs[0]

    // Edit the full command (preset starts with 'claude')
    act(() => {
      commandInput.props.onChange({ target: { value: 'claude --model opus --dangerously-skip-permissions' } })
    })

    const form = renderer.root.findByType('form')

    act(() => {
      form.props.onSubmit({ preventDefault: () => {} })
    })

    // Command should be the full edited command
    expect(created[0].command).toBe('claude --model opus --dangerously-skip-permissions')

    act(() => {
      renderer.unmount()
    })
  })

  test('discovered-worktree picker fills the path and submits the worktree root', () => {
    setupDom()

    const created: Array<{ path: string; host?: string }> = []
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, host) => {
            created.push({ path, host })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          worktrees={[
            {
              worktreeId: '/repo/.git::/repo',
              repositoryName: 'repo',
              path: '/repo',
              branch: 'main',
              detached: false,
              headRevision: 'aaaaaaa1',
            },
            {
              worktreeId: '/repo/.git::/repo-feat',
              repositoryName: 'repo',
              path: '/repo-feat',
              detached: true,
              headRevision: 'bbbbbbb2',
            },
          ]}
        />
      )
    })

    selectKind(renderer, 'terminal')

    const picker = renderer.root.findByProps({ 'data-testid': 'worktree-picker' })
    const options = picker.findAllByType('option')
    expect(options.map((option) => option.props.value)).toEqual([
      '',
      '/repo/.git::/repo',
      '/repo/.git::/repo-feat',
    ])
    expect(JSON.stringify(renderer.toJSON())).toContain('repo · main')
    expect(JSON.stringify(renderer.toJSON())).toContain('@bbbbbbb')

    act(() => {
      picker.props.onChange({ target: { value: '/repo/.git::/repo-feat' } })
    })

    // Project path input (index 1) reflects the picked worktree root.
    const projectInput = renderer.root.findAllByType('input')[1]
    expect(projectInput.props.value).toBe('/repo-feat')

    // The picker keeps showing the matching worktree.
    expect(renderer.root.findByProps({ 'data-testid': 'worktree-picker' }).props.value).toBe(
      '/repo/.git::/repo-feat'
    )

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([{ path: '/repo-feat', host: undefined }])

    act(() => {
      renderer.unmount()
    })
  })

  test('manual path edits reset the picker and the picker stays hidden without worktrees', () => {
    setupDom()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          lastProjectPath="/repo"
          worktrees={[
            {
              worktreeId: '/repo/.git::/repo',
              repositoryName: 'repo',
              path: '/repo',
              branch: 'main',
              detached: false,
              headRevision: 'aaaaaaa1',
            },
          ]}
        />
      )
    })

    selectKind(renderer, 'terminal')

    // lastProjectPath matches a discovered worktree: the picker shows it.
    const picker = renderer.root.findByProps({ 'data-testid': 'worktree-picker' })
    expect(picker.props.value).toBe('/repo/.git::/repo')

    // Editing the path manually falls back to the placeholder.
    const projectInput = renderer.root.findAllByType('input')[1]
    act(() => {
      projectInput.props.onChange({ target: { value: '/somewhere/else' } })
    })
    expect(renderer.root.findByProps({ 'data-testid': 'worktree-picker' }).props.value).toBe('')

    act(() => {
      renderer.unmount()
    })

    // No discovered worktrees: no picker at all, manual entry untouched.
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })
    selectKind(renderer, 'terminal')
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'worktree-picker' })
    ).toHaveLength(0)
    expect(renderer.root.findAllByType('input')).toHaveLength(3)

    act(() => {
      renderer.unmount()
    })
  })
})

describe('NewSessionModal first-prompt selector', () => {
  test('offers Claude, Codex, and Nothing labelled with the literal prompts, defaulting from the preset', () => {
    setupDom()

    const created: Array<{
      path: string
      autoStartChange?: string
      autoStartAgent?: string
    }> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, _host, autoStartChange, autoStartAgent) => {
            created.push({ path, autoStartChange, autoStartAgent })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          initialPath="/repo/.worktrees/add-auth"
          initialAutoStartChange="add-auth"
        />
      )
    })

    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    // The default preset is Claude, so the selector defaults to Claude.
    expect(select.props.value).toBe('claude')
    const options = select.findAllByType('option')
    expect(options.map((option) => option.props.value)).toEqual(['claude', 'codex', 'none'])
    // Each option carries the literal prompt it would send.
    expect(
      options.map((option) =>
        Array.isArray(option.props.children)
          ? option.props.children.join('')
          : option.props.children
      )
    ).toEqual([
      'Claude - /opsx:apply add-auth',
      'Codex - $openspec-apply-change add-auth',
      'Nothing',
    ])

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([
      { path: '/repo/.worktrees/add-auth', autoStartChange: 'add-auth', autoStartAgent: 'claude' },
    ])

    act(() => {
      renderer.unmount()
    })
  })

  test('selecting Nothing submits without change name or agent', () => {
    setupDom()

    const created: Array<{
      autoStartChange?: string
      autoStartAgent?: string
    }> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(_path, _name, _command, _host, autoStartChange, autoStartAgent) => {
            created.push({ autoStartChange, autoStartAgent })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          initialAutoStartChange="add-auth"
        />
      )
    })

    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    act(() => {
      select.props.onChange({ target: { value: 'none' } })
    })
    expect(select.props.value).toBe('none')

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([{ autoStartChange: undefined, autoStartAgent: undefined }])

    act(() => {
      renderer.unmount()
    })
  })

  test('default precedence: preset agentType outranks the command, then the prefix rule, then Nothing', () => {
    setupDom()

    // A preset that declares claude while its command is a wrapper — the
    // declaration wins.
    const wrapperPreset = {
      id: 'glm',
      label: 'GLM',
      command: 'claude-glm --yolo',
      isBuiltIn: false,
      agentType: 'claude' as const,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={[...DEFAULT_PRESETS, wrapperPreset]}
          defaultPresetId="glm"
          initialAutoStartChange="add-auth"
        />
      )
    })
    expect(renderer.root.findByProps({ 'data-testid': 'start-with-select' }).props.value).toBe('claude')

    // Custom mode with a wrapper command: no preset declaration, so the
    // prefix rule on the resolved token picks Claude.
    const buttons = renderer.root.findAllByType('button')
    const customButton = buttons.find((button) => {
      const children = Array.isArray(button.props.children)
        ? button.props.children
        : [button.props.children]
      return children.some((c: unknown) => c === 'Custom')
    })
    act(() => {
      customButton!.props.onClick()
    })
    const commandInput = renderer.root.findAllByType('input')[0]
    act(() => {
      commandInput.props.onChange({ target: { value: 'env FOO=1 npx claude-glm --yolo' } })
    })
    expect(renderer.root.findByProps({ 'data-testid': 'start-with-select' }).props.value).toBe('claude')

    // An unrecognized command defaults to Nothing — but stays selectable.
    act(() => {
      commandInput.props.onChange({ target: { value: 'vim .' } })
    })
    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    expect(select.props.value).toBe('none')

    act(() => {
      renderer.unmount()
    })
  })

  test('an explicit selection survives subsequent command edits', () => {
    setupDom()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          initialAutoStartChange="add-auth"
        />
      )
    })

    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    act(() => {
      select.props.onChange({ target: { value: 'codex' } })
    })
    // Editing the command away from the preset no longer re-derives the
    // default — the user's choice sticks.
    const commandInput = renderer.root.findAllByType('input')[0]
    act(() => {
      commandInput.props.onChange({ target: { value: 'vim .' } })
    })
    expect(renderer.root.findByProps({ 'data-testid': 'start-with-select' }).props.value).toBe('codex')

    act(() => {
      renderer.unmount()
    })
  })

  test('the selector is offered on remote hosts and the submission carries change and agent', () => {
    setupDom()

    const created: Array<{
      path: string
      host?: string
      autoStartChange?: string
      autoStartAgent?: string
    }> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={(path, _name, _command, host, autoStartChange, autoStartAgent) => {
            created.push({ path, host, autoStartChange, autoStartAgent })
          }}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          remoteHosts={[
            { host: 'box', ok: true, lastUpdated: '2026-01-01T00:00:00.000Z' },
          ]}
          remoteAllowControl
          initialHost="box"
          initialAutoStartChange="add-auth"
        />
      )
    })

    // No local-host gate: the dropdown renders for a remote host.
    const select = renderer.root.findByProps({ 'data-testid': 'start-with-select' })
    expect(select.props.value).toBe('claude')

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([
      {
        path: '/base',
        host: 'box',
        autoStartChange: 'add-auth',
        autoStartAgent: 'claude',
      },
    ])

    act(() => {
      renderer.unmount()
    })
  })

  test('no first-prompt affordance without a change context', () => {
    setupDom()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {}}
          onCreate={() => {}}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
        />
      )
    })

    selectKind(renderer, 'terminal')

    expect(renderer.root.findAllByProps({ 'data-testid': 'start-with-select' })).toHaveLength(0)
    // The form keeps exactly its three inputs (command, path, name).
    expect(renderer.root.findAllByType('input')).toHaveLength(3)

    act(() => {
      renderer.unmount()
    })
  })
})

describe('NewSessionModal project path validation', () => {
  function renderModal(overrides: Record<string, unknown> = {}) {
    setupDom()
    const created: unknown[] = []
    let closed = 0

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NewSessionModal
          isOpen
          onClose={() => {
            closed += 1
          }}
          onCreate={((...args: unknown[]) => {
            created.push(args)
          }) as never}
          defaultProjectDir="/base"
          commandPresets={DEFAULT_PRESETS}
          defaultPresetId="claude"
          {...overrides}
        />
      )
    })

    return {
      renderer,
      created,
      get closed() {
        return closed
      },
      submit: () => {
        act(() => {
          renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
        })
      },
      pathError: () => {
        const matches = renderer.root.findAllByProps({ 'data-testid': 'project-path-error' })
        return matches.length > 0 ? String(matches[0].props.children) : null
      },
    }
  }

  test('empty project path refuses create and shows an inline error', () => {
    const modal = renderModal()
    selectKind(modal.renderer, 'terminal')
    const projectInput = modal.renderer.root.findAllByType('input')[1]

    act(() => {
      projectInput.props.onChange({ target: { value: '   ' } })
    })
    modal.submit()

    expect(modal.pathError()).toBe('Enter a project path to create the session.')
    expect(modal.created).toHaveLength(0)
    expect(modal.closed).toBe(0)
    // The input is marked invalid so the reason is reachable to assistive tech.
    expect(
      modal.renderer.root.findAllByType('input')[1].props['aria-invalid']
    ).toBe('true')

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('empty project path refuses chat create too', () => {
    const modal = renderModal()
    const kindSelect = modal.renderer.root.findByProps({ 'aria-label': 'Session kind' })

    act(() => {
      kindSelect.props.onChange({ target: { value: 'chat' } })
    })
    const projectInput = modal.renderer.root.findAllByType('input')[0]
    act(() => {
      projectInput.props.onChange({ target: { value: '' } })
    })
    modal.submit()

    expect(modal.pathError()).toBe('Enter a project path to create the session.')
    expect(modal.created).toHaveLength(0)
    expect(modal.closed).toBe(0)

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('typing a path clears the error and allows create', () => {
    const modal = renderModal()
    selectKind(modal.renderer, 'terminal')
    const projectInput = modal.renderer.root.findAllByType('input')[1]

    // Clear the prefilled default so submit is refused and raises the error.
    act(() => {
      projectInput.props.onChange({ target: { value: '' } })
    })
    modal.submit()
    expect(modal.pathError()).not.toBeNull()

    act(() => {
      projectInput.props.onChange({ target: { value: '/work/repo' } })
    })
    expect(modal.pathError()).toBeNull()

    modal.submit()
    expect(modal.pathError()).toBeNull()
    expect(modal.created).toHaveLength(1)
    expect(modal.closed).toBe(1)

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('a modal with no pre-filled path starts clean and refuses on submit', () => {
    // Nothing supplies a default: no active/last project and no default dir.
    const modal = renderModal({
      defaultProjectDir: '',
      lastProjectPath: null,
      activeProjectPath: undefined,
    })

    expect(modal.pathError()).toBeNull()

    modal.submit()
    expect(modal.pathError()).toBe('Enter a project path to create the session.')
    expect(modal.created).toHaveLength(0)
    expect(modal.closed).toBe(0)

    act(() => {
      modal.renderer.unmount()
    })
  })

  test('prop updates while open do not wipe what the user typed', () => {
    // server-info (and thus defaultProjectDir) arrives asynchronously after
    // the dialog opens; re-initializing on that change used to silently reset
    // the form under the user's hands.
    setupDom()
    const created: Array<{ path: string; name?: string }> = []

    const form = (props: { defaultProjectDir: string; lastProjectPath?: string | null }) => (
      <NewSessionModal
        isOpen
        onClose={() => {}}
        onCreate={((path: string, name?: string) => {
          created.push({ path, name })
        }) as never}
        defaultProjectDir={props.defaultProjectDir}
        commandPresets={DEFAULT_PRESETS}
        defaultPresetId="claude"
        lastProjectPath={props.lastProjectPath}
      />
    )

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(form({ defaultProjectDir: '' }))
    })

    selectKind(renderer, 'terminal')
    const [projectInput, nameInput] = renderer.root.findAllByType('input').slice(1)
    act(() => {
      projectInput.props.onChange({ target: { value: '/typed/by/user' } })
      nameInput.props.onChange({ target: { value: 'My name' } })
    })

    // The async default lands while the dialog is still open.
    act(() => {
      renderer.update(form({ defaultProjectDir: '/late/default', lastProjectPath: '/late/last' }))
    })

    const inputs = renderer.root.findAllByType('input')
    expect(inputs[1].props.value).toBe('/typed/by/user')
    expect(inputs[2].props.value).toBe('My name')

    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
    expect(created).toEqual([{ path: '/typed/by/user', name: 'My name' }])

    act(() => {
      renderer.unmount()
    })
  })
})
