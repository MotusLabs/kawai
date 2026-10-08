// toolCallLabel.ts - Collapsed tool-call summary details.
// Maps each known tool to the input fields that make a one-line detail: the
// first non-blank string per field, or every usable field joined for tools
// whose parts read better together (Bash composes `description — command`).
// Path fields are shown relative to the chat session's project directory,
// Edit and Write append a git-style line delta, TaskUpdate and
// AskUserQuestion format their input, and a tool result hints with its first
// non-blank output line. Unknown tools and inputs with no usable part produce
// no detail, leaving the plain `Tool: <name>` label.

type ToolDetailFieldRule = {
  fields: string[]
  /** Fields shown relative to the project path (a subset of `fields`). */
  pathFields?: string[]
  /** Keep every usable field, joined by this. Default: first usable only. */
  join?: string
  /** Append `+added −removed` from these inputs' line counts. */
  lineDelta?: { added?: string; removed?: string }
}

type ToolDetailSpec =
  | ToolDetailFieldRule
  | { format: (input: Record<string, unknown>) => string | null }

const TOOL_DETAILS: Record<string, ToolDetailSpec> = {
  Read: { fields: ['file_path'], pathFields: ['file_path'] },
  Write: { fields: ['file_path'], pathFields: ['file_path'], lineDelta: { added: 'content' } },
  Edit: { fields: ['file_path'], pathFields: ['file_path'], lineDelta: { added: 'new_string', removed: 'old_string' } },
  NotebookEdit: { fields: ['notebook_path'], pathFields: ['notebook_path'] },
  Bash: { fields: ['description', 'command'], join: ' — ' },
  Glob: { fields: ['pattern'] },
  Grep: { fields: ['pattern'] },
  WebFetch: { fields: ['url'] },
  WebSearch: { fields: ['query'] },
  ToolSearch: { fields: ['query'] },
  Agent: { fields: ['description'] },
  Task: { fields: ['description'] },
  Monitor: { fields: ['description'] },
  Skill: { fields: ['skill'] },
  TaskCreate: { fields: ['subject'] },
  TaskStop: { fields: ['task_id'] },
  TaskOutput: { fields: ['task_id'] },
  // `path` is relativized, `name` never is; `path` wins when both are usable.
  EnterWorktree: { fields: ['path', 'name'], pathFields: ['path'] },
  // Never `plan`, which is a whole markdown document.
  ExitPlanMode: { fields: ['planFilePath'], pathFields: ['planFilePath'] },
  TaskUpdate: { format: formatTaskUpdate },
  AskUserQuestion: { format: formatAskUserQuestion },
}

/**
 * The collapsed tool-call detail: the tool's usable input fields on one line,
 * paths relative to the project and Edit/Write deltas appended. Null means no
 * detail — render the plain `Tool: <name>` label.
 */
export function toolCallDetail(tool: string, input: unknown, projectPath?: string): string | null {
  const spec = TOOL_DETAILS[tool]
  if (!spec) return null
  const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  if ('format' in spec) return spec.format(fields)
  const parts: string[] = []
  for (const field of spec.fields) {
    const text = usableText(fields[field])
    if (text === null) continue
    parts.push(spec.pathFields?.includes(field) ? relativeToProject(text, projectPath) : text)
    if (!spec.join) break
  }
  if (parts.length === 0) return null
  const base = spec.join ? parts.join(spec.join) : parts[0]!
  const delta = spec.lineDelta === undefined ? '' : lineDeltaSuffix(fields, spec.lineDelta)
  return delta ? `${base} ${delta}` : base
}

/**
 * The collapsed tool-result hint: the output's first non-blank line, on one
 * line. Null means no hint — render the plain `Tool result` / `Tool failed`
 * label.
 */
export function toolResultDetail(output: string): string | null {
  for (const line of output.split('\n')) {
    const text = line.replace(/\r/g, ' ').trim()
    if (text) return text
  }
  return null
}

/**
 * `path` shown relative to `projectPath` when inside it: equal paths (after
 * removing trailing slashes) become `.`, a `<project>/` prefix is removed,
 * and anything else — outside, sharing only a name prefix, or relative — is
 * returned unchanged.
 */
export function relativeToProject(path: string, projectPath?: string): string {
  if (!projectPath) return path
  const project = stripTrailingSlashes(projectPath)
  const target = stripTrailingSlashes(path)
  if (target === project) return '.'
  const prefix = project === '/' ? '/' : `${project}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : path
}

/** `Task <taskId> → <status>`, dropping the half that is missing. */
function formatTaskUpdate(input: Record<string, unknown>): string | null {
  const taskId = usableText(input.taskId)
  const status = usableText(input.status)
  if (taskId === null && status === null) return null
  if (taskId === null) return `→ ${status}`
  if (status === null) return `Task ${taskId}`
  return `Task ${taskId} → ${status}`
}

/** The first question's `header`, with a question count past one question. */
function formatAskUserQuestion(input: Record<string, unknown>): string | null {
  if (!Array.isArray(input.questions)) return null
  const first = input.questions[0]
  const header = typeof first === 'object' && first !== null ? usableText((first as Record<string, unknown>).header) : null
  if (header === null) return null
  return input.questions.length > 1 ? `${header} · ${input.questions.length} questions` : header
}

const usableText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n|\r|\n/g, ' ').trim()
  return text || null
}

/** `+added −removed` with U+2212; a zero side is omitted, and both zero yields ''. */
const lineDeltaSuffix = (input: Record<string, unknown>, delta: { added?: string; removed?: string }): string => {
  const added = delta.added === undefined ? 0 : lineCount(input[delta.added])
  const removed = delta.removed === undefined ? 0 : lineCount(input[delta.removed])
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`−${removed}`)
  return parts.join(' ')
}

/** Line count: `\n`-separated segments after dropping one trailing newline; 0 for empty. */
const lineCount = (value: unknown): number => {
  if (typeof value !== 'string' || value === '') return 0
  return (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n').length
}

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '') || '/'
