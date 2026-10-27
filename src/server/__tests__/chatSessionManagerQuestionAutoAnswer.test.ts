// Question auto-answer manager wiring (openspec question-auto-answer, task
// 3.2): the manager builds every Claude driver with a live
// `getQuestionAutoAnswerMs` converted from the saved minutes — the
// production composition hazard M1 names, which a hand-built driver cannot
// kill. The codex branch never receives the getter (QA-U4).
// @reads: src/server/chat/ChatSessionManager.ts, src/server/chat/provider/createChatDriver.ts
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { realTimerScheduler } from '../chat/timerScheduler'
import { ManualClock } from './fixtures/manualClock'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import {
  anyDirectory,
  closeDispatchers,
  fakeQueryFactory,
  flush,
  installManagerCleanup,
  managedManager,
  type FakeHandle,
} from './helpers/chatSessionManagerHarness'

installManagerCleanup()

function markedQuestion(label: string): Record<string, unknown> {
  return {
    questions: [
      {
        question: label,
        header: label,
        multiSelect: false,
        options: [{ label: 'Yes (Recommended)' }, { label: 'No' }],
      },
    ],
  }
}

function pendingRequestId(events: ChatEvent[], label: string): string {
  const request = events.find(
    (event): event is Extract<ChatEvent, { type: 'question_request' }> =>
      event.type === 'question_request' && event.questions.some((q) => q.question === label)
  )
  if (!request) throw new Error(`No question_request for ${label}`)
  return request.requestId
}

function stillPendingAfterHold(
  manager: { getPendingRequests: (id: string) => Array<{ kind: string; questions?: Array<{ question: string }>; autoAnswer?: unknown }> },
  id: string,
  label: string
): { autoAnswer?: unknown } | undefined {
  return manager.getPendingRequests(id).find(
    (request) => request.kind === 'question' && request.questions?.some((q) => q.question === label)
  )
}

describe('ChatSessionManager question auto-answer', () => {
  let tempDir: string
  let db: SessionDatabase
  const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-qaa-mgr-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
  })

  afterEach(() => {
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
    if (originalOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
  })

  test('a changed setting applies to the next question and a pending deadline stands (QA-S3, QA-S5, QA-P4)', async () => {
    let minutes = 5
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    const manager = await managedManager({
      isDirectory: anyDirectory,
      registry: new SessionRegistry(),
      db,
      onEvent: (_sessionId, event) => events.push(event),
      queryFactory: fakeQueryFactory(handles),
      getQuestionAutoAnswerMinutes: () => minutes,
    })
    const created = manager.createSession({ projectPath: '/tmp/proj' })
    if (!created.ok) throw new Error(created.error)
    const id = created.session.id
    try {
      await manager.send(id, 'go')
      await flush()
      const controller = new AbortController()
      const ask = (label: string, toolUseID: string) =>
        handles.at(-1)!.options.canUseTool!(
          'AskUserQuestion',
          markedQuestion(label),
          { signal: controller.signal, toolUseID, requestId: `r-${toolUseID}` }
        ) as Promise<unknown>
      const questionEvents = () =>
        events.filter((event): event is Extract<ChatEvent, { type: 'question_request' }> =>
          event.type === 'question_request')

      // The manager-built driver arms the deadline (the wiring M-3.2 cuts).
      void ask('Deploy?', 'q1')
      await flush()
      expect(questionEvents().at(-1)!.autoAnswer).toBeDefined()

      // A pending deadline stands while the setting changes…
      const pending = manager.getPendingRequests(id)
      expect(pending).toHaveLength(1)

      // …and the next question reads the live value: 0 arms nothing, a
      // later positive value arms again.
      minutes = 0
      void ask('Merge?', 'q2')
      await flush()
      expect(questionEvents().at(-1)!.autoAnswer).toBeUndefined()
      minutes = 10
      void ask('Ship?', 'q3')
      await flush()
      expect(questionEvents().at(-1)!.autoAnswer).toBeDefined()

      // The first request kept its original 5-minute deadline throughout.
      const stillPending = manager.getPendingRequests(id).find(
        (request) => request.kind === 'question' && request.questions.some((q) => q.question === 'Deploy?')
      )
      expect(stillPending?.kind === 'question' ? stillPending.autoAnswer : undefined).toBeDefined()
      expect(events.some((event) => event.type === 'request_resolved')).toBe(false)

      // A hold through the manager (the chat-question-hold path) drops the
      // deadline and its held event reaches the broadcast input (QA-3).
      expect(manager.holdQuestion(id, pendingRequestId(events, 'Deploy?'))).toEqual({ ok: true })
      const held = events.find((event): event is Extract<ChatEvent, { type: 'question_auto_answer_held' }> =>
        event.type === 'question_auto_answer_held')
      expect(held).toBeDefined()
      expect(
        stillPendingAfterHold(manager, id, 'Deploy?')?.autoAnswer
      ).toBeUndefined()
      expect(events.some((event) => event.type === 'request_resolved')).toBe(false)
    } finally {
      manager.kill(id)
      await flush()
    }
  }, 30_000)

  test('description-only recommendations time out with original labels and a hold prevents settlement (QA-R6)', async () => {
    const clock = new ManualClock()
    // Replace only the process-timer boundary; construction, setting getter,
    // parsing, recommendation detection, and settlement use production code.
    const schedule = spyOn(realTimerScheduler, 'schedule').mockImplementation(
      (ms, fire) => clock.schedule(ms, fire))
    const cancel = spyOn(realTimerScheduler, 'cancel').mockImplementation(
      (handle) => clock.cancel(handle))
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    let cleanup = () => {}
    try {
      const manager = await managedManager({
        isDirectory: anyDirectory,
        registry: new SessionRegistry(), db,
        onEvent: (_sessionId, event) => events.push(event),
        queryFactory: fakeQueryFactory(handles),
        getQuestionAutoAnswerMinutes: () => 1,
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error(created.error)
      const id = created.session.id
      cleanup = () => { manager.kill(id) }
      await manager.send(id, 'go')
      await flush()
      const ask = (label: string) => handles.at(-1)!.options.canUseTool!(
        'AskUserQuestion',
        { questions: [{ question: label, header: label, options: [
          { label: '  Blue  ', description: 'I recomend this' },
          { label: 'Red' },
        ] }] },
        { signal: new AbortController().signal, toolUseID: label, requestId: label }
      )
      const automatic = ask('Color?')
      await flush()
      const requestId = pendingRequestId(events, 'Color?')
      const pending = manager.getPendingRequests(id).find((r) => r.requestId === requestId)
      expect(pending?.kind === 'question' ? pending.autoAnswer?.answers : undefined).toEqual({
        'Color?': { options: ['  Blue  '] },
      })
      const request = events.find((event) => event.type === 'question_request')
      expect(request?.type === 'question_request' ? request.autoAnswer : undefined).toEqual(
        pending?.kind === 'question' ? pending.autoAnswer : undefined)
      clock.advance(59_999)
      expect(events.some((event) => event.type === 'request_resolved')).toBe(false)
      clock.advance(1)
      const result = await Promise.race([
        automatic,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ])
      expect(result).toMatchObject({ behavior: 'allow', updatedInput: {
        answers: { 'Color?': '  Blue  ' },
        response: 'No answer from the user within 1 minute; the recommended option was selected automatically.',
      } })
      expect(events.find((event) => event.type === 'request_resolved')).toMatchObject({
        requestId, outcome: 'answered', decidedBy: 'timeout', answers: { 'Color?': '  Blue  ' },
      })
      expect(manager.getPendingRequests(id)).toHaveLength(0)

      const heldAnswer = ask('Held color?')
      await flush()
      const heldId = pendingRequestId(events, 'Held color?')
      expect(clock.pendingCount).toBe(1)
      expect(manager.holdQuestion(id, heldId)).toEqual({ ok: true })
      expect(clock.pendingCount).toBe(0)
      expect(stillPendingAfterHold(manager, id, 'Held color?')?.autoAnswer).toBeUndefined()
      clock.advance(120_000)
      await flush()
      expect(events.filter((event) => event.type === 'request_resolved')).toHaveLength(1)
      expect(manager.getPendingRequests(id)).toHaveLength(1)
      expect(events.find((event) => event.type === 'question_auto_answer_held')).toMatchObject({ requestId: heldId })
      expect(manager.answerQuestion(id, heldId, { 'Held color?': { options: ['Red'] } })).toEqual({ ok: true })
      await heldAnswer
    } finally {
      cleanup()
      schedule.mockRestore()
      cancel.mockRestore()
      await flush()
    }
  }, 30_000)

  test('hyphenated negative-first options never win and an all-negative question never arms (B1)', async () => {
    const clock = new ManualClock()
    // Replace only the process-timer boundary, as in QA-R6: the manager,
    // driver, parsing, detection, and settlement stay production code.
    const schedule = spyOn(realTimerScheduler, 'schedule').mockImplementation(
      (ms, fire) => clock.schedule(ms, fire))
    const cancel = spyOn(realTimerScheduler, 'cancel').mockImplementation(
      (handle) => clock.cancel(handle))
    const handles: FakeHandle[] = []
    const events: ChatEvent[] = []
    let cleanup = () => {}
    try {
      const manager = await managedManager({
        isDirectory: anyDirectory,
        registry: new SessionRegistry(), db,
        onEvent: (_sessionId, event) => events.push(event),
        queryFactory: fakeQueryFactory(handles),
        getQuestionAutoAnswerMinutes: () => 1,
      })
      const created = manager.createSession({ projectPath: '/tmp/proj' })
      if (!created.ok) throw new Error(created.error)
      const id = created.session.id
      cleanup = () => { manager.kill(id) }
      await manager.send(id, 'go')
      await flush()
      const ask = (label: string, options: Array<{ label: string }>) => handles.at(-1)!.options.canUseTool!(
        'AskUserQuestion',
        { questions: [{ question: label, header: label, options }] },
        { signal: new AbortController().signal, toolUseID: label, requestId: label }
      )
      // A hyphenated negative first option must not supply the answer: the
      // safe later recommendation wins and the timeout submits that label.
      const automatic = ask('Flow?', [
        { label: 'Force push (not-recommended)' },
        { label: 'Open a PR (Recommended)' },
      ])
      await flush()
      const requestId = pendingRequestId(events, 'Flow?')
      const pending = manager.getPendingRequests(id).find((r) => r.requestId === requestId)
      expect(pending?.kind === 'question' ? pending.autoAnswer?.answers : undefined).toEqual({
        'Flow?': { options: ['Open a PR (Recommended)'] },
      })
      clock.advance(59_999)
      expect(events.some((event) => event.type === 'request_resolved')).toBe(false)
      clock.advance(1)
      const result = await Promise.race([
        automatic,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ])
      expect(result).toMatchObject({ behavior: 'allow', updatedInput: {
        answers: { 'Flow?': 'Open a PR (Recommended)' },
        response: 'No answer from the user within 1 minute; the recommended option was selected automatically.',
      } })
      expect(events.find((event) => event.type === 'request_resolved')).toMatchObject({
        requestId, outcome: 'answered', decidedBy: 'timeout',
        answers: { 'Flow?': 'Open a PR (Recommended)' },
      })
      expect(manager.getPendingRequests(id)).toHaveLength(0)

      // A question whose every option is a hyphenated negative arms no
      // deadline: it waits for the user like any unmarked question.
      const waited = ask('Cleanup?', [
        { label: 'Skip tests (not-recommended)' },
        { label: 'Non-recommended' },
      ])
      await flush()
      const waitedId = pendingRequestId(events, 'Cleanup?')
      expect(clock.pendingCount).toBe(0)
      expect(stillPendingAfterHold(manager, id, 'Cleanup?')?.autoAnswer).toBeUndefined()
      clock.advance(120_000)
      await flush()
      expect(events.filter((event) => event.type === 'request_resolved')).toHaveLength(1)
      expect(manager.getPendingRequests(id)).toHaveLength(1)
      expect(manager.answerQuestion(id, waitedId, { 'Cleanup?': { options: ['Non-recommended'] } })).toEqual({ ok: true })
      await waited
    } finally {
      cleanup()
      schedule.mockRestore()
      cancel.mockRestore()
      await flush()
    }
  }, 30_000)

  test('only the claude branch receives the getter; shared options never carry it (QA-U4)', () => {
    const managerSource = fs.readFileSync(
      path.join(import.meta.dir, '../chat/ChatSessionManager.ts'),
      'utf8'
    )
    const getterAt = managerSource.indexOf('getQuestionAutoAnswerMs')
    expect(getterAt).toBeGreaterThan(0)
    // The construction sites: the getter's nearest preceding runtime literal
    // is the claude branch, and the codex branch precedes that.
    const codexDriverAt = managerSource.lastIndexOf("runtime: 'codex'", getterAt)
    const claudeDriverAt = managerSource.lastIndexOf("runtime: 'claude'", getterAt)
    expect(claudeDriverAt).toBeGreaterThan(codexDriverAt)
    expect(codexDriverAt).toBeGreaterThan(0)

    const factorySource = fs.readFileSync(
      path.join(import.meta.dir, '../chat/provider/createChatDriver.ts'),
      'utf8'
    )
    // Not in ChatDriverSharedOptions, so a codex driver can never receive it.
    expect(factorySource).not.toContain('getQuestionAutoAnswerMs')
  })
})
