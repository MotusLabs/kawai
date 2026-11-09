// Claude permission configuration (design §4, task 3.2). Mode, disallowed
// tools and the enabled-tool set are independent options. Enforcement is a
// deny-capable PreToolUse policy hook, installed on every session:
//
// - a disallowed tool is denied, whatever the mode (Bash included);
// - with an enabled-tool list, every unlisted tool is denied without prompting;
// - a permitted tool gets NO decision, never `allow`: an allow would skip the
//   CLI's own permission checks in the non-bypass modes.
//
// allowedTools is not a security list and the policy never sets it; nothing
// depends on canUseTool being called under bypass. The CLI resolves hook decisions with
// deny winning, so an observation hook composed after this one cannot
// re-grant a denied tool. Entries the hook cannot match exactly (permission
// rule syntax such as `Bash(git:*)`, or wildcards) are refused at
// construction: an unenforceable restriction never starts (P08).
import type { HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk'
import { AgentRuntimeError } from '../errors.js'
import type { ClaudePermissions } from '../options.js'

/** The restricted v1 read set. */
export const RESTRICTED_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const

/** The five tools the restricted profile names, plus Bash, denied entirely (no command allow-list in v1). */
export const RESTRICTED_DENIED_TOOLS = ['AskUserQuestion', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'] as const

/** Restricted v1: bypass mode, the read set, the named denials and Bash denied. */
export const RESTRICTED_CLAUDE_PERMISSIONS: ClaudePermissions = Object.freeze({
  mode: 'bypassPermissions',
  enabledTools: Object.freeze([...RESTRICTED_READ_TOOLS]),
  disallowedTools: Object.freeze([...RESTRICTED_DENIED_TOOLS]),
})

const MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'])
const EXACT_TOOL_NAME = /^[A-Za-z0-9_.-]+$/

function configurationError(message: string): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'configuration', message })
}

function toolNames(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw configurationError(`${field} must be an array of tool names`)
  for (const name of value) {
    if (typeof name !== 'string' || !EXACT_TOOL_NAME.test(name)) {
      throw configurationError(`${field} entry ${JSON.stringify(name)} is not an exact tool name; rules and wildcards cannot be enforced`)
    }
  }
  return [...value] as string[]
}

/** The decision the policy reaches for one tool: a denial reason, or null for no decision. */
export type ToolPolicy = (tool: string) => string | null

export interface ClaudePermissionComposition {
  /** SDK options that carry the policy; they override any caller-supplied value. */
  options: Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions' | 'disallowedTools'>
  /** The PreToolUse matcher, placed first among the session's PreToolUse hooks. */
  preToolUse: HookCallbackMatcher
  /** The pure decision, for tests and diagnostics. */
  decide: ToolPolicy
}

/**
 * Validate and compose one session's permissions. An explicit enabled-tool
 * list is exact: a bound host tool runs only when it is listed under its
 * `mcp__<namespace>__<tool>` name. A host that exempts its own tools lists them.
 */
export function composeClaudePermissions(permissions: ClaudePermissions): ClaudePermissionComposition {
  if (permissions === null || typeof permissions !== 'object') throw configurationError('permissions are required')
  if (!MODES.has(permissions.mode)) throw configurationError(`unknown permission mode ${JSON.stringify(permissions.mode)}`)
  const disallowed = new Set(toolNames('disallowedTools', permissions.disallowedTools))
  const enabled = permissions.enabledTools === 'all' ? null : new Set(toolNames('enabledTools', permissions.enabledTools))
  const decide: ToolPolicy = (tool) => {
    if (disallowed.has(tool)) return `${tool} is disallowed for this session`
    if (enabled && !enabled.has(tool)) return `${tool} is not enabled for this session`
    return null
  }
  const preToolUse: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {}
        const reason = decide(input.tool_name)
        if (reason === null) return {}
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
      },
    ],
  }
  return {
    options: {
      permissionMode: permissions.mode,
      // Explicit both ways: a caller's opt-in must not survive into a non-bypass session.
      allowDangerouslySkipPermissions: permissions.mode === 'bypassPermissions',
      disallowedTools: [...disallowed],
    },
    preToolUse,
    decide,
  }
}

/** Merge the policy into caller SDK options: policy fields win, the policy hook runs first. */
export function withPermissions(sdkOptions: Partial<Options>, composition: ClaudePermissionComposition): Partial<Options> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...sdkOptions.hooks }
  hooks.PreToolUse = [composition.preToolUse, ...(sdkOptions.hooks?.PreToolUse ?? [])]
  // allowedTools and canUseTool pass through: hooks run before allow rules,
  // so neither can re-grant a tool the policy denied.
  return { ...sdkOptions, ...composition.options, hooks }
}
