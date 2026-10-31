// Object ids are literal lowercase hex of the repository's format. This is
// deliberately separate from the result checker's permissive ref resolver.
import type { ObjectFormat } from './types'

export function isFullLiteral(value: unknown, format: ObjectFormat): value is string {
  return typeof value === 'string' && value.length === (format === 'sha256' ? 64 : 40)
    && !/[^0-9a-f]/.test(value)
}

/** Decode a Git config value, preserving quoted comment markers and escapes. */
function configValue(text: string): string | null {
  let quoted = false
  let value = ''
  // Trim syntax whitespace before removing quotes; quoted spaces are data.
  const source = text.trim()
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === '\\') {
      const escaped = source[++i]
      if (escaped === 'n') value += '\n'
      else if (escaped === 't') value += '\t'
      else if (escaped === 'b') value += '\b'
      else if (escaped === '"' || escaped === '\\') value += escaped
      else return null
    } else if (char === '"') quoted = !quoted
    else value += char
  }
  return quoted ? null : value
}

/** Comments end at a physical newline; only actual value backslashes fold. */
function logicalLines(text: string): string[] {
  const lines: string[] = []
  const source = text.replace(/\r\n/g, '\n')
  let line = ''
  let quoted = false
  let comment = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === '\n') {
      lines.push(line)
      line = ''
      comment = false
    } else if (comment) continue
    else if (char === '\\') {
      const next = source[i + 1]
      if (next === '\n') i++
      else { line += char; if (next !== undefined) { line += next; i++ } }
    } else if (char === '"') { quoted = !quoted; line += char }
    else if (!quoted && (char === '#' || char === ';')) comment = true
    else line += char
  }
  lines.push(line)
  return lines
}

/** Pure local-config interpretation; filesystem and repository checks are1.2. */
export function parseObjectFormat(text: string): ObjectFormat | null {
  let extensionSection = false
  let format: ObjectFormat | undefined
  for (const raw of logicalLines(text)) {
    const line = raw.trim()
    if (line === '' || /^[#;]/.test(line)) continue
    if (line.startsWith('[')) {
      const header = /^\[\s*([a-zA-Z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]\s*(?:[#;].*)?$/.exec(line)
      if (header === null) return null
      extensionSection = /^\[\s*extensions\s*\]/i.test(line)
      continue
    }
    if (!extensionSection) continue
    const pair = /^([a-zA-Z][a-zA-Z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line)
    if (pair === null) return null
    if (pair[1]!.toLowerCase() !== 'objectformat') continue
    const value = configValue(pair[2] ?? '')?.toLowerCase()
    if (value !== 'sha1' && value !== 'sha256') return null
    if (format !== undefined && format !== value) return null
    format = value
  }
  return format ?? 'sha1'
}
