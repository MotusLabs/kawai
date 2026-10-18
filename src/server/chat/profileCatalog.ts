// Layered chat profile catalog: `.kawai/providers.json` and
// `.kawai/profiles.json` files discovered from the session's project path up
// to the filesystem root, layered above a user-level catalog (~/.kawai/) that
// replaces the image-provided defaults when either of its two files is
// present. Providers own models; a model key is the profile id every consumer
// stores. Same-id providers merge per environment key (nearest wins, an empty
// value neutralizes an inherited one), and legacy `profiles.json` entries read
// as one-model providers. `executable` is accepted only in operator-owned
// files (user level / shipped default): project files are agent-writable, and
// an executable there would run arbitrary code with the server's credentials.
// A file that fails validation is reported and skipped — the rest of the
// catalog still resolves. The shipped defaults are also embedded at build time
// (the static JSON imports below): compiled release binaries have no config/
// directory beside them, so a missing default file falls back to the embedded
// copy, validated by the same code.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import shippedDefaultCatalog from '../../../config/profiles.default.json'
import shippedDefaultProviders from '../../../config/providers.default.json'
import { CatalogMerger, flattenModel } from './catalogMerge'
import {
  parseCatalogValue,
  parseProviderCatalogValue,
  type FileParse,
} from './catalogParse'

// The file formats' validators are re-exported: callers and tests import the
// whole catalog surface from this module.
export {
  PROFILE_CONTROLLED_ENV,
  type ProfileControlledEnvName,
  PROFILE_ID_PATTERN,
  parseCatalogValue,
  parseProviderCatalogValue,
  type ParsedModel,
  type ParsedProvider,
  type PartialProfile,
} from './catalogParse'

/** Shipped fallback catalogs; either ~/.kawai file replaces both when present. */
export const DEFAULT_PROFILE_CATALOG_PATH = path.resolve(
  import.meta.dir,
  '../../../config/profiles.default.json'
)
export const DEFAULT_PROVIDER_CATALOG_PATH = path.resolve(
  import.meta.dir,
  '../../../config/providers.default.json'
)

/**
 * The shipped defaults bundled into the build. Used only when the default
 * file itself is missing (compiled binaries carry no config/ directory);
 * an existing file always wins so deployments can patch it without a
 * rebuild. Validated through the same parser as a file, under this source
 * name in errors.
 */
export const EMBEDDED_PROFILE_CATALOG: unknown = shippedDefaultCatalog

/** Source name validation errors report for the embedded shipped catalog. */
export const EMBEDDED_PROFILE_CATALOG_SOURCE = 'config/profiles.default.json (embedded)'

/** The shipped providers default bundled into the build (see above). */
export const EMBEDDED_PROVIDER_CATALOG: unknown = shippedDefaultProviders

/** Source name validation errors report for the embedded shipped providers. */
export const EMBEDDED_PROVIDER_CATALOG_SOURCE = 'config/providers.default.json (embedded)'

export interface ProfileCatalogContext {
  projectPath?: string
  homeDir?: string
  imageDefaultPath?: string
  imageDefaultProvidersPath?: string
}

/** A fully merged catalog entry: label resolved, env merged, never partial. */
export interface CatalogProfile {
  label: string
  env: Record<string, string>
  model?: string
  /** Operator-trusted wrapper; only user-level (or shipped) files can set it. */
  executable?: string
  /** Zone of reset times the provider writes without one (IANA or ±HH:MM). */
  limitResetTimeZone?: string
  /** The provider owning this model: cooldown and usage key (design D10). */
  providerId: string
  /** Server variable whose value is this model's bearer token (trusted tiers only). */
  authTokenEnv?: string
  /** Server variable holding the provider's balance-reading key; never given to agents. */
  balanceKeyEnv?: string
}

export interface CatalogProvider {
  label: string
  authTokenEnv?: string
  balanceKeyEnv?: string
  /** This provider's model keys, in catalog order. */
  models: string[]
}

export interface ProfileCatalog {
  profiles: Map<string, CatalogProfile>
  /** Providers with their labels and model keys, default-holder first (D13). */
  providers: Map<string, CatalogProvider>
  /** Per-file validation failures; the rest of the catalog still resolves. */
  errors: string[]
}

/**
 * Read and JSON-parse one catalog file. `onMissing` supplies the parsed value
 * to use when the file does not exist (the embedded shipped default); without
 * it a missing file reads as an empty catalog. Any other read error fails —
 * a path that is a directory (EISDIR) is reported, never silently replaced by
 * the embedded copy.
 */
function readCatalogJson(
  file: string,
  onMissing?: { value: unknown }
): { ok: true; value: unknown; fromMissing: boolean } | { ok: false; error: string } {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: true, value: onMissing?.value ?? {}, fromMissing: onMissing !== undefined }
    }
    return { ok: false, error: `${file}: cannot be read (${code ?? 'unknown error'}).` }
  }
  try {
    return { ok: true, value: JSON.parse(raw), fromMissing: false }
  } catch (error) {
    return { ok: false, error: `${file}: invalid JSON (${error instanceof Error ? error.message : String(error)}).` }
  }
}

function parseCatalogFile(
  file: string,
  trusted: boolean,
  onMissing?: { value: unknown; source: string }
): FileParse {
  const read = readCatalogJson(file, onMissing)
  if (!read.ok) return read
  return parseCatalogValue(read.value, read.fromMissing ? onMissing!.source : file, trusted)
}

/**
 * Expand a leading `~` against the effective home. Catalog requests carry the
 * project path as the client typed it (`~/work/app`), while session creation
 * expands home paths separately (paths.ts); expanding here keeps the picker,
 * create-request validation, and the manager reading the same files.
 */
function expandHomePath(projectPath: string, home: string): string {
  if (projectPath === '~') return home
  if (projectPath.startsWith('~/')) return path.join(home, projectPath.slice(2))
  return projectPath
}

/** `.kawai/providers.json` then `.kawai/profiles.json` per directory from `/` down to the project path, farthest first. */
function projectCatalogFiles(projectPath: string): string[] {
  let real = projectPath
  try {
    real = fs.realpathSync(projectPath)
  } catch {
    // A missing cwd is refused earlier by project-directory resolution.
  }
  const segments = path.resolve(real).split(path.sep).filter(Boolean)
  const files: string[] = []
  for (let depth = 0; depth <= segments.length; depth++) {
    const dir = path.join(path.sep, ...segments.slice(0, depth))
    files.push(path.join(dir, '.kawai', 'providers.json'), path.join(dir, '.kawai', 'profiles.json'))
  }
  return files
}

export type CatalogLevel = {
  file: string
  /** Which file of the level this is: read order is providers first (D1). */
  kind: 'providers' | 'profiles'
  trusted: boolean
  /** The shipped base: a nearer file may re-home its model keys away (D2). */
  shipped?: boolean
  /** When the file is missing, the embedded shipped catalog takes its place. */
  embeddedFallback?: boolean
}

/**
 * The catalog files a context reads, farthest (trusted base) first: the
 * user level's two files — or the shipped defaults when neither exists —
 * then every project `.kawai` pair from the filesystem root down to the
 * path. `providers.json` comes before `profiles.json` within a level. The
 * shipped base carries `embeddedFallback`: when that file is missing, the
 * embedded shipped catalog takes its place.
 */
export function profileCatalogLevels(ctx: ProfileCatalogContext = {}): CatalogLevel[] {
  // HOME first, the POSIX way: os.homedir() may be cached by the runtime and
  // ignore later HOME changes, which tests rely on for isolation.
  const home = ctx.homeDir ?? process.env.HOME ?? os.homedir()
  const userProviders = path.join(home, '.kawai', 'providers.json')
  const userProfiles = path.join(home, '.kawai', 'profiles.json')
  const levels: CatalogLevel[] = []
  const baseFiles = new Set<string>()
  if (fs.existsSync(userProviders) || fs.existsSync(userProfiles)) {
    // Either user-level file replaces both shipped defaults whole (D1).
    baseFiles.add(userProviders)
    baseFiles.add(userProfiles)
    levels.push(
      { file: userProviders, kind: 'providers', trusted: true },
      { file: userProfiles, kind: 'profiles', trusted: true }
    )
  } else {
    const providersFile = ctx.imageDefaultProvidersPath ?? DEFAULT_PROVIDER_CATALOG_PATH
    const profilesFile = ctx.imageDefaultPath ?? DEFAULT_PROFILE_CATALOG_PATH
    baseFiles.add(providersFile)
    baseFiles.add(profilesFile)
    levels.push(
      { file: providersFile, kind: 'providers', trusted: true, shipped: true, embeddedFallback: true },
      { file: profilesFile, kind: 'profiles', trusted: true, shipped: true, embeddedFallback: true }
    )
  }
  const projectPath = ctx.projectPath?.trim()
  if (projectPath) {
    const projectFiles = projectCatalogFiles(expandHomePath(projectPath, home))
    for (let i = 0; i < projectFiles.length; i++) {
      const file = projectFiles[i]
      // A home-relative project path walks through the user-level files'
      // directory: they are already read as the trusted base, and re-reading
      // them as an untrusted project layer would refuse their executables.
      if (baseFiles.has(file)) continue
      levels.push({
        file,
        kind: i % 2 === 0 ? 'providers' : 'profiles',
        trusted: false,
      })
    }
  }
  return levels
}

/**
 * Assemble the catalog for a session: base layer (the user level, or the
 * shipped defaults when absent — embedded when even the files are missing)
 * beneath every `.kawai` directory from the filesystem root down to the
 * project path. Farther files merge first so nearer entries win per key;
 * the tier rules (operator duplicates, shipped re-homing) live in the
 * merger. The result keeps the flat per-model `profiles` map every consumer
 * reads today, each entry naming its `providerId`, plus the `providers`
 * view in catalog order.
 */
export function resolveProfileCatalog(
  ctx: ProfileCatalogContext = {}
): ProfileCatalog {
  const merger = new CatalogMerger()
  const errors: string[] = []
  for (const level of profileCatalogLevels(ctx)) {
    // Only the shipped base falls back to the embedded shipped defaults;
    // a missing project file just contributes nothing.
    if (level.kind === 'providers') {
      const read = readCatalogJson(level.file, level.embeddedFallback ? { value: EMBEDDED_PROVIDER_CATALOG } : undefined)
      if (!read.ok) {
        errors.push(read.error)
        continue
      }
      const parsed = parseProviderCatalogValue(read.value, read.fromMissing ? EMBEDDED_PROVIDER_CATALOG_SOURCE : level.file, level.trusted)
      if (!parsed.ok) {
        errors.push(parsed.error)
        continue
      }
      merger.addProviders(level.file, level.shipped ?? false, parsed.providers, level.trusted)
      continue
    }
    const parsed = parseCatalogFile(level.file, level.trusted, level.embeddedFallback
      ? { value: EMBEDDED_PROFILE_CATALOG, source: EMBEDDED_PROFILE_CATALOG_SOURCE }
      : undefined)
    if (!parsed.ok) {
      errors.push(parsed.error)
      continue
    }
    merger.addProfiles(level.file, level.shipped ?? false, parsed.entries, level.trusted)
  }
  merger.finish()
  errors.push(...merger.errors)

  const profiles = new Map<string, CatalogProfile>()
  const providers = new Map<string, CatalogProvider>()
  // The flat profiles map keeps merge order; the providers view (D13) puts
  // the provider holding `default` first, then the providers in file order,
  // each with its models in order.
  const view = [...merger.providers.entries()]
  const defaultHolder = view.findIndex(([, p]) => p.models.has('default'))
  if (defaultHolder > 0) view.unshift(...view.splice(defaultHolder, 1))
  for (const [providerId, provider] of view) {
    providers.set(providerId, {
      label: provider.label?.trim() || providerId,
      ...(provider.authTokenEnv !== undefined ? { authTokenEnv: provider.authTokenEnv } : {}),
      ...(provider.balanceKeyEnv !== undefined ? { balanceKeyEnv: provider.balanceKeyEnv } : {}),
      models: [...provider.models.keys()],
    })
  }
  for (const [providerId, provider] of merger.providers) {
    for (const [modelKey, model] of provider.models) {
      const flat = flattenModel(provider, model)
      profiles.set(modelKey, {
        label: flat.label?.trim() || modelKey,
        env: flat.env,
        ...(flat.model !== undefined ? { model: flat.model } : {}),
        ...(flat.executable !== undefined ? { executable: flat.executable } : {}),
        ...(flat.limitResetTimeZone !== undefined ? { limitResetTimeZone: flat.limitResetTimeZone } : {}),
        providerId,
        ...(flat.authTokenEnv !== undefined ? { authTokenEnv: flat.authTokenEnv } : {}),
        ...(flat.balanceKeyEnv !== undefined ? { balanceKeyEnv: flat.balanceKeyEnv } : {}),
      })
    }
  }
  // Omitted selections resolve to `default`; it always exists, empty when no
  // file defines it (global provider environment alone).
  if (!profiles.has('default')) {
    profiles.set('default', { label: 'Default', env: {}, providerId: 'default' })
  }
  return { profiles, providers, errors }
}

/**
 * Stamp of every catalog file the context reads: providers.json included.
 * Consumers that cache catalog reads (the provider lookup, the group
 * catalog, the outbound destinations) key their caches on it.
 */
export function profileCatalogStamp(ctx: ProfileCatalogContext = {}): string {
  return profileCatalogLevels(ctx).map(({ file }) => {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  }).join('|')
}

const providerCache = new Map<string, Map<string, string>>()
const PROVIDER_CACHE_LIMIT = 32

/**
 * The provider owning `profileId` (D10), resolved from the catalog at the
 * context and cached per catalog stamp. A profile that is no longer in the
 * catalog stands in as its own provider, so a session launched before a
 * catalog edit keeps a stable cooldown and usage key.
 */
export function providerOf(profileId: string, ctx: ProfileCatalogContext = {}): string {
  const key = `${ctx.homeDir ?? process.env.HOME ?? os.homedir()}\n${ctx.projectPath ?? ''}\n${profileCatalogStamp(ctx)}`
  let known = providerCache.get(key)
  if (!known) {
    if (providerCache.size >= PROVIDER_CACHE_LIMIT) providerCache.clear()
    const resolved = resolveProfileCatalog(ctx)
    known = new Map([...resolved.profiles].map(([id, profile]) => [id, profile.providerId]))
    providerCache.set(key, known)
  }
  return known.get(profileId) ?? profileId
}
