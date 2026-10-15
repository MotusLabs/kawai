import { describe, expect, test } from 'bun:test'
import { decideTransitionSounds } from '../utils/soundTransitions'

// Scenarios from openspec/changes/skip-idle-sound-for-selected-session/
// specs/notification-sounds/spec.md

const PERM = true
const IDLE = true

describe('decideTransitionSounds', () => {
  test('background session finishing plays the idle sound', () => {
    expect(decideTransitionSounds('working', 'waiting', false, true, PERM, IDLE)).toEqual({
      permission: false,
      idle: true,
    })
  })

  test('idle sound disabled plays nothing', () => {
    expect(decideTransitionSounds('working', 'waiting', false, true, PERM, false)).toEqual({
      permission: false,
      idle: false,
    })
  })

  test('newly appearing session (no previous status) plays nothing', () => {
    expect(decideTransitionSounds(undefined, 'waiting', false, true, PERM, IDLE)).toEqual({
      permission: false,
      idle: false,
    })
  })

  test('selected session finishing while the page is visible is suppressed', () => {
    expect(decideTransitionSounds('working', 'waiting', true, true, PERM, IDLE)).toEqual({
      permission: false,
      idle: false,
    })
  })

  test('selected session finishing in a hidden tab still plays', () => {
    expect(decideTransitionSounds('working', 'waiting', true, false, PERM, IDLE)).toEqual({
      permission: false,
      idle: true,
    })
  })

  test('selected and background sessions finishing together — background still plays', () => {
    expect(decideTransitionSounds('working', 'waiting', true, true, PERM, IDLE)).toMatchObject({
      idle: false,
    })
    expect(decideTransitionSounds('working', 'waiting', false, true, PERM, IDLE)).toMatchObject({
      idle: true,
    })
  })

  test('permission sound plays for the selected session while visible', () => {
    expect(decideTransitionSounds('working', 'permission', true, true, PERM, IDLE)).toEqual({
      permission: true,
      idle: false,
    })
  })

  test('permission sound disabled plays no permission sound', () => {
    expect(decideTransitionSounds('working', 'permission', false, true, false, IDLE)).toEqual({
      permission: false,
      idle: false,
    })
  })

  test('permission repeat or non-notifying transitions play nothing', () => {
    expect(
      decideTransitionSounds('permission', 'permission', false, true, PERM, IDLE)
    ).toEqual({ permission: false, idle: false })
    expect(decideTransitionSounds('waiting', 'working', false, true, PERM, IDLE)).toEqual({
      permission: false,
      idle: false,
    })
  })

  test('selected session finishing while the Team page is open still plays', () => {
    expect(
      decideTransitionSounds('working', 'waiting', true, true, PERM, IDLE, true)
    ).toEqual({ permission: false, idle: true })
  })

  test('Team page open does not suppress a background session or the permission sound', () => {
    expect(
      decideTransitionSounds('working', 'waiting', false, true, PERM, IDLE, true)
    ).toEqual({ permission: false, idle: true })
    expect(
      decideTransitionSounds('working', 'permission', true, true, PERM, IDLE, true)
    ).toEqual({ permission: true, idle: false })
  })
})
