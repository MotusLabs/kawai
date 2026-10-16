// The Team page's URL location (team-workspace-pages D3):
// `#/team/<key>/<tab>[/<sub>][/<id>]`, where `<key>` is the team key
// (a repository's main-checkout path or a plain directory, URL-encoded —
// it contains slashes), `<tab>` is the Team page tab, `<sub>` is the
// Strategy sub-view, and `<id>` is a task id, thread id, plan id, or review
// revision (a revision in review, or the impact review's strategy revision).
// The Metrics tab (team-process-metrics D5) is `metrics/<window>[/<report
// id>]`: its second segment is the window, kept raw so the view can fall back
// with a notice when it names no window.
// Parse/format are pure so the hook and its tests share one grammar; an
// absent or unknown tab reads as the default tab (Tasks), never an error.
export type WorkspaceTab = 'strategy' | 'tasks' | 'messages' | 'mailbox' | 'members' | 'plans' | 'metrics'

/** Every tab key. */
export const WORKSPACE_TABS: readonly WorkspaceTab[] = [
  'strategy', 'tasks', 'messages', 'mailbox', 'members', 'plans', 'metrics',
]

/**
 * The tabs the strip renders. Plans is durable-plans' tab (D12), beside
 * Strategy; Members is the read-only group inspection (team-workspace);
 * Metrics is team-process-metrics' tab (D5).
 */
export const RENDERED_WORKSPACE_TABS: readonly WorkspaceTab[] = ['strategy', 'plans', 'tasks', 'messages', 'mailbox', 'members', 'metrics']

/** The tab a team's page opens on when none was used yet (chat-header spec). */
export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = 'tasks'

/** The Strategy sub-views (team-workspace-pages D5; `impact`: strategy-revision-impact D9). */
export const STRATEGY_SUB_VIEWS = ['overview', 'review', 'impact', 'draft', 'history'] as const
export type StrategySubView = (typeof STRATEGY_SUB_VIEWS)[number]

export interface TeamLocation {
  teamKey: string
  tab: WorkspaceTab
  /** Present only on the Strategy tab. */
  sub?: StrategySubView
  /** Present only on the Metrics tab: its window segment, raw (the view validates it). */
  window?: string
  /** A task id, thread id, plan id, review revision, or report id, per tab. */
  id?: string
}

export const TEAM_HASH_PREFIX = '#/team/'

export function teamHashOf(location: TeamLocation): string {
  const segments = [`${TEAM_HASH_PREFIX}${encodeURIComponent(location.teamKey)}`, location.tab]
  if (location.sub !== undefined) segments.push(location.sub)
  if (location.window !== undefined) segments.push(encodeURIComponent(location.window))
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
  // `<window>` exists only on the Metrics tab, always as the third segment.
  const window = tab === 'metrics' ? decodeSegment(parts[2]) ?? undefined : undefined
  const rawId = sub !== undefined || tab === 'metrics' ? parts[3] : parts[2]
  const id = decodeSegment(rawId) ?? undefined
  return {
    teamKey, tab, ...(sub !== undefined ? { sub } : {}), ...(window !== undefined ? { window } : {}), ...(id !== undefined ? { id } : {}),
  }
}
