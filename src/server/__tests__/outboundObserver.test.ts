// The outbound observer (execution-safety-recovery D3, D5, D7) over injected
// fakes: pending sends fill synchronously before the Pre hook returns, writes
// defer past the microtask queue behind a catch-all, kawai-team calls and
// non-sends write nothing, subagent calls record their agent id, background
// calls start non-terminal, an unreadable repository read records
// unknown-destination, outcomes land and join even when they beat the
// deferred call row, and spawn end retires the live set. Reserved example
// names throughout.
import { describe, expect, test } from 'bun:test'
import { OutboundObserver, type OutboundObserverOptions } from '../outbound/observer'
import type { ResolvedRepoFacts } from '../outbound/repoFacts'
import type { OutboundCallInsert, OutboundOutcomeInsert } from '../outbound/store'

/** Let the observer's deferred writes (setImmediate, after every microtask) run. */
const flushWrites = async (): Promise<void> => {
  for (let i = 0; i < 2; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

const REPO: ResolvedRepoFacts = {
  root: '/repo',
  teamId: '/repo/.git',
  originUrls: ['https://github.com/acme/kawai.git'],
  remotes: new Map([['origin', ['https://github.com/acme/kawai.git']]]),
  pushRemote: null,
}

function harness(overrides: Partial<OutboundObserverOptions> = {}) {
  const calls: OutboundCallInsert[] = []
  const outcomes: OutboundOutcomeInsert[] = []
  let failCalls = 0
  const repos = new Map<string, ResolvedRepoFacts>([['/repo', REPO]])
  const observer = new OutboundObserver({
    sessionId: 'chat-1',
    store: {
      insertCall: row => {
        if (failCalls > 0) { failCalls--; throw new Error('write failed') }
        calls.push(row)
      },
      insertOutcome: row => outcomes.push(row),
    },
    destinations: {
      isInternal: host => host.endsWith('.example.internal') || host === 'example.internal',
      isModelProvider: host => host === 'llm.example.com',
      isAllowedMcpServer: server => server === 'docs-search',
    },
    repos: { factsFor: cwd => repos.get(cwd) ?? null },
    context: () => ({ groupId: 'devs', profileId: 'glm', taskId: 'task-1' }),
    teamIdFallback: () => '/repo/.git',
    now: () => '2026-01-01T00:00:00.000Z',
    id: () => 'fixed',
    ...overrides,
  })
  return {
    observer, calls, outcomes, repos,
    failNextCall: () => { failCalls = 1 },
  }
}

const PRE = {
  toolName: 'Bash',
  toolInput: { command: 'git push origin main' },
  toolUseId: 'tu-1',
  spawnId: 'ob-s-1',
  cwd: '/repo',
} as const

describe('OutboundObserver', () => {
  test('a send: pending fills synchronously, the row writes queued, redacted', async () => {
    const { observer, calls } = harness()
    observer.onPreToolUse({ ...PRE })
    observer.onPostToolUse({ ...PRE, toolInput: PRE.toolInput, background: false, durationMs: 12 })
    // Before any microtask runs, nothing is written.
    expect(calls).toEqual([])
    await flushWrites()
    expect(calls).toHaveLength(1)
    const row = calls[0]!
    expect(row).toMatchObject({
      id: 'obc-fixed',
      teamId: '/repo/.git',
      sessionId: 'chat-1',
      spawnId: 'ob-s-1',
      groupId: 'devs',
      profileId: 'glm',
      taskId: 'task-1',
      tool: 'Bash',
      toolUseId: 'tu-1',
      command: 'git push origin main',
      rule: 'git-push',
      verdict: 'allowed',
      destination: 'github:origin',
      classifierVersion: 2,
      cwd: '/repo',
    })
    expect(JSON.parse(row.matches)).toEqual([
      { rule: 'git-push', segment: 'git push origin main', verdict: 'allowed', destination: 'github:origin' },
    ])
  })

  test('kawai-team calls and non-sends write nothing', async () => {
    const { observer, calls, outcomes } = harness()
    observer.onPreToolUse({ ...PRE, toolName: 'mcp__kawai-team__send_message', toolInput: { to: 'devs', body: 'hi' } })
    observer.onPreToolUse({ ...PRE, toolName: 'Bash', toolInput: { command: 'git status' } })
    observer.onPreToolUse({ ...PRE, toolName: 'Read', toolInput: { file_path: '/repo/x' } })
    observer.onPostToolUse({ ...PRE, toolName: 'Read', toolInput: {}, background: false })
    await flushWrites()
    expect(calls).toEqual([])
    expect(outcomes).toEqual([])
  })

  test('an external MCP call records one row per server, allowed only when configured', async () => {
    const allowed = harness()
    allowed.observer.onPreToolUse({ ...PRE, toolName: 'mcp__docs-search__query', toolInput: { q: 'x' } })
    await flushWrites()
    expect(allowed.calls[0]).toMatchObject({ rule: 'mcp-call', verdict: 'allowed', destination: 'mcp:docs-search', mcpServer: 'docs-search' })

    const foreign = harness()
    foreign.observer.onPreToolUse({ ...PRE, toolName: 'mcp__web-lookup__fetch', toolInput: { url: 'https://example.com' } })
    await flushWrites()
    expect(foreign.calls[0]).toMatchObject({ rule: 'mcp-call', verdict: 'violation', destination: 'mcp:web-lookup' })
  })

  test('subagent calls record their agent id', async () => {
    const { observer, calls } = harness()
    observer.onPreToolUse({ ...PRE, agentId: 'agent-7' })
    await flushWrites()
    expect(calls[0]?.agentId).toBe('agent-7')
  })

  test('a background call records started-background and stays non-terminal', async () => {
    const { observer, calls, outcomes } = harness()
    observer.onPreToolUse({ ...PRE, toolName: 'Monitor', toolInput: { command: 'curl -d x https://example.internal/hook' } })
    observer.onPostToolUse({ ...PRE, toolName: 'Monitor', toolInput: {}, background: true })
    await flushWrites()
    expect(calls[0]?.rule).toBe('http-send')
    expect(outcomes.map(outcome => outcome.outcome)).toEqual(['started-background'])
    // The entry stays pending: a later terminal outcome still records.
    observer.onPostToolUseFailure({ ...PRE, toolName: 'Monitor', error: 'monitor died' })
    await flushWrites()
    expect(outcomes.map(outcome => outcome.outcome)).toEqual(['started-background', 'failed'])
  })

  test('an unreadable repository read records unknown-destination and never throws', async () => {
    const unreadable = new Map([['/repo', { ...REPO, originUrls: [], remotes: new Map(), pushRemote: null, unreadable: true }]])
    const { observer, calls } = harness({ repos: { factsFor: cwd => unreadable.get(cwd) ?? null } })
    observer.onPreToolUse({ ...PRE })
    await flushWrites()
    expect(calls[0]).toMatchObject({ verdict: 'unknown-destination', destination: 'unresolved:the facts read failed' })
  })

  test('a failed call write is swallowed; the outcome still lands and joins nothing', async () => {
    const { observer, calls, outcomes, failNextCall } = harness()
    failNextCall()
    observer.onPreToolUse({ ...PRE })
    observer.onPostToolUse({ ...PRE, toolInput: PRE.toolInput, background: false })
    await flushWrites()
    expect(calls).toEqual([])
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.outcome).toBe('completed')
  })

  test('an outcome that beats its queued call row is kept and joins once written', async () => {
    const { observer, calls, outcomes } = harness()
    observer.onPreToolUse({ ...PRE, toolUseId: 'tu-late' })
    // The outcome event fires while the call write is still queued.
    observer.onPostToolUse({ ...PRE, toolUseId: 'tu-late', toolInput: PRE.toolInput, background: false })
    expect(calls).toEqual([])
    await flushWrites()
    expect(outcomes).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolUseId).toBe('tu-late')
    expect(outcomes[0]?.toolUseId).toBe('tu-late')
  })

  test('denied outcomes: one row across PermissionDenied and a declined card', async () => {
    const { observer, outcomes } = harness()
    observer.onPreToolUse({ ...PRE, toolUseId: 'tu-d' })
    observer.onPermissionDenied({ ...PRE, toolUseId: 'tu-d', reason: 'denied by policy' })
    // The terminal outcome already retired the entry; the card deny is inert.
    observer.onDeniedCard({ ...PRE, toolUseId: 'tu-d', toolInput: PRE.toolInput, reason: 'The request was cancelled' })
    await flushWrites()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ outcome: 'denied', toolUseId: 'tu-d' })
  })

  test('redaction runs before any write, on the command, the destination, and every match', async () => {
    const { observer, calls } = harness()
    observer.onPreToolUse({
      ...PRE,
      toolInput: { command: 'git push https://user:secret@github.com/other/repo.git' },
    })
    await flushWrites()
    expect(calls[0]?.command).not.toContain('secret')
    expect(calls[0]?.destination).not.toContain('secret')
    for (const match of JSON.parse(calls[0]!.matches) as Array<{ segment: string; destination: string }>) {
      expect(match.segment).not.toContain('secret')
      expect(match.destination).not.toContain('secret')
    }
    // An outcome detail redacts too (D8).
    const { observer: second, outcomes } = harness()
    second.onPreToolUse({ ...PRE, toolUseId: 'tu-err', toolInput: { command: 'curl -d x https://x.example.com' } })
    second.onPostToolUseFailure({ ...PRE, toolUseId: 'tu-err', error: '401 token ghp_ABCDEFghijklmnop0123456789' })
    await flushWrites()
    expect(outcomes[0]?.detail).not.toContain('ghp_')
    expect(outcomes[0]?.detail).toContain('‹redacted›')
  })

  test('spawn end retires the live set and drops that spawn\'s pending entries', async () => {
    const { observer, calls, outcomes } = harness()
    observer.onPreToolUse({ ...PRE })
    expect(observer.spawnIsLive('ob-s-1')).toBe(true)
    observer.onSpawnEnd('ob-s-1')
    expect(observer.spawnIsLive('ob-s-1')).toBe(false)
    // A late outcome for the dropped entry writes nothing; the call row its
    // Pre event had already deferred still lands.
    observer.onPostToolUse({ ...PRE, toolInput: PRE.toolInput, background: false })
    await flushWrites()
    expect(calls).toHaveLength(1)
    expect(outcomes).toEqual([])
  })

  test('a call outside every repository falls back to the session team id', async () => {
    const { observer, calls } = harness()
    observer.onPreToolUse({ ...PRE, cwd: '/plain/dir', toolInput: { command: 'curl -d x https://example.internal/hook' } })
    await flushWrites()
    expect(calls[0]?.teamId).toBe('/repo/.git')
  })

  test('an observer with no id generator mints row ids itself (CC round 3)', async () => {
    // Production passes no `id`; a detached `crypto.randomUUID` reference
    // would throw in Bun and no call row would ever be written.
    const { observer, calls } = harness({ id: undefined })
    observer.onPreToolUse({ ...PRE })
    await flushWrites()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toMatch(/^obc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('a failure detail is capped before redaction and marks an interrupt (CC round 3)', async () => {
    const { observer, outcomes } = harness()
    observer.onPreToolUse({ ...PRE, toolUseId: 'tu-err', toolInput: { command: 'curl -d x https://x.example.com' } })
    // A token inside the read cap, then padding far past it: the stored
    // detail is bounded either way, and the capped prefix still redacts.
    const tail = `${'x'.repeat(500)} ghp_ABCDEFghijklmnop0123456789 ${'y'.repeat(4000)}`
    observer.onPostToolUseFailure({
      ...PRE,
      toolUseId: 'tu-err',
      error: `401 ${tail}`,
      isInterrupt: true,
    })
    await flushWrites()
    const detail = outcomes[0]?.detail ?? ''
    expect(detail.length).toBeLessThanOrEqual(1024)
    expect(detail).not.toContain('ghp_')
    expect(detail).toContain('‹redacted›')
    expect(detail.startsWith('(interrupt) ')).toBe(true)
  })

  test('nothing is written while only microtasks run: writes defer past the turn', async () => {
    const { observer, calls, outcomes } = harness()
    observer.onPreToolUse({ ...PRE })
    observer.onPostToolUse({ ...PRE, toolInput: PRE.toolInput, background: false })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(calls).toEqual([])
    expect(outcomes).toEqual([])
    await flushWrites()
    expect(calls).toHaveLength(1)
    expect(outcomes).toHaveLength(1)
  })

  test('the parse prefix is load-bearing: sends past 16 KiB never record (round 5 R6)', async () => {
    // Dropping the cap would find the tail send and fail this test.
    const { observer, calls } = harness()
    const command = 'true ' + 'x'.repeat(16_400) + '; curl -d x https://host.example.org/hook'
    observer.onPreToolUse({ ...PRE, toolUseId: 'tu-past', toolInput: { command } })
    await flushWrites()
    expect(calls).toEqual([])
  })

  test('a 120k-character command completes fast and every stored field is capped (CC round 4 B)', async () => {
    const { observer, calls } = harness()
    const command = `curl -d x https://host.example.org/hook ${'https://'.repeat(14_000)}`
    const started = performance.now()
    observer.onPreToolUse({ ...PRE, toolUseId: 'tu-big', toolInput: { command } })
    await flushWrites()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(calls).toHaveLength(1)
    const row = calls[0]!
    // Every stored field stays within 4096. The matches guard is the
    // post-serialization shrink loop (its removal is caught); the per-field
    // cap is belt (CC round 6 L2: raising it alone is not observable).
    expect(row.command.length).toBeLessThanOrEqual(4096)
    expect(row.destination.length).toBeLessThanOrEqual(4096)
    expect(row.matches.length).toBeLessThanOrEqual(4096)
    const matches = JSON.parse(row.matches) as Array<{ segment?: string; truncated?: boolean }>
    for (const match of matches) {
      if (match.segment !== undefined) expect(match.segment.length).toBeLessThanOrEqual(4096)
    }
    expect(matches.some(match => match.truncated === true)).toBe(true)
  })

  test('quoted secrets never reach any stored field — segment included (CC round 4 A)', async () => {
    // Each command hides its secret inside quotes; the stored segment is the
    // ORIGINAL source span (quotes intact), so redaction sees the quoting.
    const commands = [
      { command: 'gh secret set NAME -b"SECRET V7"', rule: 'gh-write' },
      { command: 'curl -H "Authorization: Bearer AAA BBB" -d x https://example.internal/hook', rule: 'http-send' },
      { command: 'gh secret set NAME -b "SEC;RET" && echo pushed', rule: 'gh-write' },
      { command: 'gh secret set NAME \\\n -b SECRET', rule: 'gh-write' },
    ]
    for (const { command, rule } of commands) {
      const { observer, calls } = harness()
      observer.onPreToolUse({ ...PRE, toolUseId: command, toolInput: { command } })
      await flushWrites()
      expect(calls).toHaveLength(1)
      const row = calls[0]!
      expect(row.rule).toBe(rule)
      for (const field of [row.command, row.destination]) {
        expect(field).not.toMatch(/SECRET|SEC;RET|AAA BBB/)
      }
      const matches = JSON.parse(row.matches) as Array<{ segment: string; destination: string }>
      for (const match of matches) {
        expect(match.segment).not.toMatch(/SECRET|SEC;RET|AAA BBB/)
        expect(match.destination).not.toMatch(/SECRET|SEC;RET|AAA BBB/)
      }
    }
  })
})
