// Direct unit tests for PasteChannel (terminal/pasteChannel.ts): the Finder
// paste path through the per-request resolver, pinning the review finding
// that ANY failure in the pasteboard lookup-and-deliver falls through to the
// text paste (the original inline block guarded the whole sequence).
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PasteChannel, type PasteChannelDeps } from '../terminal/pasteChannel'

const globalAny = globalThis as unknown as {
  window?: unknown
  navigator?: Navigator
}

const originalWindow = globalAny.window
const originalNavigator = globalAny.navigator

function createChannel(overrides: Partial<PasteChannelDeps> = {}) {
  const sends: Array<Record<string, unknown>> = []
  const errors: string[] = []
  const deps: PasteChannelDeps = {
    send: (message) => { sends.push(message as Record<string, unknown>) },
    getReadySession: () => 'session-1',
    getAttachedSession: () => 'session-1',
    getAgentType: () => undefined,
    getOnPasteFiles: () => undefined,
    onPasteError: (message) => { errors.push(message) },
    canReadHostClipboard: () => true,
    isIOS: false,
    exitCopyMode: () => {},
    ...overrides,
  }
  return { channel: new PasteChannel(deps), sends, errors }
}

/** Fulfil a pending paste request as the capture-phase listener would. */
function deliverPaste(channel: PasteChannel, clipboardData: unknown): void {
  channel.handlePasteEvent({
    preventDefault: () => {},
    stopPropagation: () => {},
    clipboardData,
  } as unknown as ClipboardEvent)
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  globalAny.navigator = { platform: 'MacIntel' } as Navigator
  globalAny.window = {
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.navigator = originalNavigator
})

describe('PasteChannel Finder paste', () => {
  test('a malformed pasteboard path throws and falls through to the text paste', async () => {
    const originalFetch = globalThis.fetch
    // Truthy non-string path: sanitizeImagePath(123) throws inside the block.
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ path: 123, isImage: false }),
    })) as unknown as typeof fetch

    const { channel, sends, errors } = createChannel()
    try {
      channel.handlePasteKey()
      deliverPaste(channel, {
        files: [],
        items: [],
        types: ['Files'],
        getData: () => 'report.txt',
      })

      await flushMicrotasks()
      // The Finder lookup failed mid-deliver: the text paste still lands.
      expect(sends).toEqual([{ type: 'terminal-paste', sessionId: 'session-1', data: 'report.txt' }])
      expect(errors).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a well-formed non-image path is sent raw without the text paste', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ path: '/Users/x/report.txt', isImage: false }),
    })) as unknown as typeof fetch

    const { channel, sends } = createChannel()
    try {
      channel.handlePasteKey()
      deliverPaste(channel, {
        files: [],
        items: [],
        types: ['Files'],
        getData: () => 'report.txt',
      })

      await flushMicrotasks()
      expect(sends).toEqual([{
        type: 'terminal-input',
        sessionId: 'session-1',
        data: '/Users/x/report.txt',
      }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
