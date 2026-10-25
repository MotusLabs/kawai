// `useTeamLocation` (team-workspace-pages D3): the Team page's location in
// the URL hash, held in a small store so every entry point — the navigator's
// Team entry, the chat header's Team button, the task chip, and the page's
// own tab and selection controls — writes one grammar and App renders from
// one value. Tab and selection changes push a history entry, so Back and
// Forward move between locations; search and expansion never touch the URL.
// `hashchange` (a typed or edited hash) and `popstate` (Back/Forward) sync
// the store from the URL, and `leave()` — selecting a session — pushes the
// hashless URL so Back returns to the page.
import { useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import {
  DEFAULT_WORKSPACE_TAB,
  RENDERED_WORKSPACE_TABS,
  parseTeamHash,
  samePlansQuery,
  teamHashOf,
  type PlansLocationQuery,
  type TeamLocation,
} from '../utils/teamLocation'

interface TeamLocationState {
  location: TeamLocation | null
  /**
   * Each team's last plans location (plan-workspace 7.1): the plan id and
   * workspace query last shown for that team. Opening the Team page restores
   * it, so a visit to a bound chat full-screen — which clears the hash —
   * returns to the same plan, version, change, document, and role instead of
   * the bare list.
   */
  lastPlansLocations: Record<string, { id: string | null; query?: PlansLocationQuery } | null>
  /** Push (default) or replace the history entry for `location`. */
  navigate: (location: TeamLocation, options?: { replace?: boolean }) => void
  /** Leave the Team page: clears the hash; Back returns. No-op when off the page. */
  leave: () => void
}

const historyApi = () => (typeof window === 'undefined' ? undefined : window.history)

const sameLocation = (a: TeamLocation | null, b: TeamLocation | null): boolean =>
  a?.teamKey === b?.teamKey && a?.tab === b?.tab && a?.sub === b?.sub && a?.window === b?.window && a?.id === b?.id
  && samePlansQuery(a?.plans, b?.plans)

export const useTeamLocationStore = create<TeamLocationState>(() => ({
  // The mount effect of `useTeamLocation` reads the URL (a reload restores
  // the location), so the store starts null rather than touching window at
  // import time.
  location: null,
  lastPlansLocations: {},
  navigate: (location, options) => {
    // Navigating to the location already shown (clicking the active tab, or
    // the status line while on that review) adds no history entry, so Back
    // needs no extra presses. A query-only change is a different location
    // (samePlansQuery), so it still pushes.
    if (sameLocation(useTeamLocationStore.getState().location, location)) return
    const hash = teamHashOf(location)
    if (options?.replace) historyApi()?.replaceState(null, '', hash)
    else historyApi()?.pushState(null, '', hash)
    // Record the plans sub-location as it is navigated to, so the Team page's
    // opener can restore it (a rekey's replace navigates here too).
    if (location.tab === 'plans') {
      useTeamLocationStore.setState(state => ({
        lastPlansLocations: {
          ...state.lastPlansLocations,
          [location.teamKey]: { id: location.id ?? null, ...(location.plans !== undefined ? { query: location.plans } : {}) },
        },
      }))
    }
    useTeamLocationStore.setState({ location })
  },
  leave: () => {
    if (useTeamLocationStore.getState().location === null) return
    const history = historyApi()
    if (history && window.location) history.pushState(null, '', window.location.pathname + window.location.search)
    useTeamLocationStore.setState({ location: null })
  },
}))

/** The Team page location, synced from the URL on mount and every history event. */
export function useTeamLocation(): TeamLocation | null {
  const location = useTeamLocationStore((state) => state.location)
  useEffect(() => {
    const sync = () => {
      const parsed = typeof window === 'undefined' || !window.location
        ? null
        : parseTeamHash(window.location.hash)
      if (!sameLocation(useTeamLocationStore.getState().location, parsed)) {
        useTeamLocationStore.setState({ location: parsed })
      }
    }
    sync()
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])
  return location
}

/** Reset for tests: forget the location without touching history. */
export function resetTeamLocationForTests(): void {
  useTeamLocationStore.setState({ location: null, lastPlansLocations: {} })
}

/**
 * The Team page route as App uses it (team-workspace-pages D3, team-workspace
 * D10): the current location, the entry points' shared opener — a team's
 * page opens on the tab last used for that team, Tasks the first time — and
 * the leave-on-selection rule. A selection *act* after mount (selectionEpoch,
 * never persisted) leaves the route so Back returns to the same tab and item,
 * while a reload's restored selection must not.
 */
export function useTeamPageRoute(): { teamLocation: TeamLocation | null; openTeamPage: (teamKey: string) => void } {
  const teamLocation = useTeamLocation()
  const selectionEpoch = useSessionStore(state => state.selectionEpoch)
  const selectionEpochAtMount = useRef(selectionEpoch)
  useEffect(() => {
    if (selectionEpoch > selectionEpochAtMount.current) {
      useTeamLocationStore.getState().leave()
    }
  }, [selectionEpoch])
  const openTeamPage = useCallback((teamKey: string) => {
    const last = useTeamWorkspaceStore.getState().views[teamKey]?.tab
    const tab = last !== undefined && RENDERED_WORKSPACE_TABS.includes(last) ? last : DEFAULT_WORKSPACE_TAB
    // Returning from a full-screen bound chat restores the plans sub-location
    // (plan-workspace 7.1): the same plan, version, change, document, and
    // role — the workspace state itself never left the stores. A location
    // that names no plan reopens the list, as it was left.
    const lastPlans = useTeamLocationStore.getState().lastPlansLocations[teamKey]
    if (tab === 'plans' && lastPlans) {
      useTeamLocationStore.getState().navigate({
        teamKey, tab: 'plans',
        ...(lastPlans.id !== null ? { id: lastPlans.id } : {}),
        ...(lastPlans.query !== undefined ? { plans: lastPlans.query } : {}),
      })
      return
    }
    useTeamLocationStore.getState().navigate({ teamKey, tab })
  }, [])
  return { teamLocation, openTeamPage }
}
