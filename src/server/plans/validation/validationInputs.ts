// The file-held parts of a validation's inputs (plan-validation design D2):
// the adapter probe, each change's resolution and digests, and the catalog
// digests — read without a transaction and without the CLI (the probe excepted,
// and it is cached). Resolution follows `changeRegistry`'s canonical rule
// against fresh `discoverRepository` state: registration requires the change
// in the main root (unarchived); only then does the convention worktree
// `<main>/.worktrees/<change>` redirect the canonical copy, and only when
// that path is a listed worktree. The archive matches exactly `<change>` or
// `<YYYY-MM-DD>-<change>` (never a suffix near-miss), newest date first. A
// change found only in a worktree — or in a stray, unlisted directory at the
// convention path — is `unregistered`, hashed and evidenced where it was
// found (the checks read it there). Locations and each root's `HEAD` are
// evidence, never identity, so a proposal that moves between roots with
// unchanged content leaves a report current. Tests use temporary git
// repositories and an injected adapter.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { discoverRepository } from '../../git/worktreeList'
import { conventionWorktreePath } from '../../workspace/changeRegistry'
import { loadGroupCatalog } from '../../team/groupCatalog'
import { resolveProfileCatalog } from '../../chat/profileCatalog'
import { canonicalJson } from '../../../shared/productStrategy'
import { validationInputsHashInput, type ValidationChangeInput, type ValidationChangeStatus, type ValidationEvidence, type ValidationInputs } from '../../../shared/planValidation'
import type { AdapterProbe, OpenspecAdapter } from './openspecAdapter'

export interface ValidationFileOptions {
  /** Injected so tests (and `prepareStanding`) never spawn a CLI here. */
  adapter: OpenspecAdapter
  /** The team's git common dir (`TeamIdentity.teamId`). */
  commonDir: string
  /** Change names in plan order. */
  changeNames: readonly string[]
  /** Every group the plan names: roles, changes, and review groups. */
  groupNames: readonly string[]
  /** Where the team's groups are read (`TeamIdentity.groupsRoot`). */
  groupsRoot: string
  /** The landing branch, when the plan lands on an integration branch (branch evidence). */
  branch: string | null
  homeDir?: string
}

export interface ValidationFileInputs {
  /** The probe itself (ok/error are not identity); `adapter` below is what hashes. */
  probe: AdapterProbe
  adapter: ValidationInputs['adapter']
  /** In plan order. */
  changes: ValidationChangeInput[]
  catalog: { groups: Record<string, string | null>; profiles: string }
  /** The team's groups and known profile ids, for the checks (never hashed). */
  catalogs: { groups: ReadonlyMap<string, { profiles: readonly string[] }>; profiles: ReadonlySet<string> }
  /** Location and baseline evidence only (D2). */
  evidence: { changes: Record<string, { root: string | null; dir: string | null; head: string | null }>; branch: ValidationEvidence['branch'] }
}

const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex')

/** The input identity's digest: sha256 over the shared canonicalizer (D2). The one place both validate and standing hash. */
export const hashValidationInputs = (inputs: ValidationInputs): string => sha256(validationInputsHashInput(inputs))

/** Spec artifacts are markdown; a file past this cap hashes its first bytes only (a bound, not a verdict). */
const MAX_DIGEST_BYTES = 4 * 1024 * 1024

/**
 * A file's sha256 under one policy everywhere: regular files only — a
 * symlink is skipped, never followed — read via lstat's own size, capped at
 * `MAX_DIGEST_BYTES`; null when absent or unreadable.
 */
function hashFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return null
    const length = Math.min(stat.size, MAX_DIGEST_BYTES)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const bytes = fs.readSync(fd, buffer, 0, length, 0)
      return sha256(buffer.subarray(0, bytes))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Whether a change directory exists in this root (a proposal makes it a change); a symlinked proposal does not. */
const changeExists = (root: string, change: string): string | null => {
  const dir = path.join(root, 'openspec', 'changes', change)
  try {
    if (fs.lstatSync(path.join(dir, 'proposal.md')).isFile()) return dir
  } catch { /* absent */ }
  return null
}

/**
 * The archive directory holding this change, if any: the directory named
 * exactly `<change>` or `<YYYY-MM-DD>-<change>` — never a suffix near-miss —
 * newest first when several dates archived it (D3 names it in the error).
 */
function archiveDir(mainRoot: string, change: string): string | null {
  const archive = path.join(mainRoot, 'openspec', 'changes', 'archive')
  const exact = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(archive, { withFileTypes: true })
  } catch {
    return null
  }
  const names = entries
    .filter(entry => entry.isDirectory() && (entry.name === change || exact.test(entry.name)))
    .map(entry => entry.name)
    .sort()
    .reverse()
  for (const name of names) {
    const dir = path.join(archive, name)
    try {
      if (fs.lstatSync(path.join(dir, 'proposal.md')).isFile()) return dir
    } catch { /* archived without a proposal: keep looking */ }
  }
  return null
}

/**
 * One change's resolution: status, the directory its artifacts hash in, and
 * the root it sits in. Registration requires the change in the main root's
 * registry (unarchived), as `changeRegistry` does; the convention worktree
 * redirects the canonical copy only for a change already registered there,
 * and only when that path is a listed worktree. A change found only in a
 * worktree — or in a stray directory at the convention path that is not a
 * listed worktree — is `unregistered`, and a change archived in main stays
 * `archived` even if a stale convention copy remains.
 */
function resolveChange(mainRoot: string, listedRoots: ReadonlySet<string>, change: string): { status: ValidationChangeStatus; dir: string | null; root: string | null } {
  const convention = conventionWorktreePath(mainRoot, change)
  const inMain = changeExists(mainRoot, change)
  if (inMain) {
    if (listedRoots.has(convention)) {
      const inConvention = changeExists(convention, change)
      if (inConvention) return { status: 'registered', dir: inConvention, root: convention }
    }
    return { status: 'registered', dir: inMain, root: mainRoot }
  }
  const archived = archiveDir(mainRoot, change)
  if (archived) return { status: 'archived', dir: archived, root: mainRoot }
  const outside = [convention, ...listedRoots].filter(root => root !== mainRoot)
  for (const root of outside) {
    const found = changeExists(root, change)
    if (found) return { status: 'unregistered', dir: found, root }
  }
  return { status: 'missing', dir: null, root: null }
}

/** The change's own files — `proposal.md`, `design.md`, `tasks.md`, and every delta spec under `specs/` — as relative path → sha256 (D2). */
function artifactDigests(changeDir: string): { artifacts: Record<string, string>; capabilities: string[] } {
  const artifacts: Record<string, string> = {}
  const capabilities: string[] = []
  for (const name of ['proposal.md', 'design.md', 'tasks.md']) {
    const digest = hashFile(path.join(changeDir, name))
    if (digest) artifacts[name] = digest
  }
  const specs = path.join(changeDir, 'specs')
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file, `${prefix}${entry.name}/`)
      else if (entry.name === 'spec.md' && entry.isFile()) {
        const relative = `${prefix}spec.md`
        const digest = hashFile(file)
        if (digest) {
          artifacts[`specs/${relative}`] = digest
          capabilities.push(prefix.slice(0, -1))
        }
      }
    }
  }
  walk(specs, '')
  return { artifacts, capabilities }
}

/** The touched base specs: capability path → sha256 of `openspec/specs/<path>/spec.md`, null when absent (D2). */
function baseSpecDigests(root: string, capabilities: readonly string[]): Record<string, string | null> {
  const baseSpecs: Record<string, string | null> = {}
  for (const capability of capabilities) baseSpecs[capability] = hashFile(path.join(root, 'openspec', 'specs', ...capability.split('/'), 'spec.md'))
  return baseSpecs
}

/** The root's `openspec/config.yaml` (else `config.yml`), hashed; null when absent (D2). */
function configDigest(root: string): string | null {
  return hashFile(path.join(root, 'openspec', 'config.yaml')) ?? hashFile(path.join(root, 'openspec', 'config.yml'))
}

/**
 * Read the file-held inputs (D2): the probe, each change in plan order, and
 * the catalog digests. No CLI process is spawned (the injected adapter's
 * probe is cached), and nothing here opens a transaction. Branch facts are
 * evidence from the same discovery pass.
 */
export async function readValidationFileInputs(options: ValidationFileOptions): Promise<ValidationFileInputs> {
  const probe = await options.adapter.probe()
  const repository = await discoverRepository(options.commonDir)
  const worktrees = repository?.worktrees ?? []
  const main = worktrees.find(worktree => worktree.isMain)
  const mainRoot = main?.path ?? options.commonDir.replace(/\.git$/, '')
  const heads = new Map(worktrees.map(worktree => [worktree.path, worktree.headRevision]))
  const listedRoots = new Set(worktrees.map(worktree => worktree.path))
  const changes: ValidationChangeInput[] = []
  const evidence: ValidationFileInputs['evidence'] = { changes: {}, branch: null }
  for (const change of options.changeNames) {
    const resolved = resolveChange(mainRoot, listedRoots, change)
    const { artifacts, capabilities } = resolved.dir ? artifactDigests(resolved.dir) : { artifacts: {}, capabilities: [] }
    changes.push({
      change,
      status: resolved.status,
      artifacts,
      baseSpecs: resolved.root ? baseSpecDigests(resolved.root, capabilities) : {},
      config: resolved.root ? configDigest(resolved.root) : null,
    })
    evidence.changes[change] = { root: resolved.root, dir: resolved.dir, head: resolved.root ? heads.get(resolved.root) ?? null : null }
  }
  if (options.branch) {
    const branch = repository?.branches.find(entry => entry.name === options.branch) ?? null
    evidence.branch = branch
      ? { exists: true, head: branch.revision, worktree: branch.assignedWorktreePath ?? null }
      : { exists: false, head: null, worktree: null }
  }
  const catalog = loadGroupCatalog({ groupsRoot: options.groupsRoot, ...(options.homeDir ? { homeDir: options.homeDir } : {}) })
  return {
    probe,
    adapter: { tool: 'openspec', version: probe.version, capabilities: probe.capabilities },
    changes, catalog: catalogDigests(options, catalog), catalogs: {
      groups: new Map([...catalog.groups.values()].map(entry => [entry.group.id, { profiles: entry.group.profiles.map(profile => profile.profileId) }])),
      profiles: new Set(resolveProfileCatalog(options.homeDir ? { homeDir: options.homeDir } : {}).profiles.keys()),
    },
    evidence,
  }
}

/** The named groups' parsed-definition digests (null when unknown) and the known profile ids' digest (D2). */
function catalogDigests(options: ValidationFileOptions, catalog: ReturnType<typeof loadGroupCatalog>): ValidationFileInputs['catalog'] {
  const groups: Record<string, string | null> = {}
  for (const name of options.groupNames) {
    const entry = catalog.groups.get(name)
    groups[name] = entry ? sha256(canonicalJson(entry.group)) : null
  }
  const profiles = [...resolveProfileCatalog(options.homeDir ? { homeDir: options.homeDir } : {}).profiles.keys()].sort()
  return { groups, profiles: sha256(canonicalJson(profiles)) }
}
