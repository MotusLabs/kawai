import { describe, expect, test } from 'bun:test'
import type { ChatCommand } from '@shared/chat'
import {
  filterChatCommands,
  slashMenuQuery,
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

describe('slashMenuQuery', () => {
  test('opens on a bare slash command being typed, closes once args start', () => {
    expect(slashMenuQuery('')).toBeNull()
    expect(slashMenuQuery('hello')).toBeNull()
    expect(slashMenuQuery('/')).toBe('/')
    expect(slashMenuQuery('/re')).toBe('/re')
    expect(slashMenuQuery('/review ')).toBeNull() // args typed: closed
    expect(slashMenuQuery(' /re')).toBeNull() // not at the start
    expect(slashMenuQuery('/two words')).toBeNull()
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
