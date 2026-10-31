// Strict local Git config for dormant source resolution; includes and unknown
// extensions are refused. This never invokes Git or changes the protected1.1 API.
import { parseObjectFormat } from './objectFormat'
import type { ObjectFormat } from './types'
import type { SourceReason } from './readerTypes'

interface Entry { section: string; subsection: string | null; key: string; value: string | null }
export type RepositoryConfig = { ok: true; objectFormat: ObjectFormat; version: 0 | 1 }
  | { ok: false; reason: SourceReason }

function lines(text: string): string[] | null {
  const result: string[] = []
  const source = text.replace(/\r\n/g, '\n')
  if (/[\0\r]/.test(source)) return null
  let line = '', quoted = false, comment = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === '\n') {
      if (quoted) return null
      result.push(line); line = ''; comment = false
    } else if (comment) continue
    else if (char === '\\') {
      const next = source[++i]
      if (next === undefined) return null
      if (next !== '\n') line += char + next
    } else if (char === '"') { quoted = !quoted; line += char }
    else if (!quoted && (char === '#' || char === ';')) comment = true
    else line += char
  }
  if (quoted) return null
  result.push(line)
  return result
}

function valueOf(source: string): string | null {
  let value = '', quoted = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === '"') quoted = !quoted
    else if (char === '\\') {
      const escaped = source[++i]
      if (escaped === 'n') value += '\n'
      else if (escaped === 't') value += '\t'
      else if (escaped === 'b') value += '\b'
      else if (escaped === '"' || escaped === '\\') value += escaped
      else return null
    } else value += char
  }
  return quoted ? null : value
}

function entriesOf(text: string): Entry[] | null {
  const logical = lines(text)
  if (logical === null) return null
  const entries: Entry[] = []
  let section: string | null = null, subsection: string | null = null
  for (const raw of logical) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('[')) {
      const header = /^\[\s*([a-zA-Z0-9-]+)(?:\.([a-zA-Z0-9.-]+)|\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line)
      if (header === null) return null
      section = header[1]!.toLowerCase()
      subsection = header[2]?.toLowerCase() ?? (header[3] === undefined ? null : valueOf(header[3]))
      if (header[3] !== undefined && subsection === null) return null
      if (section === 'include' || section === 'includeif') return null
      continue
    }
    const pair = /^([a-zA-Z][a-zA-Z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line)
    if (pair === null || section === null) return null
    const value = pair[2] === undefined ? null : valueOf(pair[2])
    if (pair[2] !== undefined && value === null) return null
    entries.push({ section, subsection, key: pair[1]!.toLowerCase(), value })
  }
  return entries
}

function booleanValue(value: string | null): boolean | null {
  if (value === null || /^(true|yes|on|1)$/i.test(value)) return true
  if (/^(false|no|off|0|)$/i.test(value)) return false
  return null
}

export function parseRepositoryConfig(text: string): RepositoryConfig {
  const refused = { ok: false, reason: 'default-branch-unreadable' } as const
  const entries = entriesOf(text)
  const objectFormat = parseObjectFormat(text)
  if (entries === null || objectFormat === null) return refused
  let version: 0 | 1 | undefined, partial = false
  const extensions = new Map<string, string>()
  for (const entry of entries) {
    if (entry.section === 'core' && entry.subsection === null && entry.key === 'repositoryformatversion') {
      if (entry.value === null || !/^[01]$/.test(entry.value)) return refused
      const next = Number(entry.value) as 0 | 1
      if (version !== undefined && version !== next) return refused
      version = next
    }
    if (entry.section === 'extensions') {
      if (entry.subsection !== null) return refused
      if (entry.key === 'partialclone') partial = true
      else if (entry.key === 'objectformat' || entry.key === 'refstorage') {
        if (entry.value === null) return refused
        const value = entry.value.toLowerCase()
        if (extensions.has(entry.key) && extensions.get(entry.key) !== value) return refused
        extensions.set(entry.key, value)
        if (entry.key === 'refstorage' && value !== 'files') return refused
      } else return refused
    }
    if (entry.section === 'remote' && entry.subsection !== null) {
      if (entry.key === 'partialclonefilter') partial = true
      if (entry.key === 'promisor') {
        const value = booleanValue(entry.value)
        if (value === null) return refused
        partial ||= value
      }
    }
  }
  if (extensions.size > 0 && version !== 1) return refused
  if (partial) return { ok: false, reason: 'history-incomplete:partial' }
  return { ok: true, objectFormat, version: version ?? 0 }
}
