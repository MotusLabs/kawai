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

describe('NewSessionModal component', () => {
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
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'worktree-picker' })
    ).toHaveLength(0)
    expect(renderer.root.findAllByType('input')).toHaveLength(3)

    act(() => {
      renderer.unmount()
    })
  })
})
