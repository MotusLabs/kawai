// The New Session dialog's missing-groups notice (starter-team-setup D2): a
// chat for a project whose team has no project group file shows it, from the
// groups route's `setupAvailable` for the shown path only; it follows path
// changes, never shows for terminal sessions, never blocks creating the chat,
// and its link closes the dialog and opens the team's Members tab — the team
// key being the repository's main checkout when the path is a worktree.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import NewSessionModal from '../components/NewSessionModal'
import { DEFAULT_PRESETS } from '../stores/settingsStore'
import { useTeamLocationStore } from '../hooks/useTeamLocation'
import { useWorkspaceStore } from '../stores/workspaceStore'

const globalAny = globalThis as typeof globalThis & { window?: Window & typeof globalThis; document?: Document }
const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalFetch = globalThis.fetch
const originalWorkspace = useWorkspaceStore.getState().snapshot

beforeEach(() => {
  globalAny.document = { querySelector: () => ({ removeAttribute: () => {}, focus: () => {} }) } as unknown as Document
  globalAny.window = {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (() => 1) as unknown as typeof setTimeout,
  } as unknown as Window & typeof globalThis
  useTeamLocationStore.setState({ location: null })
})
afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalThis.fetch = originalFetch
  useTeamLocationStore.setState({ location: null })
  useWorkspaceStore.setState({ snapshot: originalWorkspace })
})

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** Paths whose team has no project group file; every other path has groups. */
async function dialog(withoutGroups: string[]) {
  globalThis.fetch = (async (url: string) => {
    const text = String(url)
    if (!text.startsWith('/api/chat/groups')) return Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })
    const projectPath = new URL(text, 'http://x').searchParams.get('projectPath') ?? ''
    const setupAvailable = withoutGroups.includes(projectPath)
    return Response.json({
      groups: setupAvailable ? [] : [{ id: 'devs', label: 'Dev', description: '' }],
      errors: [], warnings: [], approvalDefault: null, setupAvailable,
    })
  }) as unknown as typeof fetch
  const created: string[] = []
  const closes: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<NewSessionModal
      isOpen onClose={() => closes.push('close')} onDismiss={done => closes.push(`dismiss:${done}`)}
      onCreate={path => { created.push(path) }}
      defaultProjectDir="/repo" commandPresets={DEFAULT_PRESETS} defaultPresetId="claude"
    />)
    await settle()
  })
  return {
    renderer, created, closes,
    notice: () => renderer.root.findAllByProps({ 'data-testid': 'missing-groups-notice' }),
    setPath: async (value: string) => act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Project Path' }).props.onChange({ target: { value } })
      await settle()
    }),
    setKind: (value: 'chat' | 'terminal') => act(() => {
      renderer.root.findByProps({ 'aria-label': 'Session kind' }).props.onChange({ target: { value } })
    }),
    submit: () => act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })),
  }
}

// @covers: team-setup › The New Session dialog points a team without groups to setup › A project without groups shows the notice
test('a chat for a project without groups shows the notice with a link to the Members tab', async () => {
  const shown = await dialog(['/repo'])
  expect(shown.notice()).toHaveLength(1)
  expect(shown.renderer.root.findAllByProps({ 'data-testid': 'missing-groups-link' })).toHaveLength(1)
  act(() => shown.renderer.unmount())
})

// @covers: team-setup › The New Session dialog points a team without groups to setup › The link opens the Members tab
test('the link closes the dialog and opens the main checkout team on the Members tab', async () => {
  useWorkspaceStore.setState({
    snapshot: {
      repositories: [{
        id: 'r', name: 'repo', commonDir: '/repo/.git', branches: [],
        worktrees: [{ path: '/repo', isMain: true }, { path: '/repo/.worktrees/feat', isMain: false }],
      }],
    } as never,
  })
  const shown = await dialog(['/repo/.worktrees/feat'])
  await shown.setPath('/repo/.worktrees/feat')
  act(() => shown.renderer.root.findByProps({ 'data-testid': 'missing-groups-link' }).props.onClick())
  expect(shown.closes).toEqual(['close', 'dismiss:false'])
  expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/repo', tab: 'members' })
  expect(shown.created).toEqual([])
  act(() => shown.renderer.unmount())
})

// @covers: team-setup › The New Session dialog points a team without groups to setup › The chat can still be created
test('the notice never blocks creating the chat, with no group', async () => {
  const shown = await dialog(['/repo'])
  shown.submit()
  expect(shown.created).toEqual(['/repo'])
  expect(useTeamLocationStore.getState().location).toBeNull()
  act(() => shown.renderer.unmount())
})

// @covers: team-setup › The New Session dialog points a team without groups to setup › A project with groups shows no notice
test('the notice follows the path: it disappears for a project with groups and returns without them', async () => {
  const shown = await dialog(['/repo'])
  await shown.setPath('/other')
  expect(shown.notice()).toHaveLength(0)
  await shown.setPath('/repo')
  expect(shown.notice()).toHaveLength(1)
  act(() => shown.renderer.unmount())
})

// @covers: team-setup › The New Session dialog points a team without groups to setup › Terminal sessions show no notice
test('terminal sessions show no notice', async () => {
  const shown = await dialog(['/repo'])
  shown.setKind('terminal')
  await act(settle)
  expect(shown.notice()).toHaveLength(0)
  shown.setKind('chat')
  await act(settle)
  expect(shown.notice()).toHaveLength(1)
  act(() => shown.renderer.unmount())
})

test('a failed lookup shows no notice', async () => {
  globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<NewSessionModal isOpen onClose={() => {}} onCreate={() => {}}
      defaultProjectDir="/repo" commandPresets={DEFAULT_PRESETS} defaultPresetId="claude" />)
    await settle()
  })
  expect(renderer.root.findAllByProps({ 'data-testid': 'missing-groups-notice' })).toHaveLength(0)
  act(() => renderer.unmount())
})

test('App’s opener receives the shown path, so it can ask the server to discover it first', async () => {
  globalThis.fetch = (async (url: string) => String(url).startsWith('/api/chat/groups')
    ? Response.json({ groups: [], errors: [], warnings: [], approvalDefault: null, setupAvailable: true })
    : Response.json({ profiles: [{ id: 'default', label: 'Default' }], errors: [] })) as unknown as typeof fetch
  const opened: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<NewSessionModal isOpen onClose={() => {}} onCreate={() => {}} onOpenTeamMembers={path => opened.push(path)}
      defaultProjectDir="/fresh" commandPresets={DEFAULT_PRESETS} defaultPresetId="claude" />)
    await settle()
  })
  act(() => renderer.root.findByProps({ 'data-testid': 'missing-groups-link' }).props.onClick())
  expect(opened).toEqual(['/fresh'])
  expect(useTeamLocationStore.getState().location).toBeNull()
  act(() => renderer.unmount())
})
