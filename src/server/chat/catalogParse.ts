// Pure validators for the two catalog file formats: `profiles.json` (legacy
// one-model entries) and `providers.json` (providers holding models, design
// D1). No filesystem access — file reads live in profileCatalog.ts, which
// feeds parsed JSON to these and re-exports them. A file that fails
// validation is reported whole and skipped; the rest of the catalog still
// resolves. Credentials are deliberately refused: catalog files stay safe
// to commit and mount, and model entries may not set the routing base URL,
// which belongs to the provider alone.
import path from 'node:path'
import { isResetTimeZone } from './limitSignals'

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
const ENTRY_FIELDS = new Set(['label', 'model', 'executable', 'env', 'limitResetTimeZone'])
const CONTROLLED = new Set<string>(PROFILE_CONTROLLED_ENV)

export interface PartialProfile {
  label?: string
  env: Record<string, string>
  model?: string
  executable?: string
  limitResetTimeZone?: string
}

export type FileParse =
  | { ok: true; entries: Map<string, PartialProfile> }
  | { ok: false; error: string }

/** Validates one env map; `subject` names the entry in every message. */
function validateEnv(
  file: string,
  subject: string,
  value: unknown
): Record<string, string> | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${file}: ${subject} env must be an object of NAME: value pairs.`
  }
  const pairs = Object.entries(value)
  if (pairs.length > MAX_ENV_ENTRIES) {
    return `${file}: ${subject} defines more than ${MAX_ENV_ENTRIES} environment variables.`
  }
  const env: Record<string, string> = {}
  for (const [name, raw] of pairs) {
    if (!CONTROLLED.has(name)) {
      return `${file}: ${subject} env variable "${name}" is not profile-controlled; catalog files carry routing and model configuration only, never credentials.`
    }
    if (typeof raw !== 'string') {
      return `${file}: ${subject} env value for "${name}" must be a string.`
    }
    if (raw.length > MAX_ENV_VALUE_LENGTH) {
      return `${file}: ${subject} env value for "${name}" is longer than ${MAX_ENV_VALUE_LENGTH} characters.`
    }
    env[name] = raw
  }
  return env
}

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
      const env = validateEnv(file, `profile "${id}"`, value)
      if (typeof env === 'string') return env
      profile.env = env
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
    if (field === 'limitResetTimeZone') {
      if (typeof value !== 'string' || !isResetTimeZone(value)) {
        return `${file}: profile "${id}" limitResetTimeZone must be an IANA time zone (Asia/Shanghai) or a ±HH:MM offset.`
      }
      profile.limitResetTimeZone = value
      continue
    }
    if (typeof value !== 'string' || !value.trim()) {
      return `${file}: profile "${id}" field "${field}" must be a non-empty string.`
    }
    profile[field === 'label' ? 'label' : 'model'] = value
  }
  return profile
}

/**
 * The one catalog validator, shared by file reads and the embedded shipped
 * default: `value` is already-parsed JSON, `source` names it in errors.
 */
export function parseCatalogValue(value: unknown, source: string, trusted: boolean): FileParse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `${source}: catalog must be a JSON object of profile entries.` }
  }
  const entries = new Map<string, PartialProfile>()
  for (const [id, entry] of Object.entries(value)) {
    if (!PROFILE_ID_PATTERN.test(id)) {
      return { ok: false, error: `${source}: profile id "${id}" must match ${PROFILE_ID_PATTERN}.` }
    }
    const validated = validateEntry(id, entry, source, trusted)
    if (typeof validated === 'string') return { ok: false, error: validated }
    entries.set(id, validated)
  }
  return { ok: true, entries }
}

/** One model of a parsed provider: label, startup model, env overlay. */
export interface ParsedModel {
  label?: string
  model?: string
  env: Record<string, string>
}

/** One parsed provider: the account facts plus its models. */
export interface ParsedProvider {
  label?: string
  env: Record<string, string>
  executable?: string
  limitResetTimeZone?: string
  models: Map<string, ParsedModel>
}

export type ProviderFileParse =
  | { ok: true; providers: Map<string, ParsedProvider> }
  | { ok: false; error: string }

const PROVIDER_FIELDS = new Set(['label', 'env', 'limitResetTimeZone', 'executable', 'models'])
const MODEL_FIELDS = new Set(['label', 'model', 'env'])

/**
 * The one `providers.json` validator, shared by file reads and the embedded
 * shipped providers default (design D1). A model may not set the routing base
 * URL: the file fails with an error naming the file, provider, and model, and
 * the rest of the catalog stays usable.
 */
export function parseProviderCatalogValue(
  value: unknown,
  source: string,
  trusted: boolean
): ProviderFileParse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `${source}: providers catalog must be a JSON object of provider entries.` }
  }
  const providers = new Map<string, ParsedProvider>()
  const modelHolders = new Map<string, string>()
  for (const [id, entry] of Object.entries(value)) {
    if (!PROFILE_ID_PATTERN.test(id)) {
      return { ok: false, error: `${source}: provider id "${id}" must match ${PROFILE_ID_PATTERN}.` }
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${source}: provider "${id}" must be an object.` }
    }
    const provider: ParsedProvider = { env: {}, models: new Map() }
    for (const [field, fieldValue] of Object.entries(entry)) {
      if (!PROVIDER_FIELDS.has(field)) {
        return { ok: false, error: `${source}: provider "${id}" has unknown field "${field}".` }
      }
      if (field === 'env') {
        const env = validateEnv(source, `provider "${id}"`, fieldValue)
        if (typeof env === 'string') return { ok: false, error: env }
        provider.env = env
        continue
      }
      if (field === 'executable') {
        if (typeof fieldValue !== 'string' || !fieldValue) {
          return { ok: false, error: `${source}: provider "${id}" executable must be a path string.` }
        }
        if (!trusted) {
          return { ok: false, error: `${source}: executables are allowed only in the user-level catalog (~/.kawai); this file is not operator-owned.` }
        }
        if (!path.isAbsolute(fieldValue)) {
          return { ok: false, error: `${source}: provider "${id}" executable must be an absolute path.` }
        }
        provider.executable = fieldValue
        continue
      }
      if (field === 'limitResetTimeZone') {
        if (typeof fieldValue !== 'string' || !isResetTimeZone(fieldValue)) {
          return { ok: false, error: `${source}: provider "${id}" limitResetTimeZone must be an IANA time zone (Asia/Shanghai) or a ±HH:MM offset.` }
        }
        provider.limitResetTimeZone = fieldValue
        continue
      }
      if (field === 'label') {
        if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
          return { ok: false, error: `${source}: provider "${id}" label must be a non-empty string.` }
        }
        provider.label = fieldValue
        continue
      }
      // field === 'models'
      if (typeof fieldValue !== 'object' || fieldValue === null || Array.isArray(fieldValue)) {
        return { ok: false, error: `${source}: provider "${id}" models must be an object of model entries.` }
      }
      for (const [modelKey, modelValue] of Object.entries(fieldValue)) {
        if (!PROFILE_ID_PATTERN.test(modelKey)) {
          return { ok: false, error: `${source}: model key "${modelKey}" of provider "${id}" must match ${PROFILE_ID_PATTERN}.` }
        }
        const holder = modelHolders.get(modelKey)
        if (holder !== undefined) {
          return { ok: false, error: `${source}: model "${modelKey}" is defined under both provider "${holder}" and provider "${id}".` }
        }
        if (typeof modelValue !== 'object' || modelValue === null || Array.isArray(modelValue)) {
          return { ok: false, error: `${source}: model "${modelKey}" of provider "${id}" must be an object.` }
        }
        const model: ParsedModel = { env: {} }
        for (const [modelField, modelFieldValue] of Object.entries(modelValue)) {
          if (!MODEL_FIELDS.has(modelField)) {
            return { ok: false, error: `${source}: model "${modelKey}" of provider "${id}" has unknown field "${modelField}".` }
          }
          if (modelField === 'env') {
            if (typeof modelFieldValue !== 'object' || modelFieldValue === null || Array.isArray(modelFieldValue)) {
              return { ok: false, error: `${source}: model "${modelKey}" of provider "${id}" env must be an object of NAME: value pairs.` }
            }
            if ('ANTHROPIC_BASE_URL' in modelFieldValue) {
              return { ok: false, error: `${source}: model "${modelKey}" of provider "${id}" must not set ANTHROPIC_BASE_URL; the base URL belongs to the provider.` }
            }
            const env = validateEnv(source, `model "${modelKey}" of provider "${id}"`, modelFieldValue)
            if (typeof env === 'string') return { ok: false, error: env }
            model.env = env
            continue
          }
          if (typeof modelFieldValue !== 'string' || !modelFieldValue.trim()) {
            return { ok: false, error: `${source}: model "${modelKey}" of provider "${id}" field "${modelField}" must be a non-empty string.` }
          }
          model[modelField === 'label' ? 'label' : 'model'] = modelFieldValue
        }
        provider.models.set(modelKey, model)
        modelHolders.set(modelKey, id)
      }
    }
    providers.set(id, provider)
  }
  return { ok: true, providers }
}

