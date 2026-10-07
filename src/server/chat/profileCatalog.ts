// Layered chat profile catalog: `.kawai/profiles.json` files discovered from
// the session's project path up to the filesystem root, layered above a
// user-level catalog (~/.kawai/profiles.json) that replaces the image-provided
// default when present. Same-id entries merge per environment key (nearest
// wins, an empty value neutralizes an inherited one). `executable` is accepted
// only in operator-owned files (user level / shipped default): project files
// are agent-writable, and an executable there would run arbitrary code with
// the server's credentials. A file that fails validation is reported and
// skipped — the rest of the catalog still resolves.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The only environment variables a catalog file may set: provider routing,
 * model mapping, attribution, and compaction. Credentials (auth tokens, API
 * keys) are deliberately absent — they enter sessions only through the
 * server environment layer, so catalog files stay safe to commit and mount.
 */
export const PROFILE_CONTROLLED_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_ATTRIBUTION_HEADER', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
] as const

export type ProfileControlledEnvName = (typeof PROFILE_CONTROLLED_ENV)[number]

/** Profile ids double as launch-command names one day; keep them tame. */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const MAX_ENV_ENTRIES = 32
const MAX_ENV_VALUE_LENGTH = 4096
const ENTRY_FIELDS = new Set(['label', 'model', 'executable', 'env'])
const CONTROLLED = new Set<string>(PROFILE_CONTROLLED_ENV)

/** Shipped fallback catalog; ~/.kawai/profiles.json replaces it when present. */
export const DEFAULT_PROFILE_CATALOG_PATH = path.resolve(
  import.meta.dir,
  '../../../config/profiles.default.json'
)

export interface ProfileCatalogContext {
  projectPath?: string
  homeDir?: string
  imageDefaultPath?: string
}

/** A fully merged catalog entry: label resolved, env merged, never partial. */
export interface CatalogProfile {
  label: string
  env: Record<string, string>
  model?: string
  /** Operator-trusted wrapper; only user-level (or shipped) files can set it. */
  executable?: string
}

export interface ProfileCatalog {
  profiles: Map<string, CatalogProfile>
  /** Per-file validation failures; the rest of the catalog still resolves. */
  errors: string[]
}

interface PartialProfile {
  label?: string
  env: Record<string, string>
  model?: string
  executable?: string
}

type FileParse =
  | { ok: true; entries: Map<string, PartialProfile> }
  | { ok: false; error: string }

function validateEntry(
  id: string,
  entry: unknown,
  file: string,
  trusted: boolean
): PartialProfile | string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `${file}: profile "${id}" must be an object.`
  }
  const source = entry as Record<string, unknown>
  const profile: PartialProfile = { env: {} }
  for (const [field, value] of Object.entries(source)) {
    if (!ENTRY_FIELDS.has(field)) {
      return `${file}: profile "${id}" has unknown field "${field}".`
    }
    if (field === 'env') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${file}: profile "${id}" env must be an object of NAME: value pairs.`
      }
      const pairs = Object.entries(value)
      if (pairs.length > MAX_ENV_ENTRIES) {
        return `${file}: profile "${id}" defines more than ${MAX_ENV_ENTRIES} environment variables.`
      }
      for (const [name, raw] of pairs) {
        if (!CONTROLLED.has(name)) {
          return `${file}: profile "${id}" env variable "${name}" is not profile-controlled; catalog files carry routing and model configuration only, never credentials.`
        }
        if (typeof raw !== 'string') {
          return `${file}: profile "${id}" env value for "${name}" must be a string.`
        }
        if (raw.length > MAX_ENV_VALUE_LENGTH) {
          return `${file}: profile "${id}" env value for "${name}" is longer than ${MAX_ENV_VALUE_LENGTH} characters.`
        }
        profile.env[name] = raw
      }
      continue
    }
    if (field === 'executable') {
      if (typeof value !== 'string' || !value) {
        return `${file}: profile "${id}" executable must be a path string.`
      }
      if (!trusted) {
        return `${file}: executables are allowed only in the user-level catalog (~/.kawai/profiles.json); this file is not operator-owned.`
      }
      if (!path.isAbsolute(value)) {
        return `${file}: profile "${id}" executable must be an absolute path.`
      }
      profile.executable = value
      continue
    }
    if (typeof value !== 'string' || !value.trim()) {
      return `${file}: profile "${id}" field "${field}" must be a non-empty string.`
    }
    profile[field === 'label' ? 'label' : 'model'] = value
  }
  return profile
}

function parseCatalogFile(file: string, trusted: boolean): FileParse {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, entries: new Map() }
    return { ok: false, error: `${file}: cannot be read (${code ?? 'unknown error'}).` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `${file}: invalid JSON (${error instanceof Error ? error.message : String(error)}).` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${file}: catalog must be a JSON object of profile entries.` }
  }
  const entries = new Map<string, PartialProfile>()
  for (const [id, entry] of Object.entries(parsed)) {
    if (!PROFILE_ID_PATTERN.test(id)) {
      return { ok: false, error: `${file}: profile id "${id}" must match ${PROFILE_ID_PATTERN}.` }
    }
    const validated = validateEntry(id, entry, file, trusted)
    if (typeof validated === 'string') return { ok: false, error: validated }
    entries.set(id, validated)
  }
  return { ok: true, entries }
}

/** `.kawai/profiles.json` files from `/` down to the project path, farthest first. */
function projectCatalogFiles(projectPath: string): string[] {
  let real = projectPath
  try {
    real = fs.realpathSync(projectPath)
  } catch {
    // A missing cwd is refused earlier by project-directory resolution.
  }
  const segments = path.resolve(real).split(path.sep).filter(Boolean)
  const files = [path.join(path.sep, '.kawai', 'profiles.json')]
  for (let depth = 1; depth <= segments.length; depth++) {
    files.push(path.join(path.sep, ...segments.slice(0, depth), '.kawai', 'profiles.json'))
  }
  return files
}

/**
 * Assemble the catalog for a session: base layer (user-level file, or the
 * shipped default when absent) beneath every `.kawai` directory from the
 * filesystem root down to the project path. Farther files merge first so
 * nearer entries win per key.
 */
export function resolveProfileCatalog(
  ctx: ProfileCatalogContext = {}
): ProfileCatalog {
  // HOME first, the POSIX way: os.homedir() may be cached by the runtime and
  // ignore later HOME changes, which tests rely on for isolation.
  const home = ctx.homeDir ?? process.env.HOME ?? os.homedir()
  const baseFile = path.join(home, '.kawai', 'profiles.json')
  const levels: Array<{ file: string; trusted: boolean }> = []
  const base = fs.existsSync(baseFile)
    ? { file: baseFile, trusted: true }
    : { file: ctx.imageDefaultPath ?? DEFAULT_PROFILE_CATALOG_PATH, trusted: true }
  // Farthest (base) first; project files follow from root down to the path.
  levels.push(base)
  if (ctx.projectPath) {
    for (const file of projectCatalogFiles(ctx.projectPath)) {
      levels.push({ file, trusted: false })
    }
  }

  const merged = new Map<string, PartialProfile>()
  const errors: string[] = []
  for (const level of levels) {
    const parsed = parseCatalogFile(level.file, level.trusted)
    if (!parsed.ok) {
      errors.push(parsed.error)
      continue
    }
    if (parsed.entries.size === 0) continue
    for (const [id, entry] of parsed.entries) {
      const current = merged.get(id) ?? { env: {} }
      merged.set(id, {
        label: entry.label ?? current.label,
        env: { ...current.env, ...entry.env },
        model: entry.model ?? current.model,
        executable: entry.executable ?? current.executable,
      })
    }
  }

  const profiles = new Map<string, CatalogProfile>()
  for (const [id, profile] of merged) {
    profiles.set(id, {
      label: profile.label?.trim() || id,
      env: profile.env,
      ...(profile.model !== undefined ? { model: profile.model } : {}),
      ...(profile.executable !== undefined ? { executable: profile.executable } : {}),
    })
  }
  // Omitted selections resolve to `default`; it always exists, empty when no
  // file defines it (global provider environment alone).
  if (!profiles.has('default')) {
    profiles.set('default', { label: 'Default', env: {} })
  }
  return { profiles, errors }
}
