// toolCallLabel.ts - Collapsed tool-entry handles.
// Maps each known tool to the one input field that orients a scan: the first
// non-blank string of its designated fields. Path fields are shown relative
// to the chat session's project directory, TaskUpdate and AskUserQuestion
// format their input, and Bash prefers its description over its command
// without composing the two. Unknown tools and inputs with no usable field
// produce no handle, leaving the bare `<toolName>` label.

type ToolHandleFieldRule = {
  fields: string[]
  /** Fields shown relative to the project path (a subset of `fields`). */
  pathFields?: string[]
}

type ToolHandleSpec =
  | ToolHandleFieldRule
  | { format: (input: Record<string, unknown>) => string | null }

const TOOL_HANDLES: Record<string, ToolHandleSpec> = {
  Read: { fields: ['file_path'], pathFields: ['file_path'] },
  Write: { fields: ['file_path'], pathFields: ['file_path'] },
  Edit: { fields: ['file_path'], pathFields: ['file_path'] },
  NotebookEdit: { fields: ['notebook_path'], pathFields: ['notebook_path'] },
  // Intent over mechanism: the description orients, the command stays on
  // hover and behind the expand.
  Bash: { fields: ['description', 'command'] },
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
 * The collapsed tool-entry handle: the tool's first usable designated field
 * on one line, paths relative to the project. Null means no handle — render
 * the bare `<toolName>` label.
 */
export function toolCallHandle(tool: string, input: unknown, projectPath?: string): string | null {
  const spec = TOOL_HANDLES[tool]
  if (!spec) return null
  const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  if ('format' in spec) return spec.format(fields)
  for (const field of spec.fields) {
    const text = usableText(fields[field])
    if (text === null) continue
    return spec.pathFields?.includes(field) ? relativeToProject(text, projectPath) : text
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

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '') || '/'
