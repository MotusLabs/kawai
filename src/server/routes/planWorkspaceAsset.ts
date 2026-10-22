// The plan workspace's scoped asset route (plan-workspace 2.3, design D4):
// GET /api/plan-workspace/asset?teamPath&worktree&path serves one local
// document of a listed worktree through the same reader INVARIANT S bounds —
// membership and containment before any read, allowlist-only content types.
// Every response, refusals included, carries `Cross-Origin-Resource-Policy:
// same-origin` beside `X-Content-Type-Options: nosniff` and
// `Cache-Control: no-store` (CP1 B5, B8.4). A refusal answers the reason
// code only — never the resolved target path. The request's worktree is
// matched lexically (path.resolve, then exact membership against git's own
// listed path strings); no request-time resolution of it happens here
// (B8.3). Not a filesystem browser: no listing, and only worktree members
// pass.
import path from 'node:path'
import { Hono } from 'hono'
import { readWorkspaceDocument } from '../plans/workspace/documentReader'

/** The team and worktree membership checks the route runs before any read. */
export interface PlanWorkspaceAssetMembership {
  /** TeamScopes.resolve in production; a stub may stand in for tests. */
  resolve(teamPath: unknown): Promise<{ teamId: string } | undefined>
  /** TeamWorktrees.exists in production: is `root` a listed worktree of the team? */
  exists(teamId: string, root: string): Promise<boolean>
}

const STATUS_BY_REASON: Partial<Record<string, 400 | 404 | 413>> = {
  missing: 404,
  oversized: 413,
}

/** B8.4: the safety headers ride every route response, refusals included. */
const SAFETY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export function createPlanWorkspaceAssetRoutes(options: {
  membership: PlanWorkspaceAssetMembership
  /** Test seam: the reader; production always uses the real one. */
  read?: typeof readWorkspaceDocument
}) {
  const routes = new Hono()
  routes.get('/plan-workspace/asset', async c => {
    const team = await options.membership.resolve(c.req.query('teamPath'))
    if (!team) return c.json({ error: 'unknown-team' }, 400, SAFETY_HEADERS)
    const queriedRoot = c.req.query('worktree')
    if (typeof queriedRoot !== 'string' || queriedRoot === '') {
      return c.json({ error: 'worktree-not-listed' }, 400, SAFETY_HEADERS)
    }
    // B8.3: lexical resolve, then exact membership — the request path is
    // never resolved through the filesystem here.
    const root = path.resolve(queriedRoot)
    if (!(await options.membership.exists(team.teamId, root))) {
      return c.json({ error: 'worktree-not-listed' }, 400, SAFETY_HEADERS)
    }
    const result = await (options.read ?? readWorkspaceDocument)(root, c.req.query('path') ?? '')
    if (!result.ok) {
      return c.json({ error: result.reason }, STATUS_BY_REASON[result.reason] ?? 400, SAFETY_HEADERS)
    }
    const contentType = result.kind === 'markdown' ? 'text/markdown; charset=utf-8' : result.contentType
    return new Response(result.bytes, {
      headers: { ...SAFETY_HEADERS, 'Content-Type': contentType },
    })
  })
  return routes
}
