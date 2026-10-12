// One group definition file (`.kawai/groups/<id>.md`): optional frontmatter
// between `---` fences, then a markdown body that is the group's role prompt.
// The frontmatter is a deliberately small YAML subset — flat `key: value`
// scalars, optionally quoted, `#` comment lines — so the parser needs no YAML
// dependency and an agent-written file cannot smuggle structure in. Known
// keys are validated; unknown keys are ignored so later changes (profile
// routing) can add settings without breaking older readers. Team tasks add
// `canCreateTasks`, `max`, `profile`, and `approval` (team-tasks design D2/D6):
// defaults are applied here so every reader sees the same effective values.
import type { ChatApprovalPolicy } from '../../shared/chat'
import { PROFILE_ID_PATTERN } from '../chat/profileCatalog'

export interface GroupDefinition {
  id: string
  /** Display name; the id when the file sets none. */
  label: string
  /** One line shown to other agents; empty when unset. */
  description: string
  /** Per-thread hop limit override (agent-mailbox); unset = default. */
  hopLimit?: number
  /** Members may create team tasks (team-tasks); default false. */
  canCreateTasks: boolean
  /** Live-member cap for worktree staffing spawns; default 1. */
  max: number
  /** Profile for spawned members; unset = the default profile. */
  profile?: string
  /** Approval policy for spawned members; default manual. */
  approval: ChatApprovalPolicy
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
  const settings = parseTaskSettings(fields)
  if (!settings.ok) return settings

  return {
    ok: true,
    group: {
      id,
      label: label || id,
      description,
      ...(hopLimit !== undefined ? { hopLimit } : {}),
      ...settings.settings,
      prompt: lines.slice(bodyStart).join('\n').trim(),
    },
  }
}

type TaskSettings = Pick<GroupDefinition, 'canCreateTasks' | 'max' | 'profile' | 'approval'>

function parseTaskSettings(
  fields: Map<string, string>
): { ok: true; settings: TaskSettings } | { ok: false; error: string } {
  const settings: TaskSettings = { canCreateTasks: false, max: 1, approval: 'manual' }
  const canCreate = fields.get('canCreateTasks')?.trim()
  if (canCreate !== undefined) {
    if (canCreate !== 'true' && canCreate !== 'false') {
      return { ok: false, error: `canCreateTasks must be true or false, got "${canCreate}"` }
    }
    settings.canCreateTasks = canCreate === 'true'
  }
  const max = fields.get('max')?.trim()
  if (max !== undefined) {
    if (!/^[1-9]\d*$/.test(max)) return { ok: false, error: `max must be a positive integer, got "${max}"` }
    settings.max = Number(max)
  }
  const profile = fields.get('profile')?.trim()
  if (profile !== undefined) {
    if (!PROFILE_ID_PATTERN.test(profile)) return { ok: false, error: `profile "${profile}" is not a valid profile id` }
    settings.profile = profile
  }
  const approval = fields.get('approval')?.trim()
  if (approval !== undefined) {
    if (approval !== 'manual' && approval !== 'auto') {
      return { ok: false, error: `approval must be manual or auto, got "${approval}"` }
    }
    settings.approval = approval
  }
  return { ok: true, settings }
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
