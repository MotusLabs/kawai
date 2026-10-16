// The OpenSpec adapter (plan-validation design D3): the only module that
// spawns the OpenSpec CLI for validation. `probe()` reports the installed
// version against the supported floor and the capabilities that version
// grants, cached for ten minutes; `validate` and `showDeltas` normalize the
// CLI's JSON into the shapes the checks read, with the discovery timeout
// (15 s), issues capped at 50 per change with a count, and a pool of four
// concurrent calls. A missing executable, an unparsable or below-floor
// version, a failed or timed-out call, and an unknown JSON shape are errors —
// a missing operation never yields success. Tests drive a stub executable on
// a private PATH or an injected runner; nothing here reaches the network.
import { spawn } from 'node:child_process'
import { cleanGitEnv } from '../../git/gitCommand'
import type { CliIssue, SpecTouch } from '../../../shared/planValidation'

export const OPENSPEC_VERSION_FLOOR = [1, 14] as const
export const VALIDATE_STRICT_JSON = 'validate-strict-json'
export const SHOW_DELTAS_JSON = 'show-deltas-json'
export const ADAPTER_ISSUE_CAP = 50
export const ADAPTER_POOL_SIZE = 4
export const ADAPTER_TIMEOUT_MS = 15_000
/** The delta operations the adapter knows (D3); any other operation is an unknown shape. */
const DELTA_OPERATIONS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'] as const
const PROBE_CACHE_MS = 10 * 60 * 1000

export interface AdapterProbe {
  tool: 'openspec'
  /** The parsed version; null when `--version` ran but did not parse. */
  version: string | null
  /** The capability names this version grants (both, at or above the floor). */
  capabilities: string[]
  /** False when the executable is missing, unparsable, or below the floor. */
  ok: boolean
  error: string | null
}

export interface AdapterCallResult {
  /** The call itself completed with a known shape; `valid`/`touches` are then meaningful. */
  ok: boolean
  error: string | null
}

export interface ValidateOutcome extends AdapterCallResult {
  valid: boolean
  issues: CliIssue[]
  /** The issue count before the cap. */
  issueCount: number
}

export interface ShowDeltasOutcome extends AdapterCallResult {
  touches: SpecTouch[]
}

export interface OpenspecCall {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type OpenspecRunner = (args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<OpenspecCall>

/** After a timeout's SIGTERM, the group gets SIGKILL (H2: a child that ignores the signal must not hold a pool slot). */
const KILL_GRACE_MS = 250

/**
 * The default runner: spawn `openspec` from the PATH in its own process
 * group (`detached`), so a timeout can kill the whole tree — the CLI may
 * leave children holding the pipes. The call resolves at the timeout without
 * awaiting the streams: a grandchild keeping them open never holds the
 * caller, and the pool slot is always freed.
 */
export const spawnOpenspec: OpenspecRunner = (args, { cwd, timeoutMs }) =>
  new Promise<OpenspecCall>(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('openspec', [...args], { cwd, env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: 'openspec spawn failed', timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const settle = (result: OpenspecCall) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      resolve(result)
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    // A spawn failure (ENOENT) arrives here, not at the call site.
    child.on('error', () => settle({ ok: false, exitCode: null, stdout: '', stderr: 'openspec spawn failed', timedOut: false }))
    child.on('close', code => settle({ ok: code === 0, exitCode: code, stdout, stderr, timedOut }))
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal)
      } catch { /* the group is already gone */ }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      graceTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      // Resolve now: the pipes may stay open however the kill lands.
      settle({ ok: false, exitCode: child.exitCode, stdout, stderr, timedOut })
    }, timeoutMs)
  })

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

const parseVersion = (stdout: string): Array<number> | null => {
  const match = stdout.trim().match(/v?(\d+)\.(\d+)(?:\.(\d+))?/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
}

const atFloor = (parts: Array<number>): boolean =>
  parts[0]! > OPENSPEC_VERSION_FLOOR[0] || (parts[0]! === OPENSPEC_VERSION_FLOOR[0] && parts[1]! >= OPENSPEC_VERSION_FLOOR[1])

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

export class OpenspecAdapter {
  private readonly pool = new Pool(ADAPTER_POOL_SIZE)
  private cached: { probe: AdapterProbe; at: number } | null = null

  constructor(private readonly run: OpenspecRunner = spawnOpenspec, private readonly timeoutMs = ADAPTER_TIMEOUT_MS) {}

  /** The version and capabilities; a successful probe is cached ten minutes (D3), a failed one re-probes next call. */
  async probe(force = false): Promise<AdapterProbe> {
    if (!force && this.cached && Date.now() - this.cached.at < PROBE_CACHE_MS) return this.cached.probe
    const call = await this.call(['--version'], { cwd: process.cwd() })
    if (!call.ok && call.exitCode === null && call.stderr === 'openspec spawn failed') {
      return { tool: 'openspec', version: null, capabilities: [], ok: false, error: 'openspec executable not found' }
    }
    const version = call.stdout.trim()
    const parts = parseVersion(version)
    if (!parts) {
      return { tool: 'openspec', version: null, capabilities: [], ok: false, error: `openspec version unparsable: ${JSON.stringify(version)}` }
    }
    if (!atFloor(parts)) {
      return { tool: 'openspec', version, capabilities: [], ok: false, error: `openspec ${version} is below the supported floor 1.14` }
    }
    return this.remember({ tool: 'openspec', version, capabilities: [VALIDATE_STRICT_JSON, SHOW_DELTAS_JSON], ok: true, error: null })
  }

  private remember(probe: AdapterProbe): AdapterProbe {
    this.cached = { probe, at: Date.now() }
    return probe
  }

  /** `openspec validate <change> --strict --json`, normalized; issues capped at 50 (D3). */
  async validate(root: string, change: string): Promise<ValidateOutcome> {
    const call = await this.call(['validate', change, '--strict', '--json'], { cwd: root })
    if (call.timedOut) return { ok: false, error: `validate ${change} timed out after ${this.timeoutMs}ms`, valid: false, issues: [], issueCount: 0 }
    const parsed = parseJson(call.stdout)
    if (parsed === null) return { ok: false, error: `validate ${change} returned no JSON (exit ${call.exitCode})`, valid: false, issues: [], issueCount: 0 }
    const item = itemFor(parsed, change)
    if (!item || typeof item.valid !== 'boolean' || !Array.isArray(item.issues)) {
      return { ok: false, error: `validate ${change} returned an unknown shape`, valid: false, issues: [], issueCount: 0 }
    }
    // The CLI exits 0 exactly when every item is valid; anything else, or an
    // exit code outside 0/1, is an unknown outcome rather than a verdict.
    const valid = item.valid === true
    if (call.exitCode !== 0 && call.exitCode !== 1) {
      return { ok: false, error: `validate ${change} exited ${call.exitCode} with JSON output`, valid: false, issues: [], issueCount: 0 }
    }
    if ((call.exitCode === 0) !== valid) {
      return { ok: false, error: `validate ${change} exited ${call.exitCode} but reports valid=${valid}`, valid: false, issues: [], issueCount: 0 }
    }
    const issues: CliIssue[] = []
    for (const entry of item.issues as unknown[]) {
      if (typeof entry !== 'object' || entry === null || text((entry as Record<string, unknown>).message) === null) {
        return { ok: false, error: `validate ${change} returned an unknown issue shape`, valid: false, issues: [], issueCount: 0 }
      }
      issues.push({ level: text((entry as Record<string, unknown>).level) ?? 'ERROR', message: text((entry as Record<string, unknown>).message)! })
    }
    return { ok: true, error: null, valid, issues: issues.slice(0, ADAPTER_ISSUE_CAP), issueCount: issues.length }
  }

  /**
   * `openspec show <change> --json --deltas-only`, normalized to
   * `(capability, operation, requirement)` touches. One RENAMED delta
   * (`rename: { from, to }`) expands to two touches, one per name; a delta
   * without `requirement.name`, or a rename without both names, is an error.
   */
  async showDeltas(root: string, change: string): Promise<ShowDeltasOutcome> {
    const call = await this.call(['show', change, '--json', '--deltas-only'], { cwd: root })
    if (call.timedOut) return { ok: false, error: `show ${change} timed out after ${this.timeoutMs}ms`, touches: [] }
    const parsed = parseJson(call.stdout)
    if (parsed === null) return { ok: false, error: `show ${change} returned no JSON (exit ${call.exitCode})`, touches: [] }
    const deltas = parsed.deltas
    if (!Array.isArray(deltas)) return { ok: false, error: `show ${change} returned an unknown shape`, touches: [] }
    const touches: SpecTouch[] = []
    for (const delta of deltas) {
      if (typeof delta !== 'object' || delta === null) return { ok: false, error: `show ${change} returned an unknown delta shape`, touches: [] }
      const capability = text((delta as Record<string, unknown>).spec)
      const operation = text((delta as Record<string, unknown>).operation)
      if (!capability || !operation) return { ok: false, error: `show ${change} returned a delta without spec or operation`, touches: [] }
      if (!(DELTA_OPERATIONS as readonly string[]).includes(operation)) {
        return { ok: false, error: `show ${change} returned a delta with unknown operation ${operation}`, touches: [] }
      }
      const rename = (delta as Record<string, unknown>).rename as Record<string, unknown> | undefined
      if (rename !== undefined) {
        const from = text(rename.from)
        const to = text(rename.to)
        if (!from || !to) return { ok: false, error: `show ${change} returned a RENAMED delta without both names`, touches: [] }
        touches.push({ capability, operation, requirement: from }, { capability, operation, requirement: to })
        continue
      }
      const requirement = (delta as Record<string, unknown>).requirement as Record<string, unknown> | undefined
      const name = requirement ? text(requirement.name) : null
      if (!name) return { ok: false, error: `show ${change} returned a ${operation} delta without requirement.name`, touches: [] }
      touches.push({ capability, operation, requirement: name })
    }
    return { ok: true, error: null, touches }
  }

  /** One CLI call through the pool, with the timeout the adapter was built with. */
  private async call(args: readonly string[], options: { cwd: string }): Promise<OpenspecCall> {
    await this.pool.acquire()
    try {
      return await this.run(args, { ...options, timeoutMs: this.timeoutMs })
    } finally {
      this.pool.release()
    }
  }
}

function parseJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The validate wrapper's item for this change: the item whose id names it, and nothing else. */
function itemFor(parsed: Record<string, unknown>, change: string): Record<string, unknown> | null {
  const items = parsed.items
  if (!Array.isArray(items)) return null
  return items.find((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === change) ?? null
}
