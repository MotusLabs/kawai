// One group definition file (`.kawai/groups/<id>.md`): optional frontmatter
// between `---` fences, then a markdown body that is the group's role prompt.
// The frontmatter is a deliberately small YAML subset — flat `key: value`
// scalars, optionally quoted, `#` comment lines — so the parser needs no YAML
// dependency and an agent-written file cannot smuggle structure in. Known
// keys are validated; unknown keys are ignored so later changes (team tasks,
// profile routing) can add settings without breaking older readers.

export interface GroupDefinition {
  id: string
  /** Display name; the id when the file sets none. */
  label: string
  /** One line shown to other agents; empty when unset. */
  description: string
  /** Per-thread hop limit override (agent-mailbox); unset = default. */
  hopLimit?: number
  /** The role prompt appended to members' system prompts. */
  prompt: string
}

export type GroupFileParse =
  | { ok: true; group: GroupDefinition }
  | { ok: false; error: string }

const FENCE = /^---[ \t]*$/

/** Parse a group file's content; `id` comes from the file name. */
export function parseGroupFile(id: string, content: string): GroupFileParse {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/)
  let fields: Map<string, string> = new Map()
  let bodyStart = 0
  if (lines.length > 0 && FENCE.test(lines[0]!)) {
    const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
    if (close < 0) return { ok: false, error: 'frontmatter is not closed by ---' }
    const parsed = parseFields(lines.slice(1, close))
    if (!parsed.ok) return parsed
    fields = parsed.fields
    bodyStart = close + 1
  }

  const label = fields.get('label')?.trim()
  const description = fields.get('description')?.trim() ?? ''
  const rawHopLimit = fields.get('hopLimit')
  let hopLimit: number | undefined
  if (rawHopLimit !== undefined) {
    if (!/^[1-9]\d*$/.test(rawHopLimit.trim())) {
      return { ok: false, error: `hopLimit must be a positive integer, got "${rawHopLimit}"` }
    }
    hopLimit = Number(rawHopLimit.trim())
  }

  return {
    ok: true,
    group: {
      id,
      label: label || id,
      description,
      ...(hopLimit !== undefined ? { hopLimit } : {}),
      prompt: lines.slice(bodyStart).join('\n').trim(),
    },
  }
}

function parseFields(
  lines: string[]
): { ok: true; fields: Map<string, string> } | { ok: false; error: string } {
  const fields = new Map<string, string>()
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (!match) {
      return { ok: false, error: `frontmatter line ${index + 2} is not "key: value"` }
    }
    const key = match[1]!
    if (fields.has(key)) {
      return { ok: false, error: `frontmatter key "${key}" is repeated` }
    }
    const value = unquote(match[2]!.trim())
    if (value === null) {
      return { ok: false, error: `frontmatter value for "${key}" has an unterminated quote` }
    }
    fields.set(key, value)
  }
  return { ok: true, fields }
}

/** Strip one pair of matching quotes; null for an unbalanced quote. */
function unquote(value: string): string | null {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return value
  if (value.length < 2 || value[value.length - 1] !== quote) return null
  return value.slice(1, -1)
}
