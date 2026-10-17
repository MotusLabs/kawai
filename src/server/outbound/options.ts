// One option scanner for every command the classifier models
// (execution-safety-recovery D4, check 2 "known shape"): it reads options in
// every spelling a GNU- or pflag-style tool accepts — `-C dir`, `-Cdir`,
// `--chdir=dir`, `--chdir dir`, and clustered short flags (`-iC dir`) —
// against a per-tool arity table. An option the table does not list stops
// the scan: the caller never guesses its arity, so an unmodeled spelling can
// cost precision but never shift a later word into the wrong position. A
// non-literal word where an option could stand is reported, because it may
// expand into one. Pure.
import type { Word } from './tokenize'

/** 0: a flag; 1: takes a value; 'optional': takes one only when attached (`--x=v`). */
export type Arity = 0 | 1 | 'optional'
export type OptionTable = Readonly<Record<string, Arity>>

export interface ScannedOption {
  name: string
  value: Word | null
}

export interface Scanned {
  options: ScannedOption[]
  positionals: Word[]
  /** The first option the table does not list, or null. */
  unknown: string | null
  /** A non-literal word stood where an option could. */
  opaque: boolean
  /** With `stopAtPositional`: the index of the first positional (the wrapped command). */
  end: number
}

/** Build a table from space-separated flag names, value-taking names, and optional-value names. */
export function table(flags: string, values = '', optional = ''): OptionTable {
  const entries: Record<string, Arity> = {}
  for (const name of flags.split(/\s+/).filter(Boolean)) entries[name] = 0
  for (const name of values.split(/\s+/).filter(Boolean)) entries[name] = 1
  for (const name of optional.split(/\s+/).filter(Boolean)) entries[name] = 'optional'
  return entries
}

/** Merge tables; later ones win. */
export function merge(...tables: OptionTable[]): OptionTable {
  return Object.assign({}, ...tables) as OptionTable
}

/** Values every scanned option named `names` carried. */
export function valuesOf(scanned: Scanned, ...names: string[]): Word[] {
  return scanned.options.filter(option => names.includes(option.name) && option.value !== null).map(option => option.value!)
}

export function hasOption(scanned: Scanned, ...names: string[]): boolean {
  return scanned.options.some(option => names.includes(option.name))
}

/**
 * Scan `words` from `start`. With `stopAtPositional` (wrappers) the scan ends
 * at the first positional or after `--`; otherwise options and positionals
 * interleave, as GNU tools permute them, until `--`. `pflag` (Go tools: gh,
 * docker, podman, helm) accepts `--flag=true|false` for a flag.
 */
export function scanOptions(words: readonly Word[], start: number, options: OptionTable, stopAtPositional = false, pflag = false): Scanned {
  const result: Scanned = { options: [], positionals: [], unknown: null, opaque: false, end: words.length }
  let onlyPositionals = false
  for (let i = start; i < words.length; i++) {
    const word = words[i]!
    const text = word.text
    // An expansion or glob at the word's start can expand into an option.
    if (!onlyPositionals && !word.literal && !/^[A-Za-z0-9_./:@%+,=-]/.test(text)) result.opaque = true
    if (!onlyPositionals && text === '--') {
      onlyPositionals = true
      if (stopAtPositional) { result.end = i + 1; return result }
      continue
    }
    if (!onlyPositionals && text.startsWith('--') && text.length > 2) {
      const eq = text.indexOf('=')
      const name = eq === -1 ? text : text.slice(0, eq)
      const arity = options[name]
      // Go's pflag also spells a flag `--flag=true` or `--flag=false`; the value is kept.
      const boolValue = pflag && arity === 0 && /^=(true|false)$/.test(text.slice(eq))
      if (arity === undefined || (arity === 0 && eq !== -1 && !boolValue)) { result.unknown = name; result.end = i; return result }
      if (arity === 0) { result.options.push({ name, value: boolValue ? { ...word, text: text.slice(eq + 1) } : null }); continue }
      if (eq !== -1) {
        result.options.push({ name, value: { ...word, text: text.slice(eq + 1) } })
        continue
      }
      if (arity === 'optional') { result.options.push({ name, value: null }); continue }
      const value = words[i + 1] ?? null
      result.options.push({ name, value })
      i++
      continue
    }
    if (!onlyPositionals && text.startsWith('-') && text.length > 1) {
      for (let at = 1; at < text.length; at++) {
        const name = `-${text[at]!}`
        const arity = options[name]
        if (arity === undefined) { result.unknown = name; result.end = i; return result }
        if (arity === 0) { result.options.push({ name, value: null }); continue }
        const rest = text.slice(at + 1)
        if (rest !== '') result.options.push({ name, value: { ...word, text: rest } })
        else if (arity === 'optional') result.options.push({ name, value: null })
        else { result.options.push({ name, value: words[i + 1] ?? null }); i++ }
        break
      }
      continue
    }
    if (stopAtPositional) { result.end = i; return result }
    result.positionals.push(word)
  }
  return result
}
