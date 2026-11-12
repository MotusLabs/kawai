// I9 (extract-agent-runtime design §8, task 6.1): Kawai and a packed-style
// consumer reach ONE driver implementation with equivalent policy behavior.
// - Export graph: the public package-name factories Kawai imports are the
//   very functions of the package source (no copied core), and every query
//   Kawai's production composition builds is the package's (its owned
//   spawner and resolved launch executable).
// - Equivalence: seed 0xA609, 128 cases. Each case drives the same scripted
//   CLI through Kawai's production Claude composition (createChatDriver) and
//   through a direct package consumer built from the public options Kawai
//   composes (default mode over all tools, waiting requests), varying the
//   tool, its input, the decision (allow, deny, a policy switch) and the
//   continuation (fresh or resumed). The SDK-facing facts must be equal: the
//   resume and permission mode handed to the SDK, the policy hook's answer,
//   the approval card, the native permission result and its resolution
//   (Kawai's events name the package's 'caller' attribution 'user').
// - Kawai's own host policy grants team tools silently: through Kawai a team
//   tool shows no card and gets the native result the package gives for an
//   allow attributed to 'team'.
// - Cleanup (batch B, sweep 7553f8ac A9): every driver stop and every
//   scripted prompt reader is one entry of the package's shared
//   ownedAggregate (helpers/ownedCleanup.ts), registered before the case
//   acts. A join runs every entry with allSettled, so a rejecting stop never
//   skips another; raw failures are reported, not discarded; a reader entry
//   waits for the reader, which the driver's own stop ends.
import { afterEach, describe, expect, test } from 'bun:test'
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeDriver as publicClaude } from '@motuslabs/agent-runtime/claude'
import { createCodexDriver as publicCodex } from '@motuslabs/agent-runtime/codex'
import type { AgentEvent, ClaudeAgentDriver } from '@motuslabs/agent-runtime'
import type { ChatEvent } from '../../shared/chat'
import { createChatDriver } from '../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../chat/provider/driver'
import { createClaudeDriver as sourceClaude, createClaudeDriverWith } from '../../../packages/agent-runtime/src/claude/driver'
import { createCodexDriver as sourceCodex } from '../../../packages/agent-runtime/src/codex/driver'
import { ownedAggregate, ownedOnce, type OwnedOnce } from '../../../packages/agent-runtime/__tests__/helpers/ownedCleanup'

type Adapter = ChatAgentDriver & { settled(): Promise<void> }

interface Script {
  options: Options
  push(message: Record<string, unknown>): void
  closed: boolean
}

/** One scripted CLI per spawn: the SDK options it was given, frames the test pushes. */
function scripted(scripts: Script[], sessionId: string) {
  return ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const queue: SDKMessage[] = []
    let wake: (() => void) | null = null
    const script: Script = {
      options,
      closed: false,
      push: (message) => {
        queue.push({ uuid: crypto.randomUUID(), session_id: sessionId, ...message } as unknown as SDKMessage)
        wake?.()
      },
    }
    scripts.push(script)
    const reader = (async () => {
      for await (const _ of prompt) void _
    })()
    // The driver's own stop (a sibling entry) ends the prompt; this entry waits for the reader.
    own(() => reader)
    const stream = (async function* () {
      while (!script.closed) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        while (queue.length > 0) yield queue.shift()!
      }
    })()
    return Object.assign(stream, {
      interrupt: () => Promise.resolve(),
      close: () => {
        script.closed = true
        wake?.()
      },
      initializationResult: () => Promise.resolve({}),
    }) as unknown as Query
  }
}

function lcg(seed: number) {
  let state = seed >>> 0
  return (n: number) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return (state >>> 16) % n
  }
}

async function until(probe: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
/** Kawai's event vocabulary for the package's attributions (claudeRuntimeViews.ts). */
const KAWAI_DECIDED_BY: Record<string, string> = { caller: 'user', policy: 'policy', timeout: 'timeout' }
const TOOLS = ['Bash', 'Write', 'Read', 'Edit', 'WebFetch', 'mcp__github__create_issue'] as const
const DECISIONS = ['allow', 'deny', 'policy'] as const
type Decision = (typeof DECISIONS)[number]

interface Facts {
  resume: unknown
  permissionMode: unknown
  hook: unknown
  card: { tool: unknown; input: unknown }
  result: PermissionResult | null
  resolved: { outcome: unknown; decidedBy: unknown }
}

interface Owned { run: () => Promise<unknown>; closed: OwnedOnce<unknown> }
const owned = ownedAggregate<Owned, unknown>({
  join: (entry) => entry.closed.run(entry.run),
  failures: (_entry, outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []),
  message: 'I9 cleanups failed',
})
/** Register one cleanup (a driver stop or a reader join) before the case acts on it. */
function own(run: () => Promise<unknown>): void {
  owned.add({ run, closed: ownedOnce<unknown>() })
}
afterEach(() => owned.join())

/** The SDK-facing facts of one case through a driver whose scripted CLI is `scripts[0]`. */
async function drive(
  scripts: Script[],
  cards: () => Array<{ requestId: string; tool: unknown; input: unknown }>,
  resolutions: () => Array<{ requestId: string; outcome: unknown; decidedBy: unknown }>,
  decide: (requestId: string) => void,
  tool: string,
  input: Record<string, unknown>,
  sessionId: string,
): Promise<Facts> {
  await until(() => scripts.length === 1)
  const script = scripts[0]!
  script.push({ type: 'system', subtype: 'init', model: 'claude-test', tools: [], slash_commands: [] })
  const hookMatcher = script.options.hooks?.PreToolUse?.[0]
  const hook = await hookMatcher!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'tu-1', session_id: sessionId, transcript_path: '', cwd: '/tmp' } as never, 'tu-1', { signal: new AbortController().signal })
  const pending = script.options.canUseTool!(tool, structuredClone(input), { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'sdk-req-1' } as never)
  await until(() => cards().length === 1)
  const card = cards()[0]!
  decide(card.requestId)
  const result = await pending
  await until(() => resolutions().length === 1)
  const resolved = resolutions()[0]!
  return {
    resume: script.options.resume,
    permissionMode: script.options.permissionMode,
    hook,
    card: { tool: card.tool, input: card.input },
    result,
    resolved: { outcome: resolved.outcome, decidedBy: resolved.decidedBy },
  }
}

async function kawaiCase(index: number, tool: string, input: Record<string, unknown>, decision: Decision, resume: string | null): Promise<Facts> {
  const scripts: Script[] = []
  const events: ChatEvent[] = []
  const sessionId = resume ?? `s-${index}`
  const driver = createChatDriver({
    runtime: 'claude',
    options: {
      sessionId: `chat-i9-${index}`,
      projectPath: '/tmp',
      queryFactory: scripted(scripts, sessionId) as never,
      onEvent: (event) => void events.push(event),
      onStatus: () => {},
      ...(resume ? { resumeSessionId: resume } : {}),
    },
  }) as Adapter
  own(async () => {
    driver.kill()
    await driver.settled()
  })
  driver.start()
  const facts = await drive(
    scripts,
    () => events.flatMap((e) => (e.type === 'approval_request' ? [{ requestId: e.requestId, tool: e.tool, input: e.input }] : [])),
    () => events.flatMap((e) => (e.type === 'request_resolved' ? [{ requestId: e.requestId, outcome: e.outcome, decidedBy: e.decidedBy }] : [])),
    (requestId) => {
      if (decision === 'policy') driver.onApprovalPolicyChanged('auto')
      else expect(driver.resolveApproval(requestId, decision)).toEqual({ ok: true })
    },
    tool,
    input,
    sessionId,
  )
  // Production composition: every query is the package's (owned spawner,
  // resolved launch executable), never a bare SDK option set.
  expect(scripts.length).toBeGreaterThan(0)
  for (const script of scripts) {
    expect(script.options.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(script.options.pathToClaudeCodeExecutable).toBe(process.execPath)
  }
  return facts
}

async function packageCase(index: number, tool: string, input: Record<string, unknown>, decision: Decision, resume: string | null): Promise<Facts> {
  const scripts: Script[] = []
  const events: AgentEvent[] = []
  const sessionId = resume ?? `s-${index}`
  const driver: ClaudeAgentDriver = createClaudeDriverWith(
    {
      logger: quiet,
      launch: { cwd: '/tmp', childEnv: {}, executablePath: process.execPath, homeDir: '/tmp', cacheDir: '/tmp', tempDir: '/tmp' },
      // The public options Kawai composes for every Claude spawn (claudeRuntimeLaunch.ts launchFields).
      permissions: { mode: 'default', enabledTools: 'all', disallowedTools: [] },
      unansweredRequests: 'wait',
      callbacks: { onEvent: (event) => void events.push(event) },
      ...(resume ? { resume: { runtime: 'claude' as const, runtimeSessionId: resume } } : {}),
    },
    { queryFactory: scripted(scripts, sessionId) },
  )
  own(() => driver.kill())
  void driver.start().catch(() => {})
  return drive(
    scripts,
    () => events.flatMap((e) => (e.type === 'approval_request' ? [{ requestId: e.requestId, tool: e.tool, input: e.input }] : [])),
    () => events.flatMap((e) => (e.type === 'request_resolved' ? [{ requestId: e.requestId, outcome: e.outcome, decidedBy: e.decidedBy }] : [])),
    (requestId) => expect(driver.resolveApproval(requestId, decision === 'deny' ? 'deny' : 'allow', decision === 'policy' ? { decidedBy: 'policy' } : {})).toEqual({ ok: true }),
    tool,
    input,
    sessionId,
  ).then((facts) => ({ ...facts, resolved: { ...facts.resolved, decidedBy: KAWAI_DECIDED_BY[String(facts.resolved.decidedBy)] } }))
}

/** One team-tool request through Kawai: the card it showed (none expected) and the native result. */
async function kawaiTeamTool(input: Record<string, unknown>) {
  const scripts: Script[] = []
  const events: ChatEvent[] = []
  const driver = createChatDriver({
    runtime: 'claude',
    options: { sessionId: 'chat-i9-team', projectPath: '/tmp', queryFactory: scripted(scripts, 's-team') as never, onEvent: (event) => void events.push(event), onStatus: () => {} },
  }) as Adapter
  own(async () => {
    driver.kill()
    await driver.settled()
  })
  driver.start()
  await until(() => scripts.length === 1)
  scripts[0]!.push({ type: 'system', subtype: 'init', model: 'claude-test', tools: [], slash_commands: [] })
  const result = await scripts[0]!.options.canUseTool!(TEAM_TOOL, structuredClone(input), { signal: new AbortController().signal, toolUseID: 'tu-team', requestId: 'sdk-req-team' } as never)
  return { cards: events.filter((e) => e.type === 'approval_request').length, result }
}

async function packageTeamTool(input: Record<string, unknown>) {
  const scripts: Script[] = []
  const events: AgentEvent[] = []
  const driver = createClaudeDriverWith(
    {
      logger: quiet,
      launch: { cwd: '/tmp', childEnv: {}, executablePath: process.execPath, homeDir: '/tmp', cacheDir: '/tmp', tempDir: '/tmp' },
      permissions: { mode: 'default', enabledTools: 'all', disallowedTools: [] },
      unansweredRequests: 'wait',
      callbacks: {
        onEvent: (event) => void events.push(event),
        // A host policy granting the request as Kawai's does.
        onRequest: (request) => void driver.resolveApproval(request.requestId, 'allow', { decidedBy: 'team' }),
      },
    },
    { queryFactory: scripted(scripts, 's-team') },
  )
  own(() => driver.kill())
  void driver.start().catch(() => {})
  await until(() => scripts.length === 1)
  scripts[0]!.push({ type: 'system', subtype: 'init', model: 'claude-test', tools: [], slash_commands: [] })
  return scripts[0]!.options.canUseTool!(TEAM_TOOL, structuredClone(input), { signal: new AbortController().signal, toolUseID: 'tu-team', requestId: 'sdk-req-team' } as never)
}

const TEAM_TOOL = 'mcp__kawai-team__send_message'

describe('I9: Kawai and a package consumer reach one driver implementation', () => {
  test('a team tool through Kawai is granted without a card, as the package grants it for a team host policy', async () => {
    const input = { to_kind: 'group', to_id: 'lead', body: 'status' }
    const kawai = await kawaiTeamTool(input)
    const direct = await packageTeamTool(input)
    expect(kawai.cards).toBe(0)
    expect(kawai.result).toStrictEqual(direct)
    expect(kawai.result).toStrictEqual({ behavior: 'allow', updatedInput: { to_kind: 'group', to_id: 'lead', body: 'status' } })
  })

  test('the public package-name factories are the package source functions', () => {
    expect(publicClaude).toBe(sourceClaude)
    expect(publicCodex).toBe(sourceCodex)
  })

  test('0xA609: 128 seeded cases give equal SDK-facing policy facts through Kawai and the package', async () => {
    const pick = lcg(0xa609)
    const seen = { tools: new Set<string>(), decisions: new Set<string>(), resumed: 0 }
    for (let index = 0; index < 128; index += 1) {
      const tool = TOOLS[pick(TOOLS.length)]!
      const input: Record<string, unknown> = Object.fromEntries(
        Array.from({ length: 1 + pick(3) }, (_, k) => [`arg${k}`, pick(2) ? `value-${pick(1000)}` : pick(1000)]),
      )
      const decision = DECISIONS[pick(DECISIONS.length)]!
      const resume = pick(2) ? `resume-${index}` : null
      const context = `case ${index}: ${tool} ${decision} ${resume ?? 'fresh'}`
      const kawai = await kawaiCase(index, tool, input, decision, resume)
      const direct = await packageCase(index, tool, input, decision, resume)
      expect([context, kawai]).toStrictEqual([context, direct])
      // The card shows, and an allow echoes, the exact original input.
      expect([context, kawai.card.input]).toStrictEqual([context, input])
      await owned.join()
      seen.tools.add(tool)
      seen.decisions.add(decision)
      if (resume) seen.resumed += 1
    }
    // The seed covers every tool and decision, fresh and resumed.
    expect([seen.tools.size, seen.decisions.size, seen.resumed > 0 && seen.resumed < 128]).toEqual([TOOLS.length, DECISIONS.length, true])
  }, 120_000)
})
