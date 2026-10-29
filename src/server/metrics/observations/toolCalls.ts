// Tool-call recognition and result classification (tool-call-metrics D4, D6),
// a dormant pure foundation: no caller, state, IO, or imports. Recognition
// names built-ins and exact kawai-team members; every other name yields only a
// coarse label — a foreign name still needs a slot from a later tracker-owned
// allocator, and an ambiguous one never gets one. Raw names and output text
// are read, never returned.

/** The closed CLI built-in vocabulary recognized by name (D4 rule 1). */
export const BUILT_IN_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Monitor', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'ToolSearch', 'Agent', 'Task', 'Skill', 'AskUserQuestion',
  'ExitPlanMode', 'TaskOutput', 'TaskCreate', 'TaskUpdate', 'TaskStop', 'EnterWorktree',
] as const

export type BuiltInTool = (typeof BUILT_IN_TOOLS)[number]

/** The 18 built-ins with an exact public export label (D8 allocation); the
 *  other recognized built-ins keep their identity but would export coarsely.
 *  Data only: no export mapping lives here. */
export const PUBLIC_BUILT_IN_LABELS = [
  'Bash', 'Monitor', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'ToolSearch', 'Agent', 'Task', 'Skill', 'AskUserQuestion',
  'ExitPlanMode', 'TaskOutput',
] as const satisfies readonly BuiltInTool[]

export const TEAM_TOOL_PREFIX = 'mcp__kawai-team__'

/** The team tool catalogue, supplied by its composition owner. Preconditions:
 *  `members` is ordinary side-effect-free set data of full prefixed names,
 *  each with a nonempty canonical suffix of at most 128 characters. */
export type TeamCatalogue = {
  readonly prefix: typeof TEAM_TOOL_PREFIX
  readonly members: ReadonlySet<string>
}

export type CoarseToolLabel = 'other' | 'mcp:other'

export type ToolRecognition =
  | { kind: 'builtin'; name: BuiltInTool }
  | { kind: 'team'; name: string }
  /** Unambiguous, but its identity needs a later owner's slot allocation. */
  | { kind: 'foreign'; label: CoarseToolLabel }
  | { kind: 'unknown'; reason: 'ambiguous'; label: CoarseToolLabel }

const MCP_PREFIX = 'mcp__'
const DYNAMIC_PREFIX = 'mcp__dynamic__'
const AMBIGUOUS_NAMES: readonly string[] = ['', 'echo', 'collabAgentToolCall', 'subAgentActivity']
const MAX_TEAM_NAME = 128

function separators(raw: string): number {
  let count = 0
  for (let at = raw.indexOf('__'); at !== -1; at = raw.indexOf('__', at + 2)) count++
  return count
}

function coarseLabel(raw: string): CoarseToolLabel {
  return raw.startsWith(MCP_PREFIX) && !raw.startsWith(TEAM_TOOL_PREFIX) ? 'mcp:other' : 'other'
}

/** The bounded identity of one raw tool name; first match wins (D4). */
export function recognizeTool(raw: string, catalogue: TeamCatalogue): ToolRecognition {
  if ((BUILT_IN_TOOLS as readonly string[]).includes(raw)) return { kind: 'builtin', name: raw as BuiltInTool }
  if (catalogue.prefix === TEAM_TOOL_PREFIX && raw.startsWith(TEAM_TOOL_PREFIX) && catalogue.members.has(raw)) {
    const name = raw.slice(TEAM_TOOL_PREFIX.length)
    if (name.length > 0 && name.length <= MAX_TEAM_NAME) return { kind: 'team', name }
  }
  const label = coarseLabel(raw)
  const mcp = raw.startsWith(MCP_PREFIX)
  if (
    raw.startsWith(DYNAMIC_PREFIX) ||
    AMBIGUOUS_NAMES.includes(raw) ||
    separators(raw) >= (mcp ? 4 : 2)
  ) {
    return { kind: 'unknown', reason: 'ambiguous', label }
  }
  return { kind: 'foreign', label }
}

export type FailureClass =
  | 'denied' | 'input-invalid' | 'unavailable' | 'blocked'
  | 'precondition' | 'refused' | 'command-failed' | 'other'

export type ClassifierRule =
  | 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7'
  | 'K8' | 'K9' | 'K10' | 'K11' | 'K12' | 'K13' | 'K14'

/** `not-supplied` means no trusted link was given, never that none denied. */
export type TrustedDenial = 'denied' | 'not-supplied'

export type ToolResultInput = {
  failed: boolean
  trustedDenial: TrustedDenial
  /** A value returned by recognizeTool. */
  tool: ToolRecognition
  output: string
}

/** A success carries no failure class at all (K0). */
export type ToolResultClass =
  | { outcome: 'success' }
  | { outcome: 'failed'; failureClass: FailureClass; rule: ClassifierRule }

const WRAPPER = '<tool_use_error>'
const NO_SUCH_TOOL = 'No such tool available'
const NO_SUCH_TOOL_WINDOW = 256

function failed(failureClass: FailureClass, rule: ClassifierRule): ToolResultClass {
  return { outcome: 'failed', failureClass, rule }
}

/** Prefix rules K2–K9, anchored at the start of the untrimmed output. */
function prefixRule(output: string): ToolResultClass | null {
  if (output.startsWith('Input validation error:')) return failed('input-invalid', 'K2')
  if (output.startsWith('Invalid arguments for ')) return failed('input-invalid', 'K3')
  if (output.startsWith('Unknown kawai-team tool: ')) return failed('unavailable', 'K4')
  if (output.startsWith(`${WRAPPER}Blocked:`)) return failed('blocked', 'K5')
  if (output.startsWith(`${WRAPPER}Unknown skill:`)) return failed('unavailable', 'K6')
  if (output.startsWith(WRAPPER) && output.slice(0, NO_SUCH_TOOL_WINDOW).includes(NO_SUCH_TOOL)) {
    return failed('unavailable', 'K7')
  }
  if (output.startsWith('Tool references removed')) return failed('unavailable', 'K8')
  if (output.startsWith(WRAPPER)) return failed('precondition', 'K9')
  return null
}

function isBuiltIn(tool: ToolRecognition, name: BuiltInTool): boolean {
  return tool.kind === 'builtin' && tool.name === name
}

/** The class of one tool result; the first matching rule wins (D6). */
export function classifyToolResult(input: ToolResultInput): ToolResultClass {
  if (!input.failed) return { outcome: 'success' }
  const { tool, output } = input
  if (input.trustedDenial === 'denied') return failed('denied', 'K1')
  const prefixed = prefixRule(output)
  if (prefixed) return prefixed
  if (tool.kind === 'team' && output.startsWith('Refused: ')) return failed('refused', 'K10')
  if (isBuiltIn(tool, 'Bash') && output.startsWith('The command was declined.')) return failed('denied', 'K11')
  if (isBuiltIn(tool, 'Edit') && output.startsWith('The file change declined.')) return failed('denied', 'K12')
  if (isBuiltIn(tool, 'Bash') || isBuiltIn(tool, 'Monitor')) return failed('command-failed', 'K13')
  return failed('other', 'K14')
}
