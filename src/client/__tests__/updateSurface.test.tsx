import { afterEach, describe, expect, jest, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ServerMessage, UpdateState } from '@shared/types'
import Header from '../components/Header'
import UpdatePanel from '../components/UpdatePanel'
import { useSessionStore } from '../stores/sessionStore'
import { useUpdateStore } from '../stores/updateStore'

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')

const withTarget = (base: string, tag = `v${base}-12`): UpdateState => ({
  current: '1.0.0-3',
  target: { tag, base, htmlUrl: `https://github.com/MotusLabs/kawai/releases/tag/${tag}` },
})
const current: UpdateState = { current: '1.0.0-3', target: null }

afterEach(() => {
  useUpdateStore.setState({ update: null, panelOpen: false })
  useSessionStore.setState({ connectionEpoch: 0 })
})

describe('header update chip', () => {
  // Created inside act(): a renderer created bare misses later act()-wrapped
  // store updates under react-test-renderer in bun.
  const header = () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <Header connectionStatus="connected" onNewSession={() => {}} onOpenSettings={() => {}}
          tailscaleIp={null} version="1.0.0-3" />)
    })
    return renderer
  }

  test('appears naming the target base while an update is reported', () => {
    act(() => { useUpdateStore.setState({ update: withTarget('1.1.0', 'v1.1.0-12') }) })
    const renderer = header()
    const chip = renderer.root.findByProps({ 'data-testid': 'update-chip' })
    expect(textOf(chip)).toContain('1.1.0')
    expect(chip.props.title).toContain('v1.1.0-12')
    expect(chip.props.title).toContain('1.0.0-3')
    renderer.unmount()
  })

  test('is absent while the running base is current', () => {
    act(() => { useUpdateStore.setState({ update: current }) })
    const renderer = header()
    expect(renderer.root.findAllByProps({ 'data-testid': 'update-chip' })).toHaveLength(0)
    renderer.unmount()
  })

  test('is persistent, not a toast: still shown long after the state lands', () => {
    jest.useFakeTimers()
    try {
      act(() => { useUpdateStore.setState({ update: withTarget('1.1.0') }) })
      const renderer = header()
      // Far past any transient-notification timeout the chip remains.
      act(() => { jest.advanceTimersByTime(30_000) })
      expect(renderer.root.findAllByProps({ 'data-testid': 'update-chip' })).toHaveLength(1)
      renderer.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  test('clicking the chip opens the update panel', () => {
    act(() => { useUpdateStore.setState({ update: withTarget('1.1.0') }) })
    const renderer = header()
    act(() => { renderer.root.findByProps({ 'data-testid': 'update-chip' }).props.onClick() })
    expect(useUpdateStore.getState().panelOpen).toBe(true)
    renderer.unmount()
  })
})

describe('update panel', () => {
  test('open shows the target and a primary action; dismiss closes', () => {
    act(() => {
      useUpdateStore.setState({ update: withTarget('1.2.0', 'v1.2.0-7'), panelOpen: true })
    })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<UpdatePanel />) })
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(textOf(dialog)).toContain('1.2.0')
    expect(textOf(dialog)).toContain('v1.2.0-7')
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'update-install' }))).toBe('Update now')
    act(() => { renderer.root.findAllByType('button').find(b => textOf(b) === 'Not now')!.props.onClick() })
    expect(useUpdateStore.getState().panelOpen).toBe(false)
    renderer.unmount()
  })

  test('the action is offered only while an update is reported', () => {
    // Panel open but no target: nothing renders.
    act(() => { useUpdateStore.setState({ update: current, panelOpen: true }) })
    let empty!: TestRenderer.ReactTestRenderer
    act(() => { empty = TestRenderer.create(<UpdatePanel />) })
    expect(empty.root.findAllByProps({ 'data-testid': 'update-install' })).toHaveLength(0)
    empty.unmount()

    // Target withdrawn mid-panel: the panel closes with it.
    act(() => { useUpdateStore.setState({ update: withTarget('1.2.0'), panelOpen: true }) })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<UpdatePanel />) })
    expect(renderer.root.findAllByProps({ 'data-testid': 'update-install' })).toHaveLength(1)
    act(() => {
      useUpdateStore.getState().apply({ type: 'update-state', update: current } satisfies ServerMessage)
    })
    expect(renderer.root.findAllByProps({ 'data-testid': 'update-install' })).toHaveLength(0)
    expect(useUpdateStore.getState().panelOpen).toBe(false)
    renderer.unmount()
  })

  test('Update now posts the install route and awaits the restart; errors surface', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    try {
      act(() => { useUpdateStore.setState({ update: withTarget('1.2.0'), panelOpen: true }) })
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<UpdatePanel />) })
      await act(async () => { renderer.root.findByProps({ 'data-testid': 'update-install' }).props.onClick() })
      expect(calls).toEqual([{ url: '/api/update/install', method: 'POST' }])
      expect(textOf(renderer.root.findByProps({ 'data-testid': 'update-install' }))).toBe('Restarting…')
      renderer.unmount()
    } finally {
      globalThis.fetch = originalFetch
    }

    // A refused update keeps the action available and names the error.
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'checksum missing' }), { status: 409 })) as unknown as typeof fetch
    try {
      act(() => { useUpdateStore.setState({ update: withTarget('1.2.0'), panelOpen: true }) })
      let failed!: TestRenderer.ReactTestRenderer
      act(() => { failed = TestRenderer.create(<UpdatePanel />) })
      await act(async () => { failed.root.findByProps({ 'data-testid': 'update-install' }).props.onClick() })
      expect(textOf(failed.root.findByProps({ role: 'alert' }))).toContain('checksum missing')
      expect(textOf(failed.root.findByProps({ 'data-testid': 'update-install' }))).toBe('Update now')
      failed.unmount()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a restart that outlasts the settle window recovers to a retryable failure', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    jest.useFakeTimers()
    try {
      act(() => { useUpdateStore.setState({ update: withTarget('1.2.0'), panelOpen: true }) })
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<UpdatePanel />) })
      await act(async () => { renderer.root.findByProps({ 'data-testid': 'update-install' }).props.onClick() })
      expect(textOf(renderer.root.findByProps({ 'data-testid': 'update-install' }))).toBe('Restarting…')

      // The POST resolved, the socket never dropped, and the target is still
      // offered: the restart verb failed server-side. The panel must not lock.
      await act(async () => { jest.advanceTimersByTime(10_000) })
      expect(textOf(renderer.root.findByProps({ role: 'alert' }))).toContain('restart may have failed')
      expect(textOf(renderer.root.findByProps({ 'data-testid': 'update-install' }))).toBe('Update now')
      renderer.unmount()
    } finally {
      jest.useRealTimers()
      globalThis.fetch = originalFetch
    }
  })

  test('a reconnect onto the old build re-arms the settle window', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    jest.useFakeTimers()
    try {
      act(() => { useUpdateStore.setState({ update: withTarget('1.2.0'), panelOpen: true }) })
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<UpdatePanel />) })
      await act(async () => { renderer.root.findByProps({ 'data-testid': 'update-install' }).props.onClick() })

      // The socket drops and reconnects near the end of the first window; the
      // server it lands on still offers the target, so the re-armed window
      // must also expire into the recoverable failure.
      await act(async () => { jest.advanceTimersByTime(9_000) })
      act(() => { useSessionStore.setState({ connectionEpoch: 1 }) })
      expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
      await act(async () => { jest.advanceTimersByTime(9_000) })
      expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
      await act(async () => { jest.advanceTimersByTime(1_000) })
      expect(textOf(renderer.root.findByProps({ role: 'alert' }))).toContain('restart may have failed')
      renderer.unmount()
    } finally {
      jest.useRealTimers()
      globalThis.fetch = originalFetch
    }
  })

  test('the panel stays dismissible while restarting', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    try {
      act(() => { useUpdateStore.setState({ update: withTarget('1.2.0'), panelOpen: true }) })
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<UpdatePanel />) })
      await act(async () => { renderer.root.findByProps({ 'data-testid': 'update-install' }).props.onClick() })
      const close = renderer.root.findAllByType('button').find(b => textOf(b) === 'Close')!
      expect(close.props.disabled).toBeFalsy()
      act(() => { close.props.onClick() })
      expect(useUpdateStore.getState().panelOpen).toBe(false)
      renderer.unmount()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
