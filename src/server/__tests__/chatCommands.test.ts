import { describe, expect, test } from 'bun:test'
import type { ChatCommand } from '../../shared/chat'
import {
  ChatCommandTracker,
  FALLBACK_TERMINAL_COMMANDS,
  normalizeChatCommands,
  type RawChatCommand,
} from '../chat/chatCommands'
import { RECORDED_COMMANDS } from './fixtures/claudeCommands'

const terminal = (names: readonly string[]) => new Set(names)

const command = (name: string, source: ChatCommand['source']): ChatCommand => ({
  name,
  description: `${name} description`,
  aliases: [],
  source,
})

describe('normalizeChatCommands', () => {
  test('derives source from the builtin marker and the project suffix', () => {
    const normalized = normalizeChatCommands(
      [
        {
          name: 'clear',
          description: 'Start a new session',
          argumentHint: '[name]',
          aliases: ['reset', 'new'],
          builtin: true,
        },
        {
          name: 'openspec-explore',
          description: 'Explore ideas. (project)',
          argumentHint: '',
        },
        { name: 'my-skill', description: 'A user skill' },
      ],
      terminal([])
    )
    expect(normalized).toEqual([
      {
        name: 'clear',
        description: 'Start a new session',
        argumentHint: '[name]',
        aliases: ['reset', 'new'],
        source: 'builtin',
      },
      // The ` (project)` suffix is folded into the source, not shown.
      {
        name: 'openspec-explore',
        description: 'Explore ideas.',
        source: 'project',
        aliases: [],
      },
      { name: 'my-skill', description: 'A user skill', aliases: [], source: 'user' },
    ])
  })

  test('hides internal and terminal-bound commands', () => {
    const normalized = normalizeChatCommands(
      [
        { name: '__remote-workflow', description: 'internal' },
        { name: 'doctor', description: 'terminal-bound', builtin: true },
        { name: 'usage', description: 'fine', builtin: true },
      ],
      terminal(['doctor'])
    )
    expect(normalized.map((c) => c.name)).toEqual(['usage'])
  })

  test('builtin wins a name collision', () => {
    const normalized = normalizeChatCommands(
      [
        { name: 'compact', description: 'project override (project)' },
        { name: 'compact', description: 'built in', builtin: true },
      ],
      terminal([])
    )
    expect(normalized).toEqual([
      { name: 'compact', description: 'built in', aliases: [], source: 'builtin' },
    ])
    // The unmarked row wins only when no marked row carries the name.
    const reversed = normalizeChatCommands(
      [
        { name: 'compact', description: 'built in', builtin: true },
        { name: 'compact', description: 'project override (project)' },
      ],
      terminal([])
    )
    expect(reversed).toEqual([
      { name: 'compact', description: 'built in', aliases: [], source: 'builtin' },
    ])
  })

  test('normalizes the recorded 60-command list from a real process', () => {
    const normalized = normalizeChatCommands(RECORDED_COMMANDS, terminal([]))
    const names = normalized.map((c) => c.name)
    // The fallback terminal set is hidden even without init's report.
    expect(names).not.toContain('__remote-workflow')
    // A project command survives with the suffix stripped.
    const explore = normalized.find((c) => c.name === 'openspec-explore')
    expect(explore).toMatchObject({ source: 'project' })
    expect(explore?.description.endsWith(' (project)')).toBe(false)
    // clear keeps its aliases and hint; usage is builtin.
    expect(normalized.find((c) => c.name === 'clear')).toMatchObject({
      aliases: ['reset', 'new'],
      argumentHint: '[name]',
      source: 'builtin',
    })
    expect(normalized.find((c) => c.name === 'usage')).toMatchObject({
      source: 'builtin',
    })
    // No duplicates.
    expect(new Set(names).size).toBe(names.length)
  })

  test('FALLBACK_TERMINAL_COMMANDS hide the observed terminal-bound set', () => {
    const normalized = normalizeChatCommands(
      RECORDED_COMMANDS,
      terminal(FALLBACK_TERMINAL_COMMANDS)
    )
    for (const name of FALLBACK_TERMINAL_COMMANDS) {
      expect(normalized.map((c) => c.name)).not.toContain(name)
    }
  })
})

describe('ChatCommandTracker', () => {
  const raw = (name: string): RawChatCommand => ({
    name,
    description: `${name} description`,
    builtin: true,
  })

  test('transitions loading -> ready and publishes each change once', () => {
    const states: string[] = []
    const tracker = new ChatCommandTracker((state) => states.push(state.status))
    expect(tracker.state).toEqual({ status: 'loading', commands: [] })

    tracker.beginLoading()
    expect(states).toEqual(['loading'])

    tracker.applyCommands([raw('clear')])
    expect(states).toEqual(['loading', 'ready'])
    expect(tracker.state).toEqual({
      status: 'ready',
      commands: [command('clear', 'builtin')],
    })

    // The identical list again: no publication.
    tracker.applyCommands([raw('clear')])
    expect(states).toEqual(['loading', 'ready'])
  })

  test('a changed list replaces the old one and publishes', () => {
    const published: ChatCommand[][] = []
    const tracker = new ChatCommandTracker((state) => published.push(state.commands))
    tracker.applyCommands([raw('clear'), raw('usage')])
    tracker.applyCommands([raw('usage')])
    expect(published).toHaveLength(2)
    expect(published[1]?.map((c) => c.name)).toEqual(['usage'])
  })

  test('init replaces the fallback terminal set and re-publishes', () => {
    const published: ChatCommand[][] = []
    const tracker = new ChatCommandTracker((state) => published.push(state.commands))
    tracker.applyCommands([
      raw('doctor'),
      raw('statusline'),
      { name: 'vim', description: 'editor' },
    ])
    // Fallback hides doctor but not vim/statusline.
    expect(published.at(-1)?.map((c) => c.name)).toEqual(['statusline', 'vim'])

    // init reports doctor AND vim as terminal-bound: both disappear, and the
    // change re-publishes the same list contents minus the newly hidden row.
    tracker.applyTerminalCommands(['doctor', 'vim'])
    expect(published.at(-1)?.map((c) => c.name)).toEqual(['statusline'])

    // A pre-field init (undefined) changes nothing.
    tracker.applyTerminalCommands(undefined)
    expect(published).toHaveLength(2)
  })

  test('a terminal set identical in effect publishes nothing', () => {
    const published: ChatCommand[][] = []
    const tracker = new ChatCommandTracker((state) => published.push(state.commands))
    tracker.applyCommands([raw('clear')])
    expect(published).toHaveLength(1)
    // Same set as the fallback for this list: no change, no publication.
    tracker.applyTerminalCommands([...FALLBACK_TERMINAL_COMMANDS])
    expect(published).toHaveLength(1)
  })

  test('markUnavailable publishes only when the status actually flips', () => {
    const states: string[] = []
    const tracker = new ChatCommandTracker((state) => states.push(state.status))
    tracker.markUnavailable()
    expect(states).toEqual(['unavailable'])
    tracker.markUnavailable()
    expect(states).toEqual(['unavailable'])
  })
})
