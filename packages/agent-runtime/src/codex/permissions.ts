// Codex approval and sandbox policy (design §4, task 3.3). One supplied
// CodexPermissions value becomes the exact protocol parameters that every
// thread/start, thread/resume and turn/start carries, so neither the home's
// config.toml nor a resumed thread's stored settings decide anything:
//
// - approvalPolicy is the caller's; approvalsReviewer is always `user`, so an
//   escalation reaches the host, never an automatic reviewer.
// - sandbox `none` maps to the pinned protocol's `danger-full-access`; it is
//   never silently replaced by workspace-write.
// - workspace-write always sends its writable roots (an empty list too) and its
//   network flag, replacing whatever roots a stored thread accumulated.
// - turn/start carries the full SandboxPolicy, so read-only network access is
//   explicit on every turn.
// - Caller parameters cannot widen it: policy fields win and a named
//   `permissions` profile (which the protocol resolves instead of `sandbox`) is
//   dropped.
//
// Combinations the protocol cannot enforce are refused at construction (P08).
// These include writable roots outside workspace-write, and no network under
// `none`. Server requests are classified here, and disabled user input or
// elicitation is answered immediately (Q04). Under `never`, an approval that
// still arrives is declined at once. Unknown methods fail closed.
import { isAbsolute } from 'node:path'
import { AgentRuntimeError } from '../errors.js'
import type { CodexPermissions } from '../options.js'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: false; excludeSlashTmp: false }

/** The policy fields shared by thread/start and thread/resume. */
export interface CodexThreadPolicy {
  approvalPolicy: CodexPermissions['approvalPolicy']
  approvalsReviewer: 'user'
  sandbox: SandboxMode
  config: Record<string, unknown>
}

/** The policy fields every turn/start carries. */
export interface CodexTurnPolicy {
  approvalPolicy: CodexPermissions['approvalPolicy']
  approvalsReviewer: 'user'
  sandboxPolicy: CodexSandboxPolicy
}

/** What the driver does with one server request. */
export type CodexRequestDisposition =
  /** Publish it to onRequest (task 4.3). */
  | { kind: 'host' }
  /** A host tool call (task 3.4). */
  | { kind: 'tool' }
  /** Answer at once with this result; nothing stays pending. */
  | { kind: 'respond'; result: unknown; reason: string }
  /** Answer with a JSON-RPC error. */
  | { kind: 'error'; message: string }

export interface CodexPermissionComposition {
  thread: Readonly<CodexThreadPolicy>
  turn: Readonly<CodexTurnPolicy>
  disposition(method: string): CodexRequestDisposition
}

const APPROVAL_POLICIES = new Set(['never', 'on-request', 'untrusted'])
const SANDBOXES: Record<CodexPermissions['sandbox'], SandboxMode> = {
  'workspace-write': 'workspace-write',
  'read-only': 'read-only',
  none: 'danger-full-access',
}
const SWITCHES = new Set(['enabled', 'disabled'])

const V2_APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])
const LEGACY_APPROVALS = new Set(['applyPatchApproval', 'execCommandApproval'])
const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval'
const USER_INPUT = 'item/tool/requestUserInput'
const ELICITATION = 'mcpServer/elicitation/request'
const TOOL_CALL = 'item/tool/call'

function configurationError(message: string): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'configuration', message })
}

function own(value: unknown, field: string, allowed: Set<string>): string {
  if (typeof value !== 'string' || !allowed.has(value)) throw configurationError(`unknown Codex ${field} ${JSON.stringify(value)}`)
  return value
}

function roots(value: unknown): string[] {
  if (!Array.isArray(value)) throw configurationError('writableRoots must be an array of absolute paths')
  for (const root of value) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw configurationError(`writable root ${JSON.stringify(root)} is not an absolute path`)
  }
  return [...new Set(value as string[])]
}

/** Validate one session's Codex permissions and compose its protocol parameters. */
export function composeCodexPermissions(permissions: CodexPermissions): CodexPermissionComposition {
  if (permissions === null || typeof permissions !== 'object') throw configurationError('Codex permissions are required')
  const approvalPolicy = own(permissions.approvalPolicy, 'approvalPolicy', APPROVAL_POLICIES) as CodexPermissions['approvalPolicy']
  const sandboxName = own(permissions.sandbox, 'sandbox', new Set(Object.keys(SANDBOXES))) as CodexPermissions['sandbox']
  if (typeof permissions.networkAccess !== 'boolean') throw configurationError('networkAccess must be a boolean')
  const userInput = own(permissions.userInput, 'userInput', SWITCHES)
  const elicitation = own(permissions.elicitation, 'elicitation', SWITCHES)
  const writableRoots = roots(permissions.writableRoots)
  const network = permissions.networkAccess
  if (writableRoots.length > 0 && sandboxName !== 'workspace-write') {
    throw configurationError(`writableRoots apply only to the workspace-write sandbox, not ${sandboxName}`)
  }
  if (sandboxName === 'none' && !network) throw configurationError('the unrestricted sandbox cannot restrict network access')

  const sandbox = SANDBOXES[sandboxName]
  const config: Record<string, unknown> =
    sandbox === 'workspace-write' ? { 'sandbox_workspace_write.writable_roots': writableRoots, 'sandbox_workspace_write.network_access': network } : {}
  const sandboxPolicy: CodexSandboxPolicy =
    sandbox === 'danger-full-access'
      ? { type: 'dangerFullAccess' }
      : sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: network }
        : { type: 'workspaceWrite', writableRoots, networkAccess: network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }

  const disposition = (method: string): CodexRequestDisposition => {
    if (method === TOOL_CALL) return { kind: 'tool' }
    if (method === USER_INPUT) {
      return userInput === 'enabled' ? { kind: 'host' } : { kind: 'respond', result: { answers: {} }, reason: 'user input is disabled for this session' }
    }
    if (method === ELICITATION) {
      return elicitation === 'enabled'
        ? { kind: 'host' }
        : { kind: 'respond', result: { action: 'decline', content: null, _meta: null }, reason: 'elicitation is disabled for this session' }
    }
    const isApproval = V2_APPROVALS.has(method) || LEGACY_APPROVALS.has(method) || method === PERMISSIONS_APPROVAL
    if (!isApproval) return { kind: 'error', message: `unsupported server request ${method}` }
    if (approvalPolicy !== 'never') return { kind: 'host' }
    const reason = 'approval policy is never'
    if (method === PERMISSIONS_APPROVAL) return { kind: 'respond', result: { permissions: {}, scope: 'turn' }, reason }
    if (LEGACY_APPROVALS.has(method)) return { kind: 'respond', result: { decision: { denied: { rejection: reason } } }, reason }
    return { kind: 'respond', result: { decision: 'decline' }, reason }
  }

  return {
    thread: Object.freeze({ approvalPolicy, approvalsReviewer: 'user', sandbox, config: Object.freeze(config) }),
    turn: Object.freeze({ approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: Object.freeze(sandboxPolicy) }),
    disposition,
  }
}

type Params = Record<string, unknown>

function withoutProfile(params: Params): Params {
  const { permissions: _named, ...rest } = params
  return rest
}

/** thread/start parameters: caller fields, then the policy (which wins). */
export function codexThreadStartParams(params: Params, composition: CodexPermissionComposition): Params {
  const caller = withoutProfile(params)
  return { ...caller, ...composition.thread, config: { ...(caller.config as Params | undefined), ...composition.thread.config } }
}

/**
 * thread/resume parameters: the same policy as start, so a stored broader
 * policy is never inherited.
 */
export function codexThreadResumeParams(threadId: string, params: Params, composition: CodexPermissionComposition): Params {
  return { ...codexThreadStartParams(params, composition), threadId }
}

/** turn/start parameters: caller fields, then the per-turn policy (which wins). */
export function codexTurnStartParams(params: Params, composition: CodexPermissionComposition): Params {
  return { ...withoutProfile(params), ...composition.turn }
}
