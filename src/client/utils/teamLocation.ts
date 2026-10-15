// The Team page's URL location (team-workspace-pages D3):
// `#/team/<key>/<tab>[/<sub>][/<id>]`, where `<key>` is the team key
// (a repository's main-checkout path or a plain directory, URL-encoded —
// it contains slashes), `<tab>` is the Team page tab, `<sub>` is the
// Strategy sub-view, and `<id>` is a task id, thread id, plan id, or review
// revision.
// Parse/format are pure so the hook and its tests share one grammar; an
// absent or unknown tab reads as the default tab (Tasks), never an error.
export type WorkspaceTab = 'strategy' | 'tasks' | 'messages' | 'mailbox' | 'members' | 'plans'

/** Every tab key, including the reserved extension points. */
export const WORKSPACE_TABS: readonly WorkspaceTab[] = [
  'strategy', 'tasks', 'messages', 'mailbox', 'members', 'plans',
]

/**
 * The tabs the strip renders. Plans is durable-plans' tab (D12), beside
 * Strategy; Members is the read-only group inspection (team-workspace).
 */
export const RENDERED_WORKSPACE_TABS: readonly WorkspaceTab[] = ['strategy', 'plans', 'tasks', 'messages', 'mailbox', 'members']

/** The tab a team's page opens on when none was used yet (chat-header spec). */
export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = 'tasks'

/** The Strategy sub-views (team-workspace-pages D5). */
export const STRATEGY_SUB_VIEWS = ['overview', 'review', 'draft', 'history'] as const
export type StrategySubView = (typeof STRATEGY_SUB_VIEWS)[number]

export interface TeamLocation {
  teamKey: string
  tab: WorkspaceTab
  /** Present only on the Strategy tab. */
  sub?: StrategySubView
  /** A task id, thread id, plan id, or review revision, per tab. */
  id?: string
}

export const TEAM_HASH_PREFIX = '#/team/'

export function teamHashOf(location: TeamLocation): string {
  const segments = [`${TEAM_HASH_PREFIX}${encodeURIComponent(location.teamKey)}`, location.tab]
  if (location.sub !== undefined) segments.push(location.sub)
  if (location.id !== undefined) segments.push(encodeURIComponent(location.id))
  return segments.join('/')
}

/** Decode one segment; null on a malformed escape, so a bad hash is never an error (D3). */
const decodeSegment = (value: string | undefined): string | null => {
  if (!value) return null
  try { return decodeURIComponent(value) } catch { return null }
}

export function parseTeamHash(hash: string): TeamLocation | null {
  // Test-window mocks may leave `location.hash` undefined; that is no route.
  if (typeof hash !== 'string' || !hash.startsWith(TEAM_HASH_PREFIX)) return null
  const parts = hash.slice(TEAM_HASH_PREFIX.length).split('/')
  // A malformed key is no route at all; a malformed id is dropped.
  const teamKey = decodeSegment(parts[0])
  if (!teamKey) return null
  const tab = WORKSPACE_TABS.includes(parts[1] as WorkspaceTab)
    ? parts[1] as WorkspaceTab
    : DEFAULT_WORKSPACE_TAB
  // `<sub>` exists only on the Strategy tab; any other trailing segment is `<id>`.
  const sub = tab === 'strategy' && (STRATEGY_SUB_VIEWS as readonly string[]).includes(parts[2] ?? '')
    ? parts[2] as StrategySubView
    : undefined
  const rawId = sub !== undefined ? parts[3] : parts[2]
  const id = decodeSegment(rawId) ?? undefined
  return { teamKey, tab, ...(sub !== undefined ? { sub } : {}), ...(id !== undefined ? { id } : {}) }
}
