// The driver factory (codex-chat-sessions 2.3, 5.6; extract-agent-runtime
// 6.1): a claude or codex record builds Kawai's adapter over the package's
// public factory for that runtime; a runtime
// with no wired driver throws instead of starting as something else. The
// in-tree Codex class is gone (task-5906f19c); the codex case shows the
// package's own construction instead.
//
// The 6.1 production-composition witness (task-f5001d7f A5) runs the codex
// record through createChatDriver -> codexRuntime.ts -> the public package
// factory -> the replaying fake app-server, and checks that every
// caller-defined input (project, model, network, prompt, team tools, stored
// thread, wire) reaches the app-server as the package's thread parameters.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { cleanGitEnv } from '../git/gitCommand'
import { Script, sentRequest, startHarness, THREAD_ID, until, type Harness } from './codexDriverHarness'
import { createFakeQuery, flush } from './fixtures/chatDriverHarness'

const deps = {
  sessionId: 'chat-factory-test',
  projectPath: '/tmp/kawai-driver-factory',
  queryFactory: (() => ({}) as unknown as Query),
  onEvent: () => {},
  onStatus: () => {},
}

describe('createChatDriver', () => {
  test('the claude runtime builds the package-backed Claude adapter without spawning', async () => {
    const seen: Options[] = []
    const driver = createChatDriver({
      runtime: 'claude',
      options: { ...deps, queryFactory: ({ prompt, options }) => (seen.push(options as Options), createFakeQuery(prompt, options as Options).query) },
    }) as ReturnType<typeof createChatDriver> & { settled(): Promise<void> }
    // The adapter owns its package promises.
    expect(typeof driver.settled).toBe('function')
    // A fresh driver starts its command state at loading, before any start().
    expect(driver.getCommandState().status).toBe('loading')
    // Its query is the package's composition (in place of the deleted in-tree
    // class's negative instanceof): with no wire and no executable given, the
    // package still hands the SDK its owned spawner and its resolved launch
    // executable, which the class never did over an injected query.
    driver.start()
    for (let round = 0; round < 50 && seen.length === 0; round++) await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(seen[0]!.pathToClaudeCodeExecutable).toBe(process.execPath)
    driver.kill()
    await driver.settled()
  })

  test('the codex runtime builds the package-backed Codex adapter without spawning', async () => {
    const driver = createChatDriver({
      runtime: 'codex',
      options: { ...deps, executable: '/nonexistent/codex', codexHome: '/tmp/kawai-codex-home', network: true, wire: { record: () => {} }, withheldCredentials: () => new Set() },
    }) as ReturnType<typeof createChatDriver> & { settled(): Promise<void> }
    // The adapter owns its package promises.
    expect(typeof driver.settled).toBe('function')
    // Codex has no slash commands (design D7): unavailable from the start.
    expect(driver.getCommandState()).toEqual({ status: 'unavailable', commands: [] })
    expect(driver.isDead).toBe(false)
    // Its start is the package's own (task-5906f19c A5, in place of the
    // deleted in-tree class's negative instanceof): the package core resolves
    // the launch and refuses the missing executable with its own typed error.
    driver.start()
    const refusal = await driver.settled().then(() => null, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(AgentRuntimeError)
    expect({ category: (refusal as AgentRuntimeError).category, message: (refusal as Error).message })
      .toEqual({ category: 'dependency', message: 'executable not found: /nonexistent/codex' })
    // The kill joins the same failed start: reported once, as that object.
    driver.kill()
    const stopped = await driver.settled().then(() => null, (error: unknown) => error) as { causes?: unknown[] } | null
    expect(stopped?.causes?.filter(cause => cause === refusal)).toHaveLength(1)
  })

  test('a runtime with no wired driver throws, naming it', () => {
    // Anything else is a stored value no build of kawai ever wrote.
    expect(() => createChatDriver({ runtime: 'mystery', options: deps } as never)).toThrow(/mystery/)
  })
})
describe('createChatDriver: the codex runtime over the package to a controlled app-server (6.1 M-wire)', () => {
  // The caller-defined inputs below are Kawai's: the project (inside a Git
  // repository), the profile's model and network, the system prompt, the team
  // tool table, the stored thread and the wire recorder. Each must reach the
  // app-server through createChatDriver -> codexRuntime.ts -> the public
  // package factory; the expected values are derived from those inputs alone.
  let dir: string
  let repo: string
  let harness: Harness | null = null
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...cleanGitEnv(), GIT_CONFIG_NOSYSTEM: '1' } })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  }
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-wiring-')))
    repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
  })
  afterEach(async () => {
    const done = harness?.cleanup()
    harness = null
    await done
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  const inputs = () => ({
    projectPath: path.join(repo, 'src'),
    model: 'gpt-wiring-witness',
    network: false,
    getSystemPromptAppend: () => 'wiring witness prompt',
    teamTools: [{ name: 'send_message', description: 'send a message', schema: z.object({ body: z.string() }), handler: () => ({}) }],
  })

  test('a fresh codex chat sends its caller-defined cwd, model, prompt, team tools and sandbox policy on thread/start, over the wire it recorded', async () => {
    harness = startHarness(new Script().boot(), inputs())
    harness.driver.start()
    // The thread id arrives through the adapter's callbacks, not the wire.
    await until(() => harness!.sessionIds.length === 1)
    const params = sentRequest(harness, 'thread/start') as Record<string, unknown> | undefined
    const tools = (params?.dynamicTools as Array<{ type?: string; name?: string; tools?: Array<{ name?: string }> }> | undefined) ?? []
    expect({
      first: harness.sent[0]?.method,
      cwd: params?.cwd,
      model: params?.model,
      developerInstructions: params?.developerInstructions,
      approvalPolicy: params?.approvalPolicy,
      sandbox: params?.sandbox,
      config: params?.config,
      tools: tools.map((t) => ({ type: t.type, name: t.name, tools: (t.tools ?? []).map((tool) => tool.name) })),
    }).toEqual({
      first: 'initialize',
      cwd: path.join(repo, 'src'),
      model: 'gpt-wiring-witness',
      developerInstructions: 'wiring witness prompt',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: { 'sandbox_workspace_write.writable_roots': [path.join(repo, '.git')], 'sandbox_workspace_write.network_access': false },
      tools: [{ type: 'namespace', name: 'kawai-team', tools: ['send_message'] }],
    })
    expect(harness.sessionIds).toEqual([THREAD_ID])
  })

  test('a stored codex chat resumes its own thread with the caller-defined cwd, model and prompt, and starts none', async () => {
    harness = startHarness(new Script().boot('thread/resume'), { ...inputs(), resumeThreadId: THREAD_ID })
    harness.driver.start()
    await until(() => harness!.transcriptPaths.length === 1)
    const params = sentRequest(harness, 'thread/resume') as Record<string, unknown> | undefined
    expect({
      threadId: params?.threadId,
      cwd: params?.cwd,
      model: params?.model,
      developerInstructions: params?.developerInstructions,
      approvalPolicy: params?.approvalPolicy,
      sandbox: params?.sandbox,
      started: sentRequest(harness, 'thread/start') !== undefined,
    }).toEqual({
      threadId: THREAD_ID,
      cwd: path.join(repo, 'src'),
      model: 'gpt-wiring-witness',
      developerInstructions: 'wiring witness prompt',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      started: false,
    })
  })
})
