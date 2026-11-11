// @reads: packages/agent-runtime/__tests__/fixtures/**
// Kawai's production Codex composition (extract-agent-runtime task 6.1, the
// first default-owned path): createChatDriver → codexRuntime.ts → the public
// @motuslabs/agent-runtime/codex factory → the package's fake app-server as a
// real child over stdio. Expected values come from the inputs this test
// supplies (texts, the live effort, the home) and the fake's own records
// (received.jsonl, envs.jsonl, pids), never from the adapter:
// - a send is one Kawai turn with Kawai's event identity, the thread id is
//   reported once, the spawn report carries the launch, the wire recorder
//   sees the protocol lines, and the app-server heard the package's client
//   (an in-tree driver in its place fails that value);
// - the effort Kawai read when it accepted a send rides on that send's
//   turn/start even when the live value changes before readiness, on the
//   same process (R2 timing, note-90c5b1dd);
// - manual approvals show Kawai's card and resolve as the user's; auto grants
//   with no card, decided by policy;
// - a mid-turn exit reports Kawai's message with the code and ends the
//   process; the next send respawns on a new process resuming the thread;
// - an app-server that cannot start reports Kawai's start error; a refused
//   thread start on a live process is over, and a later start respawns;
// - a resume onto a moved rollout reports the new path (R3 onThreadOpened)
//   and no new session id;
// - a rejected kill counts as quiescence only when its causes are exactly the
//   exits already reported (the package's own stop of a crashed process);
// - native skills (A9/V7): Kawai's command state lists the app-server's own
//   catalog, and a human send's turn/start carries its text then each whole
//   `/name` skill once, as the fake's skills.json named them;
// - R9 codexSkills (source S1): a peer delivery's and a question answer's
//   turn carries its text alone, even naming a catalog skill, and a following
//   human send carries the skill again; an answer steering a running turn asks
//   the package for 'none' too (recorded through the same-core create seam).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import type { CodexDriverOptions, SubmitOptions } from '@motuslabs/agent-runtime'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { createCodexChatDriver, type CreateCodexRuntime } from '../chat/provider/codexRuntime'
import type { CodexSessionDriverOptions } from '../chat/codex/codexThread'
import { formatEnvelope } from '../team/envelope'
import { exitCause, quiesced } from '../chat/provider/codexRuntimeSupport'
import type { ChatAgentDriver, ChatSpawnInfo } from '../chat/provider/driver'
import { codexRoot, sent, type CodexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'

type Adapter = ChatAgentDriver & { settled(): Promise<void> }
const live: Adapter[] = []
afterEach(async () => {
  for (const driver of live.splice(0)) {
    driver.kill()
    await driver.settled()
  }
})

function harness(root: CodexRoot, extra: { effort?: () => string | undefined; policy?: () => 'manual' | 'auto'; executable?: string; env?: Record<string, string>; resume?: string; create?: CreateCodexRuntime } = {}) {
  const transcripts: string[] = []
  const events: ChatEvent[] = []
  const statuses: string[] = []
  const sessions: string[] = []
  const spawns: ChatSpawnInfo[] = []
  const wire: Array<[string, string]> = []
  let ended = 0
  const options = {
    sessionId: 'chat-codex-adapter',
    projectPath: join(root.root, 'work'),
    executable: extra.executable ?? root.wrapper,
    codexHome: root.home,
    network: true,
    serverEnv: { PATH: process.env.PATH ?? '', HOME: root.root, ...extra.env },
    withheldCredentials: () => new Set(),
    wire: { record: (dir, raw) => void wire.push([dir, raw]) },
    ...(extra.effort ? { getEffort: extra.effort as never } : {}),
    ...(extra.policy ? { getApprovalPolicy: extra.policy } : {}),
    onEvent: (event) => void events.push(event),
    onStatus: (status) => void statuses.push(status),
    onSdkSessionId: (id) => void sessions.push(id),
    onTranscriptPath: (path) => void transcripts.push(path),
    ...(extra.resume ? { resumeThreadId: extra.resume } : {}),
    onSpawn: (info) => void spawns.push(info),
    onProcessEnd: () => void ended++,
  } satisfies CodexSessionDriverOptions
  // The same-core create seam only records what Kawai asked the package factory for.
  const driver = (extra.create ? createCodexChatDriver(options, extra.create) : createChatDriver({ runtime: 'codex', options })) as Adapter
  live.push(driver)
  return { driver, events, statuses, sessions, spawns, wire, transcripts, ended: () => ended }
}

async function until(probe: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The raw failures settled() reports after a kill: top-level messages, and each one's own causes. */
async function reported(driver: Adapter): Promise<Array<[string, string[]]>> {
  driver.kill()
  const error = await driver.settled().then(() => null, (caught: unknown) => caught)
  const all = error === null ? [] : error instanceof AggregateError ? error.errors : [error]
  return all.map((e) => [(e as Error).message, e instanceof AgentRuntimeError ? e.causes.map((c) => (c as Error).message) : []])
}

const completed = (events: ChatEvent[]) => events.filter((e) => e.type === 'turn_completed')
/** The rollout path the fake saved for a thread. */
const savedPath = (root: CodexRoot, threadId: string) => (JSON.parse(readFileSync(join(root.home, 'threads', `${threadId}.json`), 'utf8')) as { path: string }).path
const pids = (root: CodexRoot) => readFileSync(join(root.home, 'pids'), 'utf8').split('\n').filter(Boolean)

const DEPLOY = { name: 'deploy', path: '/skills/deploy/SKILL.md', description: 'Deploy the service', scope: 'repo', enabled: true }
const DEPLOY_INPUT = { type: 'skill', name: 'deploy', path: '/skills/deploy/SKILL.md' }
const text = (t: string) => ({ type: 'text', text: t, text_elements: [] })

describe('Kawai Codex composition over the public package factory', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Native Codex skill input
  test('native skills: the catalog reaches Kawai, and a send carries its text then each named skill once', async () => {
    const root = codexRoot()
    const deploy = { name: 'deploy', path: '/skills/deploy/SKILL.md', description: 'Deploy the service', scope: 'repo', enabled: true }
    const review = { name: 'review', path: '/home/u/.codex/skills/review/SKILL.md', description: 'Review a diff', scope: 'user', enabled: true }
    writeFileSync(join(root.home, 'skills.json'), JSON.stringify({ skills: [deploy, review] }))
    const h = harness(root)
    h.driver.start()
    await until(() => h.driver.getCommandState().status === 'ready')
    expect(h.driver.getCommandState().commands.map((c) => c.name)).toEqual(['deploy', 'review'])
    const words = 'please /deploy now /deploy then /review /missing x/deploy'
    h.driver.send(words)
    await until(() => completed(h.events).length === 1)
    expect(sent(root, 'turn/start').map((m) => m.params.input)).toEqual([[
      { type: 'text', text: words, text_elements: [] },
      { type: 'skill', name: 'deploy', path: '/skills/deploy/SKILL.md' },
      { type: 'skill', name: 'review', path: '/home/u/.codex/skills/review/SKILL.md' },
    ]])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex skill suppression per submission
  test('S1: a peer delivery naming a catalog skill sends its envelope text alone; the following human send carries the skill', async () => {
    const root = codexRoot()
    writeFileSync(join(root.home, 'skills.json'), JSON.stringify({ skills: [DEPLOY] }))
    const h = harness(root)
    h.driver.start()
    await until(() => h.driver.getCommandState().status === 'ready')
    const envelope = { messageId: crypto.randomUUID(), senderKind: 'agent', senderSession: 'chat-lead', body: 'please /deploy now' } as never
    h.driver.deliver(envelope)
    await until(() => completed(h.events).length === 1)
    h.driver.send('/deploy now')
    await until(() => completed(h.events).length === 2)
    expect(sent(root, 'turn/start').map((m) => m.params.input)).toEqual([[text(formatEnvelope(envelope))], [text('/deploy now'), DEPLOY_INPUT]])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex skill suppression per submission
  test('S1: a question answer is an internal turn with its text alone, as a new turn and as a steer', async () => {
    const root = codexRoot()
    writeFileSync(join(root.home, 'skills.json'), JSON.stringify({ skills: [DEPLOY] }))
    const asked: SubmitOptions[] = []
    const create = (options: CodexDriverOptions) => {
      const inner = createCodexDriver(options)
      const send = inner.send.bind(inner)
      inner.send = (text, submit) => (asked.push({ ...submit }), send(text, submit))
      return inner
    }
    const { driver, events } = harness(root, { create })
    driver.start()
    await until(() => driver.getCommandState().status === 'ready')
    const ask = (end: string) => `/script ${JSON.stringify({ notes: [{ method: 'item/completed', params: { item: { type: 'agentMessage', id: `q-${end}`, text: 'Ship it?', questions: [{ title: 'Ship /deploy?', options: ['/deploy'] }] } } }], end })}`
    const answer = async () => {
      await until(() => driver.getPendingRequests().length === 1)
      expect(driver.answerQuestion(driver.getPendingRequests()[0]!.requestId, { 'Ship /deploy?': { options: ['/deploy'] } })).toEqual({ ok: true })
    }
    // The question's turn ends first: the answer is a new turn.
    driver.send(ask('completed'))
    await until(() => completed(events).length === 1)
    await answer()
    await until(() => sent(root, 'turn/start').length === 2 && completed(events).length === 2)
    // The question's turn is still running: the answer steers it.
    driver.send(ask('hold'))
    await answer()
    await until(() => sent(root, 'turn/steer').length === 1)
    expect(sent(root, 'turn/start').map((m) => m.params.input).filter((_, i) => i !== 0 && i !== 2)).toEqual([[text('Ship /deploy?: /deploy')]])
    expect(sent(root, 'turn/steer').map((m) => m.params.input)).toEqual([[text('Ship /deploy?: /deploy')]])
    expect(asked.map((submit) => [submit.codexSkills, submit.continuation])).toEqual([[undefined, undefined], ['none', undefined], [undefined, undefined], ['none', 'steer']])
  })

  test('a send is one Kawai turn: events, thread id, spawn report and wire lines', async () => {
    const root = codexRoot()
    const h = harness(root, { effort: () => 'high' })
    h.driver.send('hello')
    await until(() => completed(h.events).length === 1)
    const types = h.events.map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(['turn_started', 'user_message'])
    expect(types).toContain('assistant_text')
    expect(types.at(-1)).toBe('turn_completed')
    expect(h.events.map((e) => e.sequence)).toEqual(h.events.map((_, i) => i + 1))
    expect(h.events.every((e) => e.id.startsWith('evt-'))).toBe(true)
    const turnIds = new Set(h.events.map((e) => (e as { turnId?: string }).turnId))
    expect(turnIds.size).toBe(1)
    const user = h.events.find((e) => e.type === 'user_message') as Extract<ChatEvent, { type: 'user_message' }>
    expect(user.text).toBe('hello')
    expect(sent(root, 'turn/start').map((m) => [m.params.input[0].text, m.params.effort, m.params.clientUserMessageId])).toEqual([['hello', 'high', user.messageUuid]])
    expect(h.sessions).toHaveLength(1)
    expect(h.sessions[0]).toStartWith('thr-')
    expect(h.spawns.map((s) => [s.cwd, s.env.CODEX_HOME, s.effort, s.resumed])).toEqual([[join(root.root, 'work'), root.home, 'high', false]])
    expect(h.wire.some(([dir, raw]) => dir === 'out' && raw.includes('"turn/start"'))).toBe(true)
    // The production boundary: the package's own client spoke to the app-server.
    expect(sent(root, 'initialize').map((m) => m.params.clientInfo.name)).toEqual(['agent-runtime'])
    expect(h.statuses.at(-1)).toBe('waiting')
    expect(h.statuses).toContain('working')
  })

  test("each send's effort is the one read when Kawai accepted it, on the same process", async () => {
    const root = codexRoot()
    let effort = 'medium'
    const h = harness(root, { effort: () => effort })
    h.driver.send('first')
    // Edited while the first send still waits for the thread.
    effort = 'high'
    await until(() => completed(h.events).length === 1)
    h.driver.send('second')
    await until(() => completed(h.events).length === 2)
    expect(sent(root, 'turn/start').map((m) => [m.params.input[0].text, m.params.effort])).toEqual([['first', 'medium'], ['second', 'high']])
    expect(pids(root)).toHaveLength(1)
  })

  test('manual approval shows Kawai’s card and resolves as the user; auto grants with no card', async () => {
    const root = codexRoot()
    let policy: 'manual' | 'auto' = 'manual'
    const h = harness(root, { policy: () => policy })
    h.driver.send('/ask item/commandExecution/requestApproval {"command":"git push","cwd":"/w","reason":"push it"}')
    await until(() => h.events.some((e) => e.type === 'approval_request'))
    const card = h.events.find((e) => e.type === 'approval_request') as Extract<ChatEvent, { type: 'approval_request' }>
    expect([card.tool, card.input]).toEqual(['Bash', { command: 'git push', cwd: '/w', reason: 'push it' }])
    expect(h.driver.getPendingRequests().map((r) => [r.kind, r.requestId])).toEqual([['approval', card.requestId]])
    expect(h.statuses.at(-1)).toBe('permission')
    expect(h.driver.resolveApproval(card.requestId, 'allow')).toEqual({ ok: true })
    await until(() => completed(h.events).length === 1)
    const resolved = h.events.filter((e) => e.type === 'request_resolved')
    expect(resolved.map((e) => [e.requestId, e.outcome, e.decidedBy])).toEqual([[card.requestId, 'allowed', 'user']])
    policy = 'auto'
    h.driver.send('/ask item/commandExecution/requestApproval {"command":"ls"}')
    await until(() => completed(h.events).length === 2)
    expect(h.events.filter((e) => e.type === 'approval_request')).toHaveLength(1)
    const granted = h.events.filter((e) => e.type === 'request_resolved').slice(1)
    expect(granted.map((e) => [e.outcome, e.decidedBy, e.tool])).toEqual([['allowed', 'policy', 'Bash']])
    // The app-server heard an accept both times.
    expect(h.events.filter((e) => e.type === 'assistant_text').map((e) => e.text).filter((t) => t.includes('accept'))).toHaveLength(2)
  })

  test('a mid-turn exit reports Kawai’s message with its code; the next send resumes on a new process', async () => {
    const root = codexRoot()
    const h = harness(root)
    h.driver.send('/exit 3')
    await until(() => h.ended() === 1)
    expect(h.driver.isDead).toBe(true)
    expect(h.events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual(['The Codex app-server exited with code 3'])
    h.driver.send('again')
    await until(() => completed(h.events).some((e) => e.subtype === 'success'))
    expect(h.driver.isDead).toBe(false)
    expect(pids(root)).toHaveLength(2)
    expect(sent(root, 'thread/resume').map((m) => m.params.threadId)).toEqual([h.sessions[0]])
    expect(h.sessions).toHaveLength(1)
    expect(h.spawns.map((s) => s.resumed)).toEqual([false, true])
    // The crashed generation's own stop (the retire before the respawn) is reported once, raw.
    expect(await reported(h.driver)).toEqual([['stop failed: 1 owned operation(s) failed', [exitCause(1, 3, null)]]])
  })

  test('a refused thread/start reports Kawai’s start error and the session is dead', async () => {
    const root = codexRoot()
    const h = harness(root, { env: { FAKE_CODEX_START: 'unauthorized' } })
    h.driver.start()
    await until(() => h.driver.isDead)
    expect(h.events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual(['Codex could not start the thread: app-server request 2 (thread/start) failed: 401 Unauthorized'])
    expect(sent(root, 'thread/start')).toHaveLength(1)
    expect((await reported(h.driver)).map(([message]) => message)[0]).toBe('Codex could not start a thread: app-server request 2 (thread/start) failed: 401 Unauthorized')
  })

  test('a refused thread/start on a live app-server is over: a later start respawns a new process (runtimeBoot.ts)', async () => {
    const root = codexRoot()
    const h = harness(root, { env: { FAKE_CODEX_START: 'unauthorized' } })
    h.driver.start()
    await until(() => h.driver.isDead)
    expect(h.ended()).toBe(0)
    h.driver.start()
    await until(() => sent(root, 'thread/start').length === 2 && h.driver.isDead)
    // The failed driver retired (its stop re-reports only the start failure it already reported), then a new process.
    expect(pids(root)).toHaveLength(2)
    expect(h.events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual(Array(2).fill('Codex could not start the thread: app-server request 2 (thread/start) failed: 401 Unauthorized'))
    // Each start failure is reported raw; every stop reports only a start failure as its cause.
    const failures = await reported(h.driver)
    const start = 'Codex could not start a thread: app-server request 2 (thread/start) failed: 401 Unauthorized'
    expect(failures.filter(([message]) => message === start)).toHaveLength(2)
    expect(failures.filter(([message]) => message !== start).map(([message, inner]) => [message, inner])).toEqual(
      failures.filter(([message]) => message !== start).map(() => ['stop failed: 1 owned operation(s) failed', [start]]),
    )
  })

  test('an app-server that exits while booting reports only its exit, as before', async () => {
    const root = codexRoot()
    const h = harness(root, { executable: '/bin/false' })
    h.driver.start()
    await until(() => h.ended() === 1)
    const failures = await reported(h.driver)
    expect(h.events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual(['The Codex app-server exited with code 1'])
    expect(h.driver.isDead).toBe(true)
    expect(failures.map(([message]) => message)[0]).toBe('the Codex app-server exited with code 1')
  })

  test('a rejected kill is quiescence only when its causes are exactly the reported exits', async () => {
    // The package's own receipt: kill after a crash rejects with that exit.
    const root = codexRoot()
    const { createCodexDriver } = await import('@motuslabs/agent-runtime/codex')
    const reports: Array<{ generation: number; code: number | null; signal: string | null }> = []
    const inner = createCodexDriver({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      launch: { cwd: join(root.root, 'work'), childEnv: { CODEX_HOME: root.home, PATH: process.env.PATH ?? '' }, executablePath: root.wrapper, homeDir: root.home, cacheDir: join(root.root, 'cache'), tempDir: join(root.root, 'tmp') },
      permissions: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: true, writableRoots: [], userInput: 'enabled', elicitation: 'disabled' },
      callbacks: { onEvent() {}, onProcessEnd: (report) => void reports.push(report) },
    })
    await inner.start()
    await (await inner.send('/exit 3')).result
    const crashed = await inner.kill().then(() => null, (error: unknown) => error)
    const exits = reports.map((r) => exitCause(r.generation, r.code, r.signal))
    expect(exits).toEqual(['agent process generation 1 exited with code 3 before the stop'])
    const other = new AgentRuntimeError({ category: 'transport', message: 'teardown could not confirm the exit' })
    const stop = (causes: unknown[]) => new AgentRuntimeError({ category: 'stop', message: 'stop failed' }, causes)
    const table: Array<[string, unknown, string[], boolean]> = [
      ['the package receipt of a reported crash', crashed, exits, true],
      ['the same receipt with no exit heard', crashed, [], false],
      ['an extra owned failure beside the exit', stop([...(crashed as AgentRuntimeError).causes, other]), exits, false],
      ['a failure that is not an exit', stop([other]), exits, false],
      ['a stop with no causes', stop([]), exits, false],
      ['not a stop error', other, exits, false],
      ['one exit heard, two reported as causes', stop([...(crashed as AgentRuntimeError).causes, ...(crashed as AgentRuntimeError).causes]), exits, false],
    ]
    expect(table.map(([name, error, heard]) => [name, quiesced(error, heard)])).toEqual(table.map(([name, , , want]) => [name, want]))
    // A start failure already reported counts by identity, beside the exits; an equal-looking copy does not.
    const started = new AgentRuntimeError({ category: 'transport', message: 'the Claude Code query could not be created' })
    const copy = new AgentRuntimeError({ category: 'transport', message: started.message })
    expect([
      quiesced(stop([started]), [], [started]),
      quiesced(stop([started, ...(crashed as AgentRuntimeError).causes]), exits, [started]),
      quiesced(stop([copy]), [], [started]),
      quiesced(stop([started]), [], []),
    ]).toEqual([true, true, false, false])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex thread opening reports a moved transcript
  test('a resume onto a moved rollout reports the new transcript path and no new session id', async () => {
    const root = codexRoot()
    const first = harness(root)
    first.driver.send('hello')
    await until(() => completed(first.events).length === 1)
    const threadId = first.sessions[0]!
    expect(first.transcripts).toEqual([savedPath(root, threadId)])
    first.driver.kill()
    await first.driver.settled()
    const resumed = harness(root, { env: { FAKE_CODEX_RESUME: 'moved' }, resume: threadId })
    resumed.driver.send('again')
    await until(() => completed(resumed.events).length === 1)
    const moved = savedPath(root, threadId)
    expect([moved === first.transcripts[0], moved.includes(`${threadId}-moved-`)]).toEqual([false, true])
    expect(resumed.transcripts).toEqual([moved])
    expect(resumed.sessions).toEqual([])
  })
})
