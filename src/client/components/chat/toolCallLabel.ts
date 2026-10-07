// toolCallLabel.ts - Collapsed tool-call summary details.
// Maps each known tool to an ordered list of eligible input fields; the first
// non-blank string becomes the one-line detail (Bash prefers its description
// over its command), and path fields are shown relative to the chat session's
// project directory. Unknown tools and inputs with no usable field produce no
// detail, leaving the plain `Tool: <name>` label.

type ToolDetailFields = { fields: string[]; isPath: boolean }

const TOOL_DETAIL_FIELDS: Record<string, ToolDetailFields> = {
  Read: { fields: ['file_path'], isPath: true },
  Write: { fields: ['file_path'], isPath: true },
  Edit: { fields: ['file_path'], isPath: true },
  NotebookEdit: { fields: ['notebook_path'], isPath: true },
  Bash: { fields: ['description', 'command'], isPath: false },
  Glob: { fields: ['pattern'], isPath: false },
  Grep: { fields: ['pattern'], isPath: false },
  WebFetch: { fields: ['url'], isPath: false },
  WebSearch: { fields: ['query'], isPath: false },
  Agent: { fields: ['description'], isPath: false },
  Task: { fields: ['description'], isPath: false },
  Skill: { fields: ['skill'], isPath: false },
}

/**
 * The collapsed tool-call detail: the first eligible input field that is a
 * non-blank string, on one line, made project-relative for path fields. Null
 * means no detail — render the plain `Tool: <name>` label.
 */
export function toolCallDetail(tool: string, input: unknown, projectPath?: string): string | null {
  const entry = TOOL_DETAIL_FIELDS[tool]
  if (!entry) return null
  const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  for (const field of entry.fields) {
    const value = fields[field]
    if (typeof value !== 'string') continue
    const text = value.replace(/\r\n|\r|\n/g, ' ').trim()
    if (!text) continue
    return entry.isPath ? relativeToProject(text, projectPath) : text
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

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '') || '/'
