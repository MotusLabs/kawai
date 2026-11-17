// The New Session dialog's agent option is provider-neutral: it reads exactly
// `AI agent` for every runtime, reopen defaults still follow the entry point,
// and the opening profile instructions say so (new-session-ai-agent-label,
// UI1–UI3, DOC1, properties I1/I2 of that change's design).
// @reads: docs/claude-session-profiles.md
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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
  const textarea = { removeAttribute: () => {}, focus: () => {} }
  globalAny.document = { querySelector: () => textarea } as unknown as Document
  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
  } as unknown as Window & typeof globalThis
}

/** Both runtimes under one catalog; resolution itself is the server's job. */
const CLAUDE_PROFILES = [
  { id: 'default', label: 'Default', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
  { id: 'opus', label: 'Claude Opus', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
]
const CODEX_PROFILES = [
  { id: 'codex-sol', label: 'Codex Sol', providerId: 'codex', providerLabel: 'Codex', runtime: 'codex' },
  { id: 'codex-luna', label: 'Codex Luna', providerId: 'codex', providerLabel: 'Codex', runtime: 'codex' },
]
const CATALOG = [...CLAUDE_PROFILES, ...CODEX_PROFILES]

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/**
 * Fetch double that distinguishes groups from profiles and asserts the
 * requested project path on every call: a request for any other path is a
 * harness bug, not a catalog answer, so it throws instead of serving one.
 */
function installCatalogs(expectedPath: string, profiles: typeof CATALOG) {
  const requested: string[] = []
  const profilesUrl = `/api/chat/profiles?projectPath=${encodeURIComponent(expectedPath)}`
  const groupsUrl = `/api/chat/groups?projectPath=${encodeURIComponent(expectedPath)}`
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    requested.push(url)
    if (url === profilesUrl) return Response.json({ profiles, errors: [] })
    if (url === groupsUrl) return Response.json({ groups: [], errors: [] })
    throw new Error(`unexpected catalog request: ${url}`)
  }) as unknown as typeof fetch
  return requested
}

/** The creation callback's arguments, captured under their prop names. */
type CreatedCall = {
  projectPath: string
  name?: string
  command?: string
  host?: string
  autoStartChange?: string
  autoStartAgent?: string
  kind?: 'terminal' | 'chat'
  claudeProfileId?: string
  approvalPolicy?: 'auto' | 'manual'
  groupId?: string
}

interface DialogHarness {
  renderer: TestRenderer.ReactTestRenderer
  requested: string[]
  created: CreatedCall[]
  kind: () => string
  agentOptions: () => Array<{ value: string; label: string }>
  counts: () => { profile: number; firstPrompt: number }
  selectProfile: (id: string) => void
  submit: () => void
  reopen: (next?: Record<string, unknown>) => Promise<void>
  unmount: () => void
}

/**
 * Drive the real modal through the opens the spec cares about: `reopen`
 * closes and opens again the way App does — `initial*` props change in the
 * same batched update as `isOpen` — so the preselected kind is always the
 * current entry point's, never a leftover from the previous open.
 */
async function mountDialog(
  entry: Record<string, unknown> = {},
  profiles: typeof CATALOG = CATALOG
): Promise<DialogHarness> {
  setupDom()
  const requested = installCatalogs('/base', profiles)
  const created: CreatedCall[] = []
  const form = (isOpen: boolean, props: Record<string, unknown>) => (
    <NewSessionModal
      isOpen={isOpen}
      onClose={() => {}}
      onCreate={(projectPath, name, command, host, autoStartChange, autoStartAgent, kind, claudeProfileId, approvalPolicy, groupId) => {
        created.push({ projectPath, name, command, host, autoStartChange, autoStartAgent, kind, claudeProfileId, approvalPolicy, groupId })
      }}
      defaultProjectDir="/base"
      commandPresets={DEFAULT_PRESETS}
      defaultPresetId="claude"
      {...props}
    />
  )

  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(form(true, entry))
    await settle()
  })

  const kindSelect = () => renderer.root.findByProps({ 'aria-label': 'Session kind' })
  return {
    renderer,
    requested,
    created,
    kind: () => kindSelect().props.value as string,
    agentOptions: () =>
      kindSelect()
        .findAllByType('option')
        .map(option => ({ value: option.props.value, label: option.props.children })),
    counts: () => ({
      profile: renderer.root.findAllByProps({ 'aria-label': 'Profile' }).length,
      firstPrompt: renderer.root.findAllByProps({ 'data-testid': 'start-with-select' }).length,
    }),
    selectProfile: (id: string) => {
      act(() => {
        renderer.root.findByProps({ 'aria-label': 'Profile' }).props.onChange({ target: { value: id } })
      })
    },
    submit: () => {
      act(() => {
        renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
      })
    },
    reopen: async (next: Record<string, unknown> = {}) => {
      // Two separate act blocks: batched together, React would render the
      // close and the open as one update, never see the isOpen transition,
      // and skip the render-phase re-init the defaults ride on.
      act(() => {
        renderer.update(form(false, entry))
      })
      await act(async () => {
        renderer.update(form(true, next))
        await settle()
      })
    },
    unmount: () => {
      act(() => {
        renderer.unmount()
      })
    },
  }
}

// Deterministic PRNG so the generated plans are reproducible (design: seed
// 0xA16E). Both properties consume the same plan shape: 24 rounds, each a
// permutation of the two-runtime catalog plus a sequence of entry-point opens
// with a profile selection after every agent-kind open.
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface PlannedOpen {
  changeSection: boolean
  selectedProfileId?: string
}

interface PlannedRound {
  catalog: typeof CATALOG
  opens: PlannedOpen[]
}

function generatedRounds(seed: number): PlannedRound[] {
  const rng = mulberry32(seed)
  const rounds: PlannedRound[] = []
  for (let round = 0; round < 24; round++) {
    // Realistic catalogs keep each provider's models contiguous — the picker
    // groups by runs of one providerId — so permute whole provider blocks and
    // vary whether a block offers its second profile; never interleave.
    const claude = rng() < 0.5 ? CLAUDE_PROFILES : CLAUDE_PROFILES.slice(0, 1)
    const codex = rng() < 0.5 ? CODEX_PROFILES : CODEX_PROFILES.slice(0, 1)
    const catalog = rng() < 0.5 ? [...claude, ...codex] : [...codex, ...claude]
    const opens: PlannedOpen[] = []
    const openCount = 1 + Math.floor(rng() * 3)
    for (let open = 0; open < openCount; open++) {
      // Every round starts on a generic open with a profile selection, so
      // both properties always exercise the submission path; further opens
      // in the round are random entry points.
      const changeSection = open > 0 && rng() < 0.5
      const selectedProfileId = changeSection
        ? undefined
        : catalog[Math.floor(rng() * catalog.length)]!.id
      opens.push({ changeSection, selectedProfileId })
    }
    rounds.push({ catalog, opens })
  }
  return rounds
}

/** The chat option's displayed text, whatever it currently is. */
function agentOptionLabel(harness: DialogHarness): string {
  const option = harness.agentOptions().find(option => option.value === 'chat')
  if (option === undefined) throw new Error('the chat option is gone from the Session kind selector')
  return option.label
}

describe('NewSessionModal agent label (new-session-ai-agent-label)', () => {
  // @covers: claude-session-profiles › The New Session dialog names agent sessions independently of runtime › Shared agent session choice
  test('UI1: agent option has provider-neutral text and preserves its value', async () => {
    const dialog = await mountDialog()
    // Exactly two options, exact labels, exact values: kills the old `Chat`,
    // the older `Claude chat`, a renamed value, and any extra option.
    expect(dialog.agentOptions()).toEqual([
      { value: 'terminal', label: 'Terminal' },
      { value: 'chat', label: 'AI agent' },
    ])
    expect(dialog.counts().profile).toBe(1)
    // The double asserted every request's path; both catalogs answered for
    // the initialized path and nothing else was requested.
    expect(dialog.requested.filter(url => url.startsWith('/api/chat/profiles')))
      .toEqual(['/api/chat/profiles?projectPath=%2Fbase'])
    expect(dialog.requested.filter(url => url.startsWith('/api/chat/groups')))
      .toEqual(['/api/chat/groups?projectPath=%2Fbase'])
    dialog.unmount()
  })

  // @covers: claude-session-profiles › The New Session dialog names agent sessions independently of runtime › Existing entry-point defaults
  test('UI2: reopen defaults follow the entry point', async () => {
    const dialog = await mountDialog()
    expect(dialog.kind()).toBe('chat')
    expect(dialog.counts().profile).toBe(1)

    await dialog.reopen({ initialAutoStartChange: 'add-auth' })
    expect(dialog.kind()).toBe('terminal')
    expect(dialog.counts()).toEqual({ profile: 0, firstPrompt: 1 })
    // The selector still offers the same pair on a Terminal open.
    expect(dialog.agentOptions()).toEqual([
      { value: 'terminal', label: 'Terminal' },
      { value: 'chat', label: 'AI agent' },
    ])

    await dialog.reopen()
    expect(dialog.kind()).toBe('chat')
    expect(dialog.counts()).toEqual({ profile: 1, firstPrompt: 0 })
    expect(agentOptionLabel(dialog)).toBe('AI agent')
    dialog.unmount()
  })

  // @covers: claude-session-profiles › The New Session dialog names agent sessions independently of runtime › Claude and Codex share the label
  test('UI3: both runtimes keep the label and selected profile', async () => {
    const dialog = await mountDialog()
    dialog.selectProfile('opus')
    expect(agentOptionLabel(dialog)).toBe('AI agent')
    dialog.submit()
    expect(dialog.created).toEqual([
      { projectPath: '/base', kind: 'chat', claudeProfileId: 'opus', approvalPolicy: 'manual' },
    ])

    // A fresh open resets the profile; picking a Codex one changes nothing
    // about the label or the payload's kind.
    await dialog.reopen()
    dialog.selectProfile('codex-sol')
    expect(agentOptionLabel(dialog)).toBe('AI agent')
    dialog.submit()
    expect(dialog.created).toEqual([
      { projectPath: '/base', kind: 'chat', claudeProfileId: 'opus', approvalPolicy: 'manual' },
      { projectPath: '/base', kind: 'chat', claudeProfileId: 'codex-sol', approvalPolicy: 'manual' },
    ])
    dialog.unmount()
  })

  test('DOC1: opening profile instructions name AI agent', () => {
    const doc = readFileSync(new URL('../../../docs/claude-session-profiles.md', import.meta.url), 'utf8')
    const lines = doc.split('\n')
    const start = lines.findIndex(line => line.trim() !== '' && !line.startsWith('#'))
    const end = lines.findIndex((line, index) => index >= start && line.trim() === '')
    const opening = lines.slice(start, end).join('\n')
    expect(opening).toContain('choose **AI agent**')
    expect(opening).toContain('**Profile**')
    // The removed label must not direct anyone anywhere anymore.
    expect(opening).not.toContain('Claude chat')
  })

  test('I1: rendered label stays constant and defaults follow every open', async () => {
    // One real modal, 24 seeded rounds of reopens over both entry points with
    // a Claude or Codex profile selected after every agent-kind open.
    const dialog = await mountDialog()
    for (const round of generatedRounds(0xa16e)) {
      for (const planned of round.opens) {
        await dialog.reopen(planned.changeSection ? { initialAutoStartChange: 'add-auth' } : {})
        expect(dialog.kind()).toBe(planned.changeSection ? 'terminal' : 'chat')
        expect(dialog.agentOptions()).toEqual([
          { value: 'terminal', label: 'Terminal' },
          { value: 'chat', label: 'AI agent' },
        ])
        if (planned.selectedProfileId !== undefined) {
          dialog.selectProfile(planned.selectedProfileId)
          expect(dialog.kind()).toBe('chat')
          expect(agentOptionLabel(dialog)).toBe('AI agent')
        }
      }
    }
    dialog.unmount()
  })

  test('I2: the callback keeps kind chat and the exact selected profile id', async () => {
    // The same seeded permutations: every selection lands in the callback
    // verbatim, the kind stays chat, and the label never moved.
    for (const round of generatedRounds(0xa16e)) {
      const dialog = await mountDialog({}, round.catalog)
      const planned = round.opens.find(open => open.selectedProfileId !== undefined)
      expect(planned).toBeDefined()
      const selectedProfileId = planned!.selectedProfileId!
      dialog.selectProfile(selectedProfileId)
      expect(agentOptionLabel(dialog)).toBe('AI agent')
      dialog.submit()
      expect(dialog.created).toEqual([
        { projectPath: '/base', kind: 'chat', claudeProfileId: selectedProfileId, approvalPolicy: 'manual' },
      ])
      dialog.unmount()
    }
  })
})




