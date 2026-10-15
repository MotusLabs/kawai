// Pure decision for which notification sounds a session status transition
// plays. Both protocol handlers (full list and single update) route through
// this so the rule lives in one tested place. The Idle sound is suppressed
// only for the selected session while the page is visible — the session the
// user is already watching; the Permission sound always plays.

export interface SoundDecisions {
  permission: boolean
  idle: boolean
}

export function decideTransitionSounds(
  prevStatus: string | undefined,
  nextStatus: string,
  isSelected: boolean,
  pageVisible: boolean,
  soundOnPermission: boolean,
  soundOnIdle: boolean
): SoundDecisions {
  if (!prevStatus) return { permission: false, idle: false }
  return {
    permission: prevStatus !== 'permission' && nextStatus === 'permission' && soundOnPermission,
    idle:
      prevStatus === 'working' &&
      nextStatus === 'waiting' &&
      soundOnIdle &&
      !(isSelected && pageVisible),
  }
}
