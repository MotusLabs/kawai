// Team-tool calls through Kawai's production Codex composition (task-ce05430a
// R2 G2): the actual factory (createChatDriver) -> Kawai's adapter
// (codexRuntime.ts) -> the package driver, spawning the package's fake
// app-server as a real child. Each call is one turn whose `/tool <json>`
// directive makes the fake send an `item/tool/call` on the session's own
// thread; the answer is the reply the driver wrote, read from the fake's
// received.jsonl, never the turn's text. The fake's `/tool` fields win, so a
// test may name another thread or namespace. One driver per session id, built
// with that session's team table at its first call (production registers the
// table at thread start), so a test file closes them after each test.
// closeAll() joins through the package's shared test-cleanup owner
// (helpers/ownedCleanup.ts, imported by path; mechanics in its header): one
// reserved join shared by overlapping callers, every session joined whatever
// rejects (sessions opened during the join included), each session's close
// run once, and its failure reported as the original value. A session's
// close reserves its closing state before any effect: it refuses every
// queued and in-flight call with CLOSED (a waiting turn is rejected, a queued
// one is refused when it runs, and no waiter is created afterwards), then
// joins the call queue and the driver's settled() before it removes the
// root, so no call outlives its session's cleanup.
import fs from 'node:fs'
import type { ChatEvent } from '../../shared/chat'
import { createChatDriver } from '../chat/provider/createChatDriver'
import type { RuntimeDriver } from './codexDriverHarness'
import type { TeamToolSpec } from '../team/mailboxTools'
import { codexRoot, type CodexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'
import { ownedAggregate, ownedOnce, type OwnedOnce } from '../../../packages/agent-runtime/__tests__/helpers/ownedCleanup'

/** One `item/tool/call` reply as the driver wrote it. */
export interface CodexToolAnswer {
  success: boolean
  contentItems: Array<{ type: string; text?: string }>
}

interface Session {
  root: CodexRoot
  driver: RuntimeDriver
  completed: number
  waiting: Array<{ target: number; resolve: () => void; reject: (error: Error) => void }>
  answered: number
  queue: Promise<unknown>
  closed: OwnedOnce<void>
  closing: boolean
}

/** The refusal every call of a closing session settles with. */
export const CLOSED = 'codexToolSession: the session closed before the call was served'

const isReply = (message: Record<string, unknown>) =>
  typeof message.id === 'number' && message.id >= 1000 && message.method === undefined

/**
 * Close one session, once: reserve closing and refuse every waiting call
 * synchronously, then kill the driver and join the call queue and the
 * driver's owned work before removing the root (in finally, whatever throws).
 */
const close = (session: Session): Promise<void> =>
  session.closed.run(async () => {
    session.closing = true
    for (const waiter of session.waiting.splice(0)) waiter.reject(new Error(CLOSED))
    const failures: unknown[] = []
    try {
      try {
        session.driver.kill()
      } catch (error) {
        failures.push(error)
      }
      // The queue never rejects (each call's own promise carries its outcome);
      // a call queued while this waits is refused and joined by a later pass.
      for (let joined = session.queue; ; joined = session.queue) {
        await joined
        if (joined === session.queue) break
      }
      try {
        await session.driver.settled()
      } catch (error) {
        failures.push(error)
      }
    } finally {
      fs.rmSync(session.root.root, { recursive: true, force: true })
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Codex tool session close failed')
  })

export class CodexToolSessions {
  private readonly live = new Map<string, Session>()
  private readonly owned = ownedAggregate<Session, void>({
    join: close,
    failures: (_session, outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []),
    message: 'Codex tool session cleanups failed',
  })

  /** `tableFor` builds a session's team table when its driver starts. */
  constructor(private readonly tableFor: (sessionId: string) => readonly TeamToolSpec[]) {}

  /** Serve one call for `sessionId`; `fields` override the scripted call (threadId, namespace, …). */
  call(sessionId: string, tool: string, args: unknown, fields: Record<string, unknown> = {}): Promise<CodexToolAnswer> {
    const session = this.session(sessionId)
    const run = session.queue.then(() => this.serve(session, { namespace: 'kawai-team', tool, arguments: args, ...fields }))
    session.queue = run.catch(() => {})
    return run
  }

  /** The `dynamicTools` the session's thread/start carried. */
  dynamicTools(sessionId: string): Promise<unknown> {
    const session = this.session(sessionId)
    const run = session.queue.then(() => this.readTools(session))
    session.queue = run.catch(() => {})
    return run
  }

  private async readTools(session: Session): Promise<unknown> {
    if (session.closing) throw new Error(CLOSED)
    session.driver.start()
    const start = () => session.root.received().find(message => message.method === 'thread/start')
    const deadline = Date.now() + 10_000
    while (!start()) {
      if (session.closing) throw new Error(CLOSED)
      if (Date.now() > deadline) throw new Error('codexToolSession: no thread/start')
      await Bun.sleep(10)
    }
    return (start()!.params as { dynamicTools?: unknown }).dynamicTools
  }

  /** Kill every driver, join its owned work, and remove its root. */
  closeAll(): Promise<void> {
    this.live.clear()
    return this.owned.join()
  }

  private session(sessionId: string): Session {
    const existing = this.live.get(sessionId)
    if (existing) return existing
    const root = codexRoot()
    const session: Session = { root, driver: null as unknown as RuntimeDriver, completed: 0, waiting: [], answered: 0, queue: Promise.resolve(), closed: ownedOnce<void>(), closing: false }
    const onEvent = (event: ChatEvent) => {
      if (event.type !== 'turn_completed') return
      session.completed += 1
      for (const waiter of session.waiting.splice(0)) {
        if (session.completed >= waiter.target) waiter.resolve()
        else session.waiting.push(waiter)
      }
    }
    session.driver = createChatDriver({
      runtime: 'codex',
      options: {
        sessionId, projectPath: root.launch().cwd, executable: root.wrapper, codexHome: root.home, network: true,
        serverEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root.root },
        withheldCredentials: () => new Set(), wire: { record() {} }, claimRateLimitsRead: () => false, onStatus() {},
        teamTools: [...this.tableFor(sessionId)], onEvent,
      },
    }) as RuntimeDriver
    this.live.set(sessionId, session)
    this.owned.add(session)
    return session
  }

  private async serve(session: Session, call: Record<string, unknown>): Promise<CodexToolAnswer> {
    // A queued call that runs after close began is refused without a send or a waiter.
    if (session.closing) throw new Error(CLOSED)
    const target = session.completed + 1
    const done = new Promise<void>((resolve, reject) => {
      if (session.completed >= target) resolve()
      else session.waiting.push({ target, resolve, reject })
    })
    session.driver.send(`/tool ${JSON.stringify(call)}`)
    await done
    const replies = session.root.received().filter(isReply)
    const reply = replies[session.answered]
    if (!reply) throw new Error('codexToolSession: the driver wrote no item/tool/call reply')
    session.answered += 1
    if (reply.error !== undefined) throw new Error(`codexToolSession: JSON-RPC error ${JSON.stringify(reply.error)}`)
    return reply.result as CodexToolAnswer
  }
}
