// Pure decision for which notification sounds a session status transition
// plays. Both protocol handlers (full list and single update) route through
// this so the rule lives in one tested place. The Idle sound is suppressed
// only for the session the user is actually watching — selected, with no
// Team page open (App shows TeamWorkspaceView instead of the session), and
// a visible page; the Permission sound always plays.

export interface SoundDecisions {
  permission: boolean
  idle: boolean
}

/** Whether the dashboard page is visible; when `document` is unavailable
 * (tests, SSR) the page counts as hidden so sounds behave as before. */
export function pageIsVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible'
}

export function decideTransitionSounds(
  prevStatus: string | undefined,
  nextStatus: string,
  isSelected: boolean,
  pageVisible: boolean,
  soundOnPermission: boolean,
  soundOnIdle: boolean,
  teamPageOpen: boolean = false
): SoundDecisions {
  if (!prevStatus) return { permission: false, idle: false }
  return {
    permission: prevStatus !== 'permission' && nextStatus === 'permission' && soundOnPermission,
    idle:
      prevStatus === 'working' &&
      nextStatus === 'waiting' &&
      soundOnIdle &&
      !(isSelected && pageVisible && !teamPageOpen),
  }
}
