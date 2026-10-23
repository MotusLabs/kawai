// Canonical change and artifact resolution for the plan workspace (2.1,
// design D4). One change's artifacts resolve from its canonical source only:
// the convention worktree `<main>/.worktrees/<change>` once it is listed,
// else the main checkout — never another worktree, and never a substitution
// of one copy for another. A change absent from the canonical worktree's
// active listing resolves through the CLI's archive listing of that same
// worktree: exactly one `YYYY-MM-DD-<name>` entry is its location, two or
// more are an explicit `ambiguous`, and none reads `missing` — or, in the
// listed convention worktree, `missing-in-worktree`; main's copy is never
// used.
//
// Artifact paths come from `openspec status --change <name> --json`
// (per-kind `existingOutputPaths`, nested specs enumerated by the CLI); an
// archived change has no status — its artifacts are enumerated from the
// archive directory (proposal/design/tasks.md plus specs/**/*.md, capped).
// An artifact kind with no file is absent from the resolution — never a
// fabricated path.
//
// Every CLI failure — spawn, non-zero exit, timeout, unparsable JSON — is a
// named `cli-unavailable` state, never a throw (B7). Calls share a
// dedicated 2-slot pool so document opens cannot starve the validation
// adapter's pool; children register in the adapter's live-children set, so
// a shutdown still kills them. Tests inject a runner; the pool and the
// argument contract stay the same.
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ADAPTER_TIMEOUT_MS,
  spawnOpenspec,
  type OpenspecRunner,
} from '../validation/openspecAdapter'
import { CHANGE_WORKTREES_DIR } from '../../../shared/workspace'

export const CHANGE_ARTIFACT_POOL_SIZE = 2
/** Upper bound on spec files enumerated from one archive directory. */
export const ARCHIVE_SPEC_CAP = 200

/** One existing artifact file, relative to the change root (forward slashes). */
export interface ChangeArtifactFile {
  kind: string
  relativePath: string
}

/** Where the canonical copy was found. */
export type ChangeArtifactSource =
  | { kind: 'main'; root: string }
  | { kind: 'worktree'; root: string }
  | { kind: 'archive'; root: string; entry: string }

export type ChangeArtifactsState =
  | 'missing'             // absent from the canonical worktree's active and archive listings
  | 'missing-in-worktree' // the listed convention worktree exists but lacks the change
  | 'ambiguous'           // two or more archive entries match the change name
  | 'cli-unavailable'     // a listing or status call failed; the named failure state (B7)

export type ChangeArtifactsResolution =
  | {
      ok: true
      changeName: string
      source: ChangeArtifactSource
      changeRoot: string
      artifacts: ChangeArtifactFile[]
    }
  | { ok: false; state: ChangeArtifactsState; message: string }

export interface ResolveChangeArtifactsInput {
  /** The team's main checkout root. */
  mainRoot: string
  /** Live worktree roots of the team (TeamWorktrees order); compared resolved. */
  worktreeRoots?: readonly string[]
}

interface CliListing {
  changes: Array<Record<string, unknown>>
  /** The listing's project root: the OpenSpec root sits at `<projectRoot>/openspec`. */
  projectRoot: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseListing = (value: unknown): CliListing | null => {
  if (!isRecord(value) || !Array.isArray(value.changes)) return null
  const changes = value.changes.filter(isRecord)
  const projectRoot = isRecord(value.root) && typeof value.root.path === 'string' ? value.root.path : null
  return { changes, projectRoot }
}

const listedNames = (listing: CliListing): Set<string> => {
  const names = new Set<string>()
  for (const change of listing.changes) {
    if (typeof change.name === 'string') names.add(change.name)
  }
  return names
}

/** The archive entry a listing names for one change: `YYYY-MM-DD-<name>`, escaped. */
const archiveEntryPattern = (changeName: string): RegExp =>
  new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${changeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

/** At most `limit` concurrent callers; a released slot transfers to the next waiter. */
class Pool {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>(resolve => this.waiting.push(resolve))
  }

  release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active -= 1
  }
}

export class ChangeArtifactsResolver {
  private readonly pool = new Pool(CHANGE_ARTIFACT_POOL_SIZE)

  constructor(
    private readonly run: OpenspecRunner = spawnOpenspec,
    private readonly timeoutMs: number = ADAPTER_TIMEOUT_MS,
  ) {}

  async resolve(changeName: string, input: ResolveChangeArtifactsInput): Promise<ChangeArtifactsResolution> {
    const mainRoot = path.resolve(input.mainRoot)
    const convention = path.join(mainRoot, CHANGE_WORKTREES_DIR, changeName)
    const listed = (input.worktreeRoots ?? []).some(root => path.resolve(root) === convention)

    // The convention worktree is canonical once listed; its own listings
    // decide, and main's copy is never consulted (design D4).
    if (listed) {
      const active = await this.list(convention, [])
      if (!active.ok) return unavailable(`openspec list failed in the convention worktree for "${changeName}"`, active.detail)
      if (listedNames(active.listing).has(changeName)) {
        return this.fromStatus(changeName, { kind: 'worktree', root: convention })
      }
      return this.resolveArchive(changeName, convention, 'missing-in-worktree',
        `Change "${changeName}" is missing in its convention worktree (active and archive listings); main checkout's copy is not substituted.`)
    }

    const active = await this.list(mainRoot, [])
    if (!active.ok) return unavailable(`openspec list failed in the main checkout for "${changeName}"`, active.detail)
    if (listedNames(active.listing).has(changeName)) {
      return this.fromStatus(changeName, { kind: 'main', root: mainRoot })
    }

    // Not active: resolve through the archive listing of the same worktree.
    return this.resolveArchive(changeName, mainRoot, 'missing',
      `Change "${changeName}" is absent from the active and archive listings; it reads missing, not an error.`)
  }

  /** Not active in `root`: the archive listing of the same worktree decides (D4). */
  private async resolveArchive(
    changeName: string,
    root: string,
    missingState: 'missing' | 'missing-in-worktree',
    missingMessage: string,
  ): Promise<ChangeArtifactsResolution> {
    const archived = await this.list(root, ['--archived'])
    if (!archived.ok) return unavailable(`openspec list --archived failed for "${changeName}"`, archived.detail)
    const entries = [...listedNames(archived.listing)].filter(name => archiveEntryPattern(changeName).test(name))
    if (entries.length === 0) return { ok: false, state: missingState, message: missingMessage }
    if (entries.length > 1) {
      return { ok: false, state: 'ambiguous', message: `Change "${changeName}" matches ${entries.length} archive entries: ${entries.sort().join(', ')}.` }
    }
    // The CLI-recognized archive location: <projectRoot>/openspec/changes/archive/<entry>.
    const archiveRoot = path.join(archived.listing.projectRoot ?? root, 'openspec', 'changes', 'archive', entries[0]!)
    return {
      ok: true,
      changeName,
      source: { kind: 'archive', root: archiveRoot, entry: entries[0]! },
      changeRoot: archiveRoot,
      artifacts: await enumerateArchiveArtifacts(archiveRoot),
    }
  }

  /** One status call turns into the change's existing artifact files. */
  private async fromStatus(changeName: string, source: ChangeArtifactSource): Promise<ChangeArtifactsResolution> {
    const status = await this.callJson(['status', '--change', changeName, '--json'], source.root)
    if (!status.ok) return unavailable(`openspec status failed for "${changeName}"`, status.detail)
    if (!isRecord(status.value)) return unavailable(`openspec status output is unparsable for "${changeName}"`, 'unknown shape')
    const changeRoot = typeof status.value.changeRoot === 'string' ? status.value.changeRoot : null
    if (changeRoot === null || !isRecord(status.value.artifactPaths)) {
      return unavailable(`openspec status output is unparsable for "${changeName}"`, 'unknown shape')
    }
    const artifacts: ChangeArtifactFile[] = []
    for (const [kind, spec] of Object.entries(status.value.artifactPaths)) {
      if (!isRecord(spec) || !Array.isArray(spec.existingOutputPaths)) continue
      for (const entry of spec.existingOutputPaths) {
        if (typeof entry !== 'string') continue
        const relative = toRepoRelative(changeRoot, entry)
        if (relative !== null) artifacts.push({ kind, relativePath: relative })
      }
    }
    return { ok: true, changeName, source, changeRoot, artifacts }
  }

  private async list(cwd: string, extra: readonly string[]): Promise<{ ok: true; listing: CliListing } | { ok: false; detail: string }> {
    const call = await this.callJson(['list', ...extra, '--json'], cwd)
    if (!call.ok) return call
    const listing = parseListing(call.value)
    if (listing === null) return { ok: false, detail: 'unknown shape' }
    return { ok: true, listing }
  }

  private async callJson(args: readonly string[], cwd: string): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
    await this.pool.acquire()
    let call
    try {
      call = await this.run(args, { cwd, timeoutMs: this.timeoutMs })
    } finally {
      this.pool.release()
    }
    if (!call.ok || call.timedOut) {
      return { ok: false, detail: call.timedOut ? 'timed out' : `exit ${call.exitCode ?? 'signal'}` }
    }
    try {
      return { ok: true, value: JSON.parse(call.stdout) }
    } catch {
      return { ok: false, detail: 'unparsable output' }
    }
  }
}

const unavailable = (message: string, detail: string): ChangeArtifactsResolution =>
  ({ ok: false, state: 'cli-unavailable', message: `${message} (${detail}).` })

/** Absolute path under the change root → repo-relative with forward slashes; escapes and outsiders are dropped. */
function toRepoRelative(changeRoot: string, absolute: string): string | null {
  const relative = path.relative(changeRoot, absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/**
 * Enumerates an archived change's artifacts from its directory: the
 * standard planning files plus every `.md` under `specs/` (the CLI refuses
 * status for archived names, so the archive location is enumerated
 * directly, deterministic and capped).
 */
async function enumerateArchiveArtifacts(archiveRoot: string): Promise<ChangeArtifactFile[]> {
  const artifacts: ChangeArtifactFile[] = []
  for (const kind of ['proposal', 'design', 'tasks']) {
    const relative = `${kind}.md`
    try {
      const stat = await fsp.stat(path.join(archiveRoot, relative))
      if (stat.isFile()) artifacts.push({ kind, relativePath: relative })
    } catch { /* the kind is absent from this archive entry */ }
  }
  const specFiles: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (specFiles.length >= ARCHIVE_SPEC_CAP) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (specFiles.length >= ARCHIVE_SPEC_CAP) return
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) specFiles.push(relative)
    }
  }
  await walk(path.join(archiveRoot, 'specs'), 'specs')
  for (const relative of specFiles) artifacts.push({ kind: 'specs', relativePath: relative })
  return artifacts
}
