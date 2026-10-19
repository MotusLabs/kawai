// Pure validators for the two catalog file formats: `profiles.json` (legacy
// one-model entries) and `providers.json` (providers holding models, design
// D1). No filesystem access — file reads live in profileCatalog.ts, which
// feeds parsed JSON to these and re-exports them. A file that fails
// validation is reported whole and skipped; the rest of the catalog still
// resolves. Credentials are deliberately refused: catalog files stay safe
// to commit and mount, and model entries may not set the routing base URL,
// which belongs to the provider alone. Trusted providers may NAME the server
// environment variables holding their credentials (`authTokenEnv`,
// `balanceKeyEnv`); the values never appear in a catalog file.
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
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
] as const

export type ProfileControlledEnvName = (typeof PROFILE_CONTROLLED_ENV)[number]

/** Profile ids double as launch-command names one day; keep them tame. */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const MAX_ENV_ENTRIES = 32
const MAX_ENV_VALUE_LENGTH = 4096
/** Fields a `runtime: "codex"` entry may set (design D4, ruling R1). */
const CODEX_ENTRY_FIELDS = new Set(['label', 'model', 'codexHome', 'network'])
/** Fields a Claude entry may set: today's set (the implicit runtime). */
const CLAUDE_ENTRY_FIELDS = new Set(['label', 'model', 'executable', 'env', 'limitResetTimeZone'])
/** Claude-only fields, named specifically when they land on a Codex entry. */
const CLAUDE_ONLY_FIELDS = new Set(['env', 'executable', 'limitResetTimeZone'])
/** Codex-only fields, named specifically when they land on a Claude entry. */
const CODEX_ONLY_FIELDS = new Set(['codexHome', 'network'])
const CONTROLLED = new Set<string>(PROFILE_CONTROLLED_ENV)

/** Provider fields naming a server environment variable that holds a credential. */
export const CREDENTIAL_NAME_FIELDS = ['authTokenEnv', 'balanceKeyEnv'] as const
const CREDENTIAL_FIELDS = new Set<string>(CREDENTIAL_NAME_FIELDS)
const CREDENTIAL_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export interface PartialProfile {
  label?: string
  env: Record<string, string>
  model?: string
  executable?: string
  limitResetTimeZone?: string
  /** The entry's runtime (ruling R1); absent reads as `claude`. */
  runtime?: 'claude' | 'codex'
  /** A Codex home the user-level catalog names; trusted tier only. */
  codexHome?: string
  /** Whether the Codex sandbox may reach the network; trusted tier only. */
  network?: boolean
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
  // Two passes (D4): the runtime is read first, because the field allowlist
  // depends on it. An absent runtime reads as `claude`, keeping today's
  // entries valid unchanged.
  if (source.runtime !== undefined && source.runtime !== 'claude' && source.runtime !== 'codex') {
    return `${file}: profile "${id}" runtime must be "claude" or "codex".`
  }
  const runtime = source.runtime ?? 'claude'
  const allowed = runtime === 'codex' ? CODEX_ENTRY_FIELDS : CLAUDE_ENTRY_FIELDS
  const profile: PartialProfile = { env: {} }
  // An explicitly written runtime is preserved so the merger can tell it
  // from an absent one: `runtime: "claude"` over a Codex profile is a
  // conflict, while a runtime-neutral (label/model-only) overlay is not.
  if (source.runtime !== undefined) profile.runtime = runtime
  for (const [field, value] of Object.entries(source)) {
    if (field === 'runtime') continue
    // Credentials live on providers.json providers alone (openrouter-provider
    // D1): never valid on a profiles.json entry, whatever its runtime.
    if (CREDENTIAL_FIELDS.has(field)) {
      return `${file}: profile "${id}" field "${field}" is allowed only on a provider in the user-level ~/.kawai/providers.json.`
    }
    if (!allowed.has(field)) {
      if (CLAUDE_ONLY_FIELDS.has(field)) {
        return `${file}: profile "${id}" declares runtime "${runtime}"; field "${field}" belongs to Claude entries.`
      }
      if (CODEX_ONLY_FIELDS.has(field)) {
        return `${file}: profile "${id}" declares runtime "${runtime}"; field "${field}" belongs to Codex entries.`
      }
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
    if (field === 'codexHome') {
      if (typeof value !== 'string' || !value.trim()) {
        return `${file}: profile "${id}" codexHome must be a non-empty path string.`
      }
      if (!trusted) {
        return `${file}: codexHome is allowed only in the user-level catalog (~/.kawai/profiles.json); this file is not operator-owned.`
      }
      if (!path.isAbsolute(value) && value !== '~' && !value.startsWith('~/')) {
        return `${file}: profile "${id}" codexHome must be an absolute path or start with ~/.`
      }
      profile.codexHome = value
      continue
    }
    if (field === 'network') {
      if (!trusted) {
        return `${file}: network is allowed only in the user-level catalog (~/.kawai/profiles.json); this file is not operator-owned.`
      }
      if (typeof value !== 'boolean') {
        return `${file}: profile "${id}" network must be a boolean.`
      }
      profile.network = value
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
  /** Server variable holding the inference token (trusted files only). */
  authTokenEnv?: string
  /** Server variable holding a balance-reading key, never given to agents. */
  balanceKeyEnv?: string
  models: Map<string, ParsedModel>
}

export type ProviderFileParse =
  | { ok: true; providers: Map<string, ParsedProvider> }
  | { ok: false; error: string }

const PROVIDER_FIELDS = new Set(['label', 'env', 'limitResetTimeZone', 'executable', 'models', ...CREDENTIAL_NAME_FIELDS])
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
      if (field === 'authTokenEnv' || field === 'balanceKeyEnv') {
        if (!trusted) {
          return { ok: false, error: `${source}: provider "${id}" field "${field}" is allowed only in the user-level ~/.kawai/providers.json; this file is not operator-owned.` }
        }
        if (typeof fieldValue !== 'string' || !CREDENTIAL_NAME_PATTERN.test(fieldValue)) {
          return { ok: false, error: `${source}: provider "${id}" field "${field}" must name an environment variable matching ${CREDENTIAL_NAME_PATTERN}.` }
        }
        provider[field] = fieldValue
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
          if (modelField === 'runtime') {
            // Ruling R2: a Codex profile cannot be a model of a providers.json
            // provider — runtimes live on profiles.json entries alone.
            return { ok: false, error: `${source}: model "${modelKey}" of provider "${id}" cannot declare runtime; a Codex profile cannot be a model of a providers.json provider.` }
          }
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
    // openrouter-provider D2: a credentialed provider cannot name an
    // executable. The wrapper owns provider configuration, so pinning the
    // base URL there would defeat the delegation — and leaving it unpinned
    // would let the wrapper, or a settings file, send the key anywhere. The
    // file is refused whole, naming the provider and the field.
    if (provider.executable !== undefined && (provider.authTokenEnv !== undefined || provider.balanceKeyEnv !== undefined)) {
      return { ok: false, error: `${source}: provider "${id}" has credential variables and must not set executable; the wrapper would choose where the key is sent. The file is refused.` }
    }
    providers.set(id, provider)
  }
  return { ok: true, providers }
}

