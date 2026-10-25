// The Team page's URL location (team-workspace-pages D3):
// `#/team/<key>/<tab>[/<sub>][/<id>]`, where `<key>` is the team key
// (a repository's main-checkout path or a plain directory, URL-encoded —
// it contains slashes), `<tab>` is the Team page tab, `<sub>` is the
// Strategy sub-view, and `<id>` is a task id, thread id, plan id, or review
// revision (a revision in review, or the impact review's strategy revision).
// The Metrics tab (team-process-metrics D5) is `metrics/<window>[/<report
// id>]`: its second segment is the window, kept raw so the view can fall back
// with a notice when it names no window.
// The Plans detail (plan-workspace 7.1, design D8) adds an encoded query to
// the id segment: `plans/<plan-id>?v=&e=&c=&dw=&dp=&r=` names the workspace's
// displayed version, execution, change, open document, and active role. The
// query exists only on the plans tab; every other route's parse/format is
// byte-identical to before. This layer is purely syntactic — it decodes and
// re-encodes; `planWorkspaceLocation` validates each field against the loaded
// data and falls back with a notice, never silently selecting another record.
// Parse/format are pure so the hook and its tests share one grammar; an
// absent or unknown tab reads as the default tab (Tasks), never an error.
export type WorkspaceTab = 'strategy' | 'tasks' | 'messages' | 'mailbox' | 'members' | 'plans' | 'metrics' | 'audit'

/** Every tab key. */
export const WORKSPACE_TABS: readonly WorkspaceTab[] = [
  'strategy', 'tasks', 'messages', 'mailbox', 'members', 'plans', 'metrics', 'audit',
]

/**
 * The tabs the strip renders. Plans is durable-plans' tab (D12), beside
 * Strategy; Members is the read-only group inspection (team-workspace);
 * Metrics is team-process-metrics' tab (D5); Audit is the owner's read-only
 * send audit (execution-safety-recovery D9) — last, not part of the daily flow.
 */
export const RENDERED_WORKSPACE_TABS: readonly WorkspaceTab[] = ['strategy', 'plans', 'tasks', 'messages', 'mailbox', 'members', 'metrics', 'audit']

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
  /** Present only on the Plans tab: the workspace selections the detail URL names. */
  plans?: PlansLocationQuery
}

/**
 * The Plans detail's encoded query (plan-workspace 7.1, design D8). Fields
 * are raw decoded strings at this layer — the grammar never interprets them.
 * An absent field names no selection; a present-but-invalid one (a version
 * that is not `rev:<n>` or `draft:<id>`, a role outside the two, a document
 * missing its path) stays visible so the validator can explain the fallback.
 */
export interface PlansLocationQuery {
  /** The displayed version parameter: `rev:<n>` or `draft:<id>`. */
  version?: string
  /** The selected execution id; absent = the latest execution. */
  execution?: string
  /** The selected change name. */
  change?: string
  /** The open document: its worktree root path and relative path (`dw` + `dp`). */
  document?: { worktreeId: string; relativePath: string }
  /** The conversation panel's active role: `architect` or `lead`. */
  role?: string
}

export const TEAM_HASH_PREFIX = '#/team/'

/** The encoded `?`-query for a plans location; null when it names no selection (no `?` in the hash). */
export function plansQueryOf(query: PlansLocationQuery | undefined): string | null {
  if (query === undefined) return null
  const params: string[] = []
  const push = (key: string, value: string | undefined) => {
    if (value !== undefined) params.push(`${key}=${encodeURIComponent(value)}`)
  }
  push('v', query.version)
  push('e', query.execution)
  push('c', query.change)
  if (query.document !== undefined) {
    push('dw', query.document.worktreeId)
    push('dp', query.document.relativePath)
  }
  push('r', query.role)
  return params.length > 0 ? params.join('&') : null
}

/**
 * The plans query of a raw (still-encoded) `?`-suffix. A value with a
 * malformed escape is dropped, like a malformed id (D3); unknown keys are
 * not selections and are dropped by the next write.
 */
export function parsePlansQuery(raw: string): PlansLocationQuery {
  const query: PlansLocationQuery = {}
  for (const pair of raw.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    const decoded = decodeSegment(eq < 0 ? '' : pair.slice(eq + 1))
    if (decoded === null) continue
    if (key === 'v') query.version = decoded
    else if (key === 'e') query.execution = decoded
    else if (key === 'c') query.change = decoded
    else if (key === 'dw' || key === 'dp') {
      query.document = {
        worktreeId: key === 'dw' ? decoded : query.document?.worktreeId ?? '',
        relativePath: key === 'dp' ? decoded : query.document?.relativePath ?? '',
      }
    } else if (key === 'r') query.role = decoded
  }
  return query
}

/** Whether two plans queries name the same selections (the equality `navigate` dedupes on). */
export function samePlansQuery(a: PlansLocationQuery | undefined, b: PlansLocationQuery | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.version === b.version
    && a.execution === b.execution
    && a.change === b.change
    && a.role === b.role
    && a.document?.worktreeId === b.document?.worktreeId
    && a.document?.relativePath === b.document?.relativePath
}

export function teamHashOf(location: TeamLocation): string {
  const segments = [`${TEAM_HASH_PREFIX}${encodeURIComponent(location.teamKey)}`, location.tab]
  if (location.sub !== undefined) segments.push(location.sub)
  if (location.window !== undefined) segments.push(encodeURIComponent(location.window))
  const query = plansQueryOf(location.plans)
  if (location.id !== undefined || query !== null) {
    const idPart = location.id !== undefined ? encodeURIComponent(location.id) : ''
    segments.push(query !== null ? `${idPart}?${query}` : idPart)
  }
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
  // On the plans tab the id segment may carry the workspace query: split it
  // before decoding, so an encoded `?` (%3F) inside an id never reads as a
  // query and a query's escapes are judged on their own.
  let id: string | undefined
  let plans: PlansLocationQuery | undefined
  if (rawId !== undefined) {
    const q = tab === 'plans' ? rawId.indexOf('?') : -1
    id = decodeSegment(q < 0 ? rawId : rawId.slice(0, q)) ?? undefined
    if (q >= 0) {
      const parsed = parsePlansQuery(rawId.slice(q + 1))
      // A bare `?` names no selection; keep the location query-less.
      if (Object.keys(parsed).length > 0) plans = parsed
    }
  }
  return {
    teamKey, tab,
    ...(sub !== undefined ? { sub } : {}),
    ...(window !== undefined ? { window } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(plans !== undefined ? { plans } : {}),
  }
}
