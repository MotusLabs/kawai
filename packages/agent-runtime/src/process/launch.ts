// Launch configuration resolution (design §4, P01-P04, I3). Each process
// generation reads the caller's input once, validates it and freezes a clone;
// the executable check and the spawn share that one value. Nothing here reads
// process.env, os.homedir or any host setting.

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { AgentRuntimeError } from '../errors.js'
import type { LaunchConfiguration, LaunchInput } from '../options.js'

/** A validated, frozen launch configuration for one generation. */
export type ResolvedLaunch = Readonly<Omit<LaunchConfiguration, 'childEnv'>> & {
  readonly childEnv: Readonly<Record<string, string>>
}

function configurationError(message: string, causes: unknown[] = []): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'configuration', message }, causes)
}

function requireAbsolute(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw configurationError(`launch.${field} is required`)
  if (!isAbsolute(value)) throw configurationError(`launch.${field} must be an absolute path`)
  return value
}

/** Read, validate, clone and freeze one generation's launch configuration (P01). */
export function resolveLaunch(input: LaunchInput): ResolvedLaunch {
  let raw: LaunchConfiguration
  try {
    raw = typeof input === 'function' ? input() : input
  } catch (error) {
    throw configurationError('the launch configuration callback failed', [error])
  }
  if (raw === null || typeof raw !== 'object') throw configurationError('a launch configuration is required')
  const env = raw.childEnv as unknown
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw configurationError('launch.childEnv must be the complete child environment')
  }
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== 'string') throw configurationError(`launch.childEnv.${key} must be a string`)
    childEnv[key] = value
  }
  const executablePath = raw.executablePath === undefined ? undefined : requireAbsolute('executablePath', raw.executablePath)
  return Object.freeze({
    cwd: requireAbsolute('cwd', raw.cwd),
    childEnv: Object.freeze(childEnv),
    homeDir: requireAbsolute('homeDir', raw.homeDir),
    cacheDir: requireAbsolute('cacheDir', raw.cacheDir),
    tempDir: requireAbsolute('tempDir', raw.tempDir),
    ...(executablePath === undefined ? {} : { executablePath }),
  })
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The executable for this launch: `executablePath` when set, else `name`
 * resolved through the launch's own `childEnv.PATH` (never the host's).
 * A missing executable is a `dependency` error.
 */
export function resolveExecutable(launch: ResolvedLaunch, name: string): string {
  if (launch.executablePath !== undefined) {
    if (isExecutableFile(launch.executablePath)) return launch.executablePath
    throw new AgentRuntimeError({ category: 'dependency', message: `executable not found: ${launch.executablePath}` })
  }
  if (isAbsolute(name)) {
    if (isExecutableFile(name)) return name
  } else {
    for (const dir of (launch.childEnv.PATH ?? '').split(delimiter)) {
      if (dir && isAbsolute(dir) && isExecutableFile(join(dir, name))) return join(dir, name)
    }
  }
  throw new AgentRuntimeError({ category: 'dependency', message: `executable not found on the launch PATH: ${name}` })
}
