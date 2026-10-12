import { describe, expect, test } from 'bun:test'
import type { ChatCommand } from '@shared/chat'
import {
  filterChatCommands,
  insertCommand,
  slashTokenAt,
} from '../components/chat/slashCommandFilter'

const command = (
  name: string,
  description: string,
  aliases: string[] = []
): ChatCommand => ({ name, description, aliases, source: 'builtin' })

const COMMANDS = [
  command('review', 'Review the diff'),
  command('context', 'Show context usage', ['ctx']),
  command('compact', 'Compact the conversation'),
  command('resume', 'Resume a past session'),
]

describe('slashTokenAt', () => {
  test('finds the slash word at the caret at the start or after whitespace', () => {
    expect(slashTokenAt('/re', 3)).toEqual({ start: 0, end: 3, query: '/re' })
    expect(slashTokenAt('/', 1)).toEqual({ start: 0, end: 1, query: '/' })
    expect(slashTokenAt('run /re', 7)).toEqual({ start: 4, end: 7, query: '/re' })
    expect(slashTokenAt('run\t/re', 7)).toEqual({ start: 4, end: 7, query: '/re' })
    expect(slashTokenAt('one\n/re', 7)).toEqual({ start: 4, end: 7, query: '/re' })
    // A slash word at the start of a second line (text ending mid-line).
    expect(slashTokenAt('one\ntwo /', 9)).toEqual({ start: 8, end: 9, query: '/' })
  })

  test('caret mid-word: query stops at the caret, end covers the rest of the word', () => {
    expect(slashTokenAt('/review', 3)).toEqual({ start: 0, end: 7, query: '/re' })
    expect(slashTokenAt('run /review now', 7)).toEqual({ start: 4, end: 11, query: '/re' })
  })

  test('stays closed inside plain words, a/b, URLs, and paths', () => {
    expect(slashTokenAt('', 0)).toBeNull()
    expect(slashTokenAt('hello', 5)).toBeNull()
    expect(slashTokenAt('a/b', 3)).toBeNull()
    expect(slashTokenAt('https://x', 9)).toBeNull()
    expect(slashTokenAt('/usr/bin', 8)).toBeNull()
    expect(slashTokenAt('/usr/', 5)).toBeNull()
    expect(slashTokenAt('see /usr/bin here', 12)).toBeNull()
  })

  test('stays closed once args are typed or the caret is outside any slash word', () => {
    // Caret past the argument word.
    expect(slashTokenAt('/review x', 9)).toBeNull()
    // Caret inside the argument word.
    expect(slashTokenAt('run /review and more', 14)).toBeNull()
    // Caret before the slash, or out of range.
    expect(slashTokenAt('run /re', 4)).toBeNull()
    expect(slashTokenAt('/re', 0)).toBeNull()
    expect(slashTokenAt('/re', 9)).toBeNull()
  })
})

describe('insertCommand', () => {
  test('an empty message becomes /name with the caret at the end', () => {
    expect(insertCommand('', slashTokenAt('/', 1)!, 'review')).toEqual({
      text: '/review ',
      caret: 8,
    })
  })

  test('mid-message with following text keeps a single space', () => {
    const token = slashTokenAt('please run /re on this', 13)!
    expect(insertCommand('please run /re on this', token, 'review')).toEqual({
      text: 'please run /review on this',
      caret: 19,
    })
  })

  test('a caret mid-word replaces the whole word', () => {
    const text = '/rev later'
    expect(insertCommand(text, slashTokenAt(text, 4)!, 'review')).toEqual({
      text: '/review later',
      caret: 8,
    })
  })
})

describe('filterChatCommands', () => {
  test('empty query returns every command in server order', () => {
    expect(filterChatCommands(COMMANDS, '/')).toEqual(COMMANDS)
    expect(filterChatCommands(COMMANDS, '')).toEqual(COMMANDS)
  })

  test('ranks name prefix, alias prefix, name substring, description substring', () => {
    const matches = filterChatCommands(COMMANDS, '/re')
    // review (name prefix) before context (description "past session"? no —
    // 're' in description of resume: "Resume a past session" has name prefix
    // too), so: review, resume (prefixes), then description matches: none —
    // 're' appears in no other description.
    expect(matches.map((c) => c.name)).toEqual(['review', 'resume'])
  })

  test('alias prefix outranks name substring', () => {
    // 'ctx' is an alias of context; no other name contains it.
    expect(filterChatCommands(COMMANDS, '/ctx').map((c) => c.name)).toEqual([
      'context',
    ])
  })

  test('description substring matches last', () => {
    // 'conversation' only appears in compact's description.
    expect(
      filterChatCommands(COMMANDS, '/conversation').map((c) => c.name)
    ).toEqual(['compact'])
  })

  test('matching is case-insensitive on both sides', () => {
    expect(filterChatCommands(COMMANDS, '/RE').map((c) => c.name)).toEqual([
      'review',
      'resume',
    ])
    const lower = [command('statusline', 'Prompt setup')]
    expect(filterChatCommands(lower, '/STATUS')).toEqual(lower)
  })

  test('no match yields an empty list (Enter must fall through)', () => {
    expect(filterChatCommands(COMMANDS, '/zzz')).toEqual([])
  })
})
