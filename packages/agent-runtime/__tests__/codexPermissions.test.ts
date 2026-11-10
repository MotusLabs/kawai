// Codex policy oracles (task 3.3, P07/P08/Q04/I4). The supplied permissions
// become exact protocol fields on start, resume and every turn. A resumed
// thread is checked against a stored broader configuration by applying the
// app-server's override rule: a present field replaces the stored one,
// config keys merge. Control M-policy dropping the resume override must leave
// the stored danger-full-access/on-request policy in force and fail.
// The real app-server transcript check lands with the Codex driver (task 4.2).
import { describe, expect, test } from 'bun:test'
import {
  codexThreadResumeParams,
  codexThreadStartParams,
  codexTurnStartParams,
  composeCodexPermissions,
} from '../src/codex/permissions.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { CodexPermissions } from '../src/options.js'

const HEADLESS: CodexPermissions = {
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  networkAccess: false,
  writableRoots: ['/repo/.git'],
  userInput: 'disabled',
  elicitation: 'disabled',
}

/** A stored thread that ran with broader permissions than any caller supplies below. */
const STORED_BROAD = Object.freeze({
  approvalPolicy: 'on-request',
  approvalsReviewer: 'auto_review',
  sandbox: 'danger-full-access',
  permissions: 'operator-full',
  config: { 'sandbox_workspace_write.writable_roots': ['/'], 'sandbox_workspace_write.network_access': true, model_reasoning_effort: 'high' },
})

/** The app-server's resume rule: present (non-null) fields override; config keys merge. */
function effective(stored: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...stored }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) continue
    result[key] = key === 'config' ? { ...(stored.config as object), ...(value as object) } : value
  }
  // A named profile cannot be combined with `sandbox`; the explicit sandbox wins.
  if ('sandbox' in overrides) delete result.permissions
  return result
}

function configurationFailure(build: () => unknown): void {
  try {
    build()
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect((error as AgentRuntimeError).category).toBe('configuration')
    return
  }
  throw new Error('expected a configuration error')
}

const with_ = (patch: Partial<CodexPermissions>): CodexPermissions => ({ ...HEADLESS, ...patch })

describe('Codex sandbox and approval policy', () => {
  // @covers: agent-runtime-policy › Codex supports headless approval and sandbox policy › No sandbox is explicit
  test('P07: each sandbox maps to exact thread and turn fields; none is danger-full-access, never workspace-write', () => {
    const table: Array<[Partial<CodexPermissions>, unknown, unknown]> = [
      [
        {},
        { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'workspace-write', config: { 'sandbox_workspace_write.writable_roots': ['/repo/.git'], 'sandbox_workspace_write.network_access': false } },
        { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/repo/.git'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
      ],
      [
        { writableRoots: [], networkAccess: true },
        { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'workspace-write', config: { 'sandbox_workspace_write.writable_roots': [], 'sandbox_workspace_write.network_access': true } },
        { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
      ],
      [
        { sandbox: 'read-only', writableRoots: [] },
        { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', config: {} },
        { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
      ],
      [
        { sandbox: 'none', writableRoots: [], networkAccess: true, approvalPolicy: 'on-request' },
        { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'danger-full-access', config: {} },
        { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } },
      ],
    ]
    for (const [patch, thread, turn] of table) {
      const composition = composeCodexPermissions(with_(patch))
      expect(composition.thread).toEqual(thread as never)
      expect(composition.turn).toEqual(turn as never)
      expect(Object.isFrozen(composition.thread) && Object.isFrozen(composition.turn)).toBe(true)
    }
  })

  // @covers: agent-runtime-policy › Codex supports headless approval and sandbox policy › Read-only resumed thread
  test('P07/I4: a resumed thread takes the supplied read-only/never policy, not the stored broader one', () => {
    const composition = composeCodexPermissions(with_({ sandbox: 'read-only', writableRoots: [] }))
    const resume = codexThreadResumeParams('thread-1', { cwd: '/work', model: 'gpt', permissions: 'operator-full', approvalPolicy: 'on-request', sandbox: 'danger-full-access' }, composition)
    expect(resume).toEqual({ threadId: 'thread-1', cwd: '/work', model: 'gpt', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', config: {} })
    const live = effective(STORED_BROAD, resume)
    expect([live.approvalPolicy, live.approvalsReviewer, live.sandbox, live.permissions]).toEqual(['never', 'user', 'read-only', undefined])
    // The stored workspace-write keys stay inert under read-only; every turn carries the read-only policy too.
    expect(codexTurnStartParams({ threadId: 'thread-1', input: [], sandboxPolicy: { type: 'dangerFullAccess' } }, composition)).toEqual({
      threadId: 'thread-1',
      input: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
  })

  test('P07/I4: a resumed workspace-write thread replaces the stored roots and network, keeping unrelated config', () => {
    const composition = composeCodexPermissions(HEADLESS)
    const live = effective(STORED_BROAD, codexThreadResumeParams('thread-1', { config: { model_reasoning_effort: 'low' } }, composition))
    expect(live.config).toEqual({ 'sandbox_workspace_write.writable_roots': ['/repo/.git'], 'sandbox_workspace_write.network_access': false, model_reasoning_effort: 'low' })
    expect(codexThreadStartParams({ cwd: '/work' }, composition)).toEqual({ cwd: '/work', ...composition.thread })
  })

  test('P08: unenforceable or malformed Codex permissions are configuration errors', () => {
    const bad: Array<Partial<CodexPermissions> | null> = [
      null,
      { approvalPolicy: 'auto' as never },
      { sandbox: 'danger-full-access' as never },
      { networkAccess: 'yes' as never },
      { writableRoots: ['relative/root'] },
      { writableRoots: '/repo' as never },
      { sandbox: 'read-only' },
      { sandbox: 'none', writableRoots: [], networkAccess: false },
      { userInput: 'auto' as never },
      { elicitation: undefined as never },
    ]
    for (const patch of bad) configurationFailure(() => composeCodexPermissions(patch === null ? (null as never) : with_(patch)))
    // Two sessions composed from different permissions share nothing.
    const a = composeCodexPermissions(HEADLESS)
    const b = composeCodexPermissions(with_({ sandbox: 'none', writableRoots: [], networkAccess: true }))
    expect([a.thread.sandbox, b.thread.sandbox, a.thread.config === b.thread.config]).toEqual(['workspace-write', 'danger-full-access', false])
  })
})

describe('Codex server-request dispositions', () => {
  test('Q04: disabled input and elicitation are answered at once; never declines approvals; unknown methods fail closed', () => {
    const headless = composeCodexPermissions(HEADLESS)
    expect(headless.disposition('item/tool/requestUserInput')).toMatchObject({ kind: 'respond', result: { answers: {} } })
    expect(headless.disposition('mcpServer/elicitation/request')).toMatchObject({ kind: 'respond', result: { action: 'decline', content: null, _meta: null } })
    expect(headless.disposition('item/commandExecution/requestApproval')).toMatchObject({ kind: 'respond', result: { decision: 'decline' } })
    expect(headless.disposition('item/fileChange/requestApproval')).toMatchObject({ kind: 'respond', result: { decision: 'decline' } })
    expect(headless.disposition('item/permissions/requestApproval')).toMatchObject({ kind: 'respond', result: { permissions: {}, scope: 'turn' } })
    expect(headless.disposition('execCommandApproval')).toMatchObject({ kind: 'respond', result: { decision: { denied: { rejection: 'approval policy is never' } } } })
    expect(headless.disposition('item/tool/call')).toEqual({ kind: 'tool' })
    for (const method of ['account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/unknown/request']) {
      expect(headless.disposition(method)).toEqual({ kind: 'error', message: `unsupported server request ${method}` })
    }
    const interactive = composeCodexPermissions(with_({ approvalPolicy: 'on-request', userInput: 'enabled', elicitation: 'enabled' }))
    for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/commandExecution/requestApproval', 'applyPatchApproval']) {
      expect(interactive.disposition(method)).toEqual({ kind: 'host' })
    }
  })
})
