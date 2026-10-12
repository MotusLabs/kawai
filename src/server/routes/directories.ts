// Directory browser route (`/api/directories?path=`): lists the immediate
// subdirectories of a server-side path for the project picker — dot
// directories first, then case-insensitive name order, capped at
// MAX_DIRECTORY_ENTRIES with a `truncated` flag. Errors map to typed
// DirectoryErrorResponse payloads (400/403/404/500).
import fs from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { logger } from '../logger'
import { resolveProjectPath } from '../paths'
import { MAX_FIELD_LENGTH } from '../validators'
import type { DirectoryErrorResponse, DirectoryListing } from '../../shared/types'

const MAX_DIRECTORY_ENTRIES = 200

export function createDirectoryRoutes() {
  const routes = new Hono()

  routes.get('/', async (c) => {
    const requestedPath = c.req.query('path') ?? '~'

    if (requestedPath.length > MAX_FIELD_LENGTH) {
      const payload: DirectoryErrorResponse = {
        error: 'invalid_path',
        message: 'Path too long',
      }
      return c.json(payload, 400)
    }

    const trimmedPath = requestedPath.trim()
    if (!trimmedPath) {
      const payload: DirectoryErrorResponse = {
        error: 'invalid_path',
        message: 'Path is required',
      }
      return c.json(payload, 400)
    }

    const start = Date.now()
    const resolved = resolveProjectPath(trimmedPath)

    let stats: Awaited<ReturnType<typeof fs.stat>>
    try {
      stats = await fs.stat(resolved)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        const payload: DirectoryErrorResponse = {
          error: 'not_found',
          message: 'Path does not exist',
        }
        return c.json(payload, 404)
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        const payload: DirectoryErrorResponse = {
          error: 'forbidden',
          message: 'Permission denied',
        }
        return c.json(payload, 403)
      }
      const payload: DirectoryErrorResponse = {
        error: 'internal_error',
        message: 'Unable to read directory',
      }
      return c.json(payload, 500)
    }

    if (!stats.isDirectory()) {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path is not a directory',
      }
      return c.json(payload, 404)
    }

    let directories: DirectoryListing['directories'] = []
    try {
      const entries = await fs.readdir(resolved, {
        withFileTypes: true,
        encoding: 'utf8',
      })
      directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const name = entry.name.toString()
          return {
            name,
            path: path.join(resolved, name),
          }
        })
        .toSorted((a, b) => {
          const aDot = a.name.startsWith('.')
          const bDot = b.name.startsWith('.')
          if (aDot !== bDot) {
            return aDot ? -1 : 1
          }
          const aLower = a.name.toLowerCase()
          const bLower = b.name.toLowerCase()
          if (aLower < bLower) {
            return -1
          }
          if (aLower > bLower) {
            return 1
          }
          return a.name.localeCompare(b.name)
        })
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        const payload: DirectoryErrorResponse = {
          error: 'forbidden',
          message: 'Permission denied',
        }
        return c.json(payload, 403)
      }
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        const payload: DirectoryErrorResponse = {
          error: 'not_found',
          message: 'Path does not exist',
        }
        return c.json(payload, 404)
      }
      const payload: DirectoryErrorResponse = {
        error: 'internal_error',
        message: 'Unable to list directory',
      }
      return c.json(payload, 500)
    }

    const truncated = directories.length > MAX_DIRECTORY_ENTRIES
    const limitedDirectories = truncated
      ? directories.slice(0, MAX_DIRECTORY_ENTRIES)
      : directories

    const root = path.parse(resolved).root
    const parent = resolved === root ? null : path.dirname(resolved)
    const response: DirectoryListing = {
      path: resolved,
      parent,
      directories: limitedDirectories,
      truncated,
    }

    const durationMs = Date.now() - start
    logger.debug('directories_request', {
      path: resolved,
      count: limitedDirectories.length,
      truncated,
      durationMs,
    })

    return c.json(response)
  })

  return routes
}
