import { useSessionStore } from '../stores/sessionStore'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import NewSessionModal from '../components/NewSessionModal'
import ChatView from '../components/chat/ChatView'
import { DEFAULT_PRESETS } from '../stores/settingsStore'
import type { Session } from '../../shared/types'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const originalDocument = globalThis.document
const metadata = [{ id: 'default', label: 'Default' }, { id: 'glm', label: 'GLM' }]
const created: unknown[][] = []
const renderers: TestRenderer.ReactTestRenderer[] = []
beforeEach(() => {
  created.length = 0
  globalThis.window = { addEventListener() {}, removeEventListener() {}, setTimeout() { return 1 } } as unknown as Window & typeof globalThis
  globalThis.document = { querySelector() { return { removeAttribute() {}, focus() {} } } } as unknown as Document
  globalThis.fetch = (async () => Response.json({ profiles: metadata, errors: [] })) as unknown as typeof fetch
})
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount())
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  globalThis.document = originalDocument
})
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }
async function modal() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<NewSessionModal isOpen onClose={() => {}} onCreate={(...args) => created.push(args)} defaultProjectDir="/tmp" commandPresets={DEFAULT_PRESETS} defaultPresetId="claude" />)
    await settle()
  })
  renderers.push(renderer)
  return renderer
}
async function kind(renderer: TestRenderer.ReactTestRenderer, value: string) {
  await act(async () => { renderer.root.findByProps({ 'aria-label': 'Session kind' }).props.onChange({ target: { value } }); await settle() })
}
function submit(renderer: TestRenderer.ReactTestRenderer) { act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })) }

test('chat catalog selects Default or named profile and terminal creation remains independent', async () => {
  const renderer = await modal()
  expect(renderer.root.findAllByProps({ 'aria-label': 'Profile' })).toHaveLength(0)
  await kind(renderer, 'chat')
  expect(renderer.root.findByProps({ 'aria-label': 'Profile' }).props.value).toBe('default')
  submit(renderer)
  expect(created[0]?.[7]).toBe('default')
  act(() => renderer.root.findByProps({ 'aria-label': 'Profile' }).props.onChange({ target: { value: 'glm' } }))
  submit(renderer)
  expect(created[1]?.[7]).toBe('glm')
  await kind(renderer, 'terminal')
  expect(renderer.root.findAllByProps({ 'aria-label': 'Profile' })).toHaveLength(0)
  submit(renderer)
  expect(created[2]?.[7]).toBeUndefined()
})
test('catalog refetches with the entered project path', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input))
    return Response.json({ profiles: metadata, errors: [] })
  }) as unknown as typeof fetch
  const renderer = await modal()
  await kind(renderer, 'chat')
  // The modal opens with the default project dir prefilled.
  expect(urls.some(url => url.includes(`projectPath=${encodeURIComponent('/tmp')}`))).toBe(true)

  // Typing a different project path refetches the catalog for that path.
  await act(async () => {
    const pathInput = renderer.root.findAllByType('input').find(input => input.props.value === '/tmp')!
    pathInput.props.onChange({ target: { value: '/work/glm-flash' } })
    await settle()
  })
  expect(urls.some(url => url.includes(`projectPath=${encodeURIComponent('/work/glm-flash')}`))).toBe(true)
})

test('catalog file warnings are visible without blocking creation', async () => {
  globalThis.fetch = (async () => Response.json({
    profiles: metadata,
    errors: ['/work/proj/.kawai/profiles.json: invalid JSON (unexpected end of input).'],
  })) as unknown as typeof fetch
  const renderer = await modal()
  await kind(renderer, 'chat')
  const warning = renderer.root.findByProps({ role: 'status' })
  expect(warning.children.join('')).toContain('/work/proj/.kawai/profiles.json')
  // The rest of the catalog resolved: selection and creation still work.
  expect(renderer.root.findByProps({ 'aria-label': 'Profile' }).props.disabled).toBe(false)
  submit(renderer)
  expect(created[0]?.[7]).toBe('default')
})

test('chat header label resolves from the session project path catalog', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input))
    return Response.json({ profiles: metadata, errors: [] })
  }) as unknown as typeof fetch
  const session: Session = { id: 'chat-path', name: 'Path test', projectPath: '/work/proj', status: 'waiting', source: 'managed', kind: 'chat', createdAt: '', lastActivity: '', claudeProfileId: 'glm' }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<ChatView session={session} sendMessage={() => {}} connectionStatus="connected" connectionEpoch={1} error={null} onClose={() => {}} onKill={() => {}} />)
    await settle()
  })
  renderers.push(renderer)
  expect(urls.some(url => url.includes(`projectPath=${encodeURIComponent('/work/proj')}`))).toBe(true)
  expect(renderer.root.findByProps({ 'data-testid': 'chat-profile' }).children.join('')).toBe('Profile: GLM')
})

test('loading and catalog error block submission and Retry recovers without losing selection', async () => {
  const renderer = await modal()
  let release!: (response: Response) => void
  globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve })) as unknown as typeof fetch
  await kind(renderer, 'chat')
  submit(renderer)
  expect(created).toEqual([])
  expect(renderer.root.findByProps({ 'aria-label': 'Profile' }).props.disabled).toBe(true)
  await act(async () => { release(Response.json({ error: 'failed' }, { status: 500 })); await settle() })
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('HTTP 500')
  submit(renderer)
  expect(created).toEqual([])
  globalThis.fetch = (async () => Response.json({ profiles: metadata, errors: [] })) as unknown as typeof fetch
  const retry = renderer.root.findAllByType('button').find(button => button.children.includes('Retry profiles'))!
  await act(async () => { retry.props.onClick(); await settle() })
  expect(renderer.root.findByProps({ 'aria-label': 'Profile' }).props.disabled).toBe(false)
  submit(renderer)
  expect(created[0]?.[7]).toBe('default')
})
test('chat header displays labels, legacy Default, unknown ID fallback and reconnect identity', async () => {
  const session: Session = { id: 'chat-test', name: 'Profile test', projectPath: '/tmp', status: 'waiting', source: 'managed', kind: 'chat', createdAt: '', lastActivity: '', claudeProfileId: 'glm' }
  const sent: unknown[] = []
  const sendMessage = (message: unknown) => { sent.push(message) }
  const props = { session, sendMessage, connectionStatus: 'connected' as const, connectionEpoch: 1, error: null, onClose() {}, onKill() {} }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<ChatView {...props} />); await settle() })
  renderers.push(renderer)
  const label = () => renderer.root.findByProps({ 'data-testid': 'chat-profile' }).children.join('')
  expect(label()).toBe('Profile: GLM')
  act(() => renderer.update(<ChatView {...props} connectionEpoch={2} />))
  expect(label()).toBe('Profile: GLM')
  expect(sent.filter((message: any) => message.type === 'chat-attach')).toHaveLength(2)
  act(() => renderer.update(<ChatView {...props} session={{ ...session, claudeProfileId: undefined }} />))
  expect(label()).toBe('Profile: Default')
  globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  act(() => renderer.update(<ChatView {...props} session={{ ...session, claudeProfileId: 'removed' }} />))
  expect(label()).toBe('Profile: removed')
})


test('profile-only session snapshots update the client store', () => {
  const session: Session = { id: 'chat-snapshot', name: 'Snapshot', projectPath: '/tmp', status: 'waiting', source: 'managed', kind: 'chat', createdAt: '', lastActivity: '', claudeProfileId: 'default' }
  useSessionStore.getState().setSessions([session])
  useSessionStore.getState().setSessions([{ ...session, claudeProfileId: 'glm' }])
  expect(useSessionStore.getState().sessions[0]?.claudeProfileId).toBe('glm')
  useSessionStore.getState().setSessions([])
})
