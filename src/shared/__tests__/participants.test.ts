// Naming a participant (team-message-threads D3): live sessions win over the
// directory, the directory answers for killed ones, and anything else is the
// raw id marked gone. Resolving never creates or restores a session — `gone`
// is what tells the view not to navigate.
import { describe, expect, test } from 'bun:test'
import {
  humanParticipant,
  participantName,
  resolveParticipant,
  type LiveParticipant,
} from '../participants'
import type { SessionDirectoryEntry } from '../team'

const live: LiveParticipant = { id: 'chat-1', name: 'Export button', groupId: 'devs' }
const archived: LiveParticipant = { id: 'chat-2', name: 'Old work', groupId: 'qa' }
const sessions: LiveParticipant[] = [live, archived]
const directory: SessionDirectoryEntry[] = [
  { sessionId: 'chat-1', name: 'Export button', group: 'devs' },
  { sessionId: 'chat-3', name: 'Killed helper', group: 'devs' },
]

describe('resolveParticipant', () => {
  test('a live session is authoritative and not gone', () => {
    expect(resolveParticipant('chat-1', sessions, directory)).toEqual({
      id: 'chat-1', name: 'Export button', group: 'devs', gone: false,
    })
  })

  test('an archived session keeps its live name and is not gone', () => {
    // Archived rows stay in `sessions`; only a kill removes them, and that is
    // what makes a participant gone.
    expect(resolveParticipant('chat-2', sessions, directory)).toEqual({
      id: 'chat-2', name: 'Old work', group: 'qa', gone: false,
    })
  })

  test('a killed session keeps its recorded name and role, marked gone', () => {
    expect(resolveParticipant('chat-3', sessions, directory)).toEqual({
      id: 'chat-3', name: 'Killed helper', group: 'devs', gone: true,
    })
  })

  test('a never-seen session is its raw id, marked gone', () => {
    expect(resolveParticipant('chat-never', sessions, directory)).toEqual({
      id: 'chat-never', name: 'chat-never', group: null, gone: true,
    })
  })

  test('the directory never resurrects a session the live list dropped', () => {
    // chat-1 is killed: it leaves `sessions` but keeps its directory row.
    const afterKill = resolveParticipant('chat-1', [], directory)
    expect(afterKill).toEqual({ id: 'chat-1', name: 'Export button', group: 'devs', gone: true })
    expect(participantName(afterKill)).toBe('Export button (gone)')
  })

  test('a live row beats a stale directory row', () => {
    const renamed: LiveParticipant[] = [{ id: 'chat-1', name: 'Renamed', groupId: 'qa' }]
    expect(resolveParticipant('chat-1', renamed, directory)).toEqual({
      id: 'chat-1', name: 'Renamed', group: 'qa', gone: false,
    })
  })
})

describe('participantName', () => {
  test('a live participant renders its name alone', () => {
    expect(participantName({ id: 'chat-1', name: 'Export button', group: 'devs', gone: false }))
      .toBe('Export button')
  })

  test('a gone participant keeps its name with the unavailable mark', () => {
    expect(participantName({ id: 'chat-3', name: 'Killed helper', group: 'devs', gone: true }))
      .toBe('Killed helper (gone)')
    expect(participantName({ id: 'x', name: 'x', group: null, gone: true })).toBe('x (gone)')
  })
})

describe('humanParticipant', () => {
  test('the human has no session and labels as Human', () => {
    expect(humanParticipant()).toEqual({ id: null, name: 'Human', group: null, gone: false })
    expect(participantName(humanParticipant())).toBe('Human')
  })
})
