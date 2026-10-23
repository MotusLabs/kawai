// plan-workspace 2.3 route tests: the scoped asset endpoint applies the same
// INVARIANT S checks (membership first, then the reader), serves only the
// allowlist content types, carries the CP1 B5 headers, and refusals name a
// reason without exposing the target path.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPlanWorkspaceAssetRoutes } from '../routes/planWorkspaceAsset'
import { readWorkspaceDocument } from '../plans/workspace/documentReader'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-asset-'))
const root = path.join(base, 'wt')
const outside = path.join(base, 'outside')
fs.mkdirSync(root, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(root, 'tasks.md'), '# Tasks\n')
fs.writeFileSync(path.join(root, 'mockup.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
fs.writeFileSync(path.join(root, 'page.html'), '<html></html>')
fs.writeFileSync(path.join(root, 'vector.svg'), '<svg/>')
fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE\n')
fs.symlinkSync(outside, path.join(root, 'leak'))

const rootReal = fs.realpathSync(root)
const membership = {
  resolve: async (teamPath: unknown) => teamPath === root ? { teamId: rootReal } : undefined,
  exists: async (_teamId: string, candidate: string) => candidate === rootReal,
}
const routes = createPlanWorkspaceAssetRoutes({ membership })

afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

const assetUrl = (query: Record<string, string>) =>
  `/plan-workspace/asset?${new URLSearchParams(query)}`

describe('GET /api/plan-workspace/asset', () => {
  test('serves a permitted image with its allowlist type and the safety headers', async () => {
    const response = await routes.request(assetUrl({ teamPath: root, worktree: root, path: 'mockup.png' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
    expect(Buffer.from(await response.arrayBuffer()).length).toBe(4)
  })

  test('serves markdown as text/markdown with charset', async () => {
    const response = await routes.request(assetUrl({ teamPath: root, worktree: root, path: 'tasks.md' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(await response.text()).toBe('# Tasks\n')
  })

  test('refuses an escaping path without exposing the target', async () => {
    const response = await routes.request(assetUrl({ teamPath: root, worktree: root, path: '../outside/secret.md' }))
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).not.toContain('secret')
    expect(body).not.toContain(base)
    expect(JSON.parse(body)).toEqual({ error: 'escape' })
  })

  test('refuses a symlink escape through the route', async () => {
    const response = await routes.request(assetUrl({ teamPath: root, worktree: root, path: 'leak/secret.md' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'containment-failed' })
  })

  test('refuses an unknown team and an unlisted worktree before any read', async () => {
    let reads = 0
    const guarded = createPlanWorkspaceAssetRoutes({
      membership,
      read: () => {
        reads += 1
        throw new Error('the reader must not run')
      },
    })
    const foreign = await guarded.request(assetUrl({ teamPath: '/somewhere/else', worktree: '/somewhere/else', path: 'tasks.md' }))
    expect(foreign.status).toBe(400)
    expect(await foreign.json()).toEqual({ error: 'unknown-team' })
    const unlisted = await guarded.request(assetUrl({ teamPath: root, worktree: path.join(base, 'not-listed'), path: 'tasks.md' }))
    expect(unlisted.status).toBe(400)
    expect(await unlisted.json()).toEqual({ error: 'worktree-not-listed' })
    expect(reads).toBe(0)
  })

  test('never serves html or svg whatever the bytes', async () => {
    for (const name of ['page.html', 'vector.svg']) {
      const response = await routes.request(assetUrl({ teamPath: root, worktree: root, path: name }))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'unsupported-type' })
    }
  })

  test('the three safety headers ride every refusal, not only the success', async () => {
    const oversized = path.join(root, 'huge.md')
    fs.writeFileSync(oversized, '')
    fs.truncateSync(oversized, 1024 * 1024 + 1)
    const cases: Array<[Record<string, string>, number]> = [
      [{ teamPath: '/somewhere/else', worktree: '/somewhere/else', path: 'tasks.md' }, 400],
      [{ teamPath: root, worktree: path.join(base, 'not-listed'), path: 'tasks.md' }, 400],
      [{ teamPath: root, worktree: root, path: '../outside/secret.md' }, 400],
      [{ teamPath: root, worktree: root, path: 'no-such.md' }, 404],
      [{ teamPath: root, worktree: root, path: 'huge.md' }, 413],
      [{ teamPath: root, worktree: root, path: 'page.html' }, 400],
    ]
    try {
      for (const [query, status] of cases) {
        const response = await routes.request(assetUrl(query))
        expect(response.status).toBe(status)
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
      }
    } finally {
      fs.unlinkSync(oversized)
    }
  })

  test('a listed root that is a symlink refuses root-not-canonical without exposing the target', async () => {
    const linkRoot = path.join(base, 'listed-link')
    fs.symlinkSync(outside, linkRoot)
    try {
      const symlinked = createPlanWorkspaceAssetRoutes({
        membership: {
          resolve: async () => ({ teamId: base }),
          exists: async (_teamId, candidate) => candidate === path.resolve(linkRoot),
        },
      })
      const response = await symlinked.request(assetUrl({ teamPath: base, worktree: linkRoot, path: 'secret.md' }))
      expect(response.status).toBe(400)
      expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
      const body = await response.text()
      expect(body).not.toContain(base)
      expect(JSON.parse(body)).toEqual({ error: 'root-not-canonical' })
    } finally {
      fs.unlinkSync(linkRoot)
    }
  })

  test('reader and route enforce the same reasons on the same fixture set', async () => {
    for (const relative of ['tasks.md', 'mockup.png', 'page.html', 'no-such.md', 'leak/secret.md', '../outside/secret.md', 'sub/x.md']) {
      const direct = await readWorkspaceDocument(root, relative)
      const viaRoute = await routes.request(assetUrl({ teamPath: root, worktree: root, path: relative }))
      if (!direct.ok) {
        expect(viaRoute.status).not.toBe(200)
        expect(await viaRoute.json()).toEqual({ error: direct.reason })
      } else {
        expect(viaRoute.status).toBe(200)
      }
    }
  })
})
