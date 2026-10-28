// Shared harness for the bounded token-evidence witnesses (bounded-log-reads
// D2/D3): an observer over every file-content API, a chunked log writer that
// never builds a whole-file string, line builders, argument-checking tmux and
// rg doubles, and a poller fixture over a temp Claude projects directory.
import { expect, spyOn } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalSession } from '../../../shared/types'
import { initDatabase, type SessionDatabase } from '../../db'
import { encodeProjectPath } from '../../logDiscovery'
import { LogPoller } from '../../logPoller'
import { handleMatchWorkerRequest } from '../../logMatchWorker'
import type { MatchWorkerRequest, MatchWorkerResponse } from '../../logMatchWorkerTypes'
import { SessionRegistry } from '../../SessionRegistry'

export type Op = { api: string; path: string; position?: number | null; length?: number; bytesRead?: number; bigint?: true }

// Captured before any spy: the doubles and the writer use these, so they
// never appear among the observed operations.
const raw = {
  openSync: fs.openSync.bind(fs),
  readSync: fs.readSync.bind(fs),
  writeSync: fs.writeSync.bind(fs),
  closeSync: fs.closeSync.bind(fs),
  fstatSync: fs.fstatSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
}

const CONTENT_APIS = [
  [fs, 'readFile'], [fs, 'createReadStream'], [fs, 'openAsBlob'],
  [fs.promises, 'readFile'], [fs.promises, 'open'], [Bun, 'file'],
] as const

/**
 * Records every open, positioned read (with bytes returned), fstat, close, and
 * whole-file or streaming API call, per path. `onRead` injects short reads or
 * concurrent writes; `mapFstat` injects stat failures or invalid generations.
 */
export class FsObserver {
  ops: Op[] = []
  private spies: Array<{ mockRestore(): void }> = []
  private fdPath = new Map<number, string>()
  onRead: ((fd: number, op: Op) => number | null) | null = null
  /** Replaces (or throws instead of) the stats an observed `fstatSync` returns. */
  mapFstat: ((stats: fs.BigIntStats, file: string) => fs.BigIntStats) | null = null

  start(): this {
    const asPath = (value: unknown) => (typeof value === 'number' ? this.fdPath.get(value) ?? `fd:${value}` : String(value))
    this.spies.push(spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      const fd = (raw.openSync as (...a: unknown[]) => number)(file, ...rest)
      this.fdPath.set(fd, String(file))
      this.ops.push({ api: 'open', path: String(file) })
      return fd
    }) as typeof fs.openSync))
    this.spies.push(spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      const op: Op = { api: 'read', path: asPath(fd), position, length }
      const injected = this.onRead?.(fd, op) ?? null
      op.bytesRead = injected ?? raw.readSync(fd, buffer, offset, length, position)
      if (injected !== null) raw.readSync(fd, buffer, offset, injected, position)
      this.ops.push(op)
      return op.bytesRead
    }) as typeof fs.readSync))
    this.spies.push(spyOn(fs, 'fstatSync').mockImplementation(((fd: number, ...rest: unknown[]) => {
      const bigint = (rest[0] as { bigint?: boolean } | undefined)?.bigint === true
      this.ops.push(bigint ? { api: 'fstat', path: asPath(fd), bigint } : { api: 'fstat', path: asPath(fd) })
      const stats = (raw.fstatSync as (...a: unknown[]) => unknown)(fd, ...rest)
      return this.mapFstat ? this.mapFstat(stats as fs.BigIntStats, asPath(fd)) : stats
    }) as typeof fs.fstatSync))
    this.spies.push(spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
      this.ops.push({ api: 'close', path: asPath(fd) })
      raw.closeSync(fd)
    }) as typeof fs.closeSync))
    this.spies.push(spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      this.ops.push({ api: 'readFile', path: asPath(file) })
      return (raw.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync))
    for (const [target, name] of CONTENT_APIS) {
      const original = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
      this.spies.push(spyOn(target as never, name as never).mockImplementation(((file: unknown, ...rest: unknown[]) => {
        this.ops.push({ api: name, path: asPath(file) })
        return original.call(target, file, ...rest)
      }) as never))
    }
    return this
  }

  stop(): void {
    for (const spy of this.spies.splice(0)) spy.mockRestore()
    this.onRead = null
    this.mapFstat = null
  }

  for(logPath: string): Op[] {
    return this.ops.filter((op) => op.path === logPath)
  }

  /** Bytes returned by positioned reads of `logPath`. */
  bytesRead(logPath: string): number {
    return this.for(logPath).reduce((sum, op) => sum + (op.api === 'read' ? op.bytesRead ?? 0 : 0), 0)
  }

  /** Any whole-file or streaming content API, on any path. */
  wholeFileCalls(): Op[] {
    return this.ops.filter((op) => !['open', 'read', 'fstat', 'close'].includes(op.api))
  }
}

/** A log part: literal text, or `fill` bytes of a repeated ASCII unit. */
export type Part = string | { fill: number; char?: string }

/** Writes `parts` through one descriptor in chunks of at most 1 MiB. */
export function writeChunked(logPath: string, parts: Part[], flag: 'w' | 'a' = 'w'): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const fd = raw.openSync(logPath, flag)
  let written = 0
  try {
    for (const part of parts) {
      if (typeof part === 'string') {
        written += raw.writeSync(fd, Buffer.from(part, 'utf8'))
        continue
      }
      const unit = part.char ?? 'x'
      const chunk = Buffer.alloc(Math.min(part.fill, Math.floor((1024 * 1024) / unit.length) * unit.length), unit)
      for (let left = part.fill; left > 0; left -= chunk.length) {
        written += raw.writeSync(fd, left >= chunk.length ? chunk : chunk.subarray(0, left))
      }
    }
  } finally {
    raw.closeSync(fd)
  }
  return written
}

export function userLine(text: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...extra, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`
}

export function assistantLine(text: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`
}

const FILLER_OPEN = '{"type":"progress","data":"'
const FILLER_CLOSE = '"}\n'

/** A valid JSON line of exactly `bytes` bytes (newline included) with no message text. */
export function fillerLine(bytes: number): Part[] {
  const body = bytes - FILLER_OPEN.length - FILLER_CLOSE.length
  if (body < 0) throw new Error(`filler line needs at least ${FILLER_OPEN.length + FILLER_CLOSE.length} bytes`)
  return [FILLER_OPEN, { fill: body }, FILLER_CLOSE]
}

/**
 * A user or assistant message line whose text is `prefix` followed by
 * `bytes` bytes of the repeated `unit`.
 */
export function giantMessageLine(
  role: 'user' | 'assistant', bytes: number, unit: string, extra: Record<string, unknown> = {}, prefix = ''
): Part[] {
  const head = JSON.stringify({ ...extra, type: role, message: { role, content: [{ type: 'text', text: prefix }] } })
  const cut = head.indexOf(`"text":${JSON.stringify(prefix)}`) + `"text":${JSON.stringify(prefix)}`.length - 1
  return [head.slice(0, cut), { fill: bytes, char: unit }, `${head.slice(cut)}\n`]
}

export const PROJECT = '/tmp/kawai-token-witness'

export function claudeLogPath(name: string): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', encodeProjectPath(PROJECT), `${name}.jsonl`)
}

/** A message long enough for exact matching, distinct per `seed`. */
export function matchMessage(seed: string): string {
  return Array.from({ length: 40 }, (_, i) => `${seed}${i}`).join(' ')
}

export function managedWindow(n: number): TerminalSession {
  const now = '2026-10-28T00:00:00.000Z'
  return {
    id: `window-${n}`, name: `witness-${n}`, tmuxWindow: `witness:${n}`, projectPath: PROJECT,
    status: 'waiting', lastActivity: now, createdAt: now, agentType: 'claude', source: 'managed',
  }
}

export class InlineMatchWorkerClient {
  requests: Array<Omit<MatchWorkerRequest, 'id'>> = []
  async poll(request: Omit<MatchWorkerRequest, 'id'>): Promise<MatchWorkerResponse> {
    this.requests.push(request)
    const response = await handleMatchWorkerRequest({ ...request, id: 'witness' })
    if (response.type === 'error') throw new Error(response.error ?? 'match worker error')
    return response
  }
  dispose(): void {}
}

/** rg over the files under its targets, read outside the observer; hits go to `sink`. */
function rgDouble(args: string[], sink: string[]) {
  expect(args[0]).toBe('rg')
  const pattern = args[args.indexOf('-e') + 1]
  expect(typeof pattern).toBe('string')
  const regex = new RegExp(pattern as string, 'm')
  const text = (file: string) => (raw.readFileSync as (f: string, e: string) => string)(file, 'utf8')
  if (args.includes('--json')) {
    const file = args[args.length - 1] ?? ''
    if (!fs.existsSync(file)) return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    const out = text(file).split('\n').flatMap((line, i) => (regex.test(line) ? [JSON.stringify({ type: 'match', data: { line_number: i + 1 } })] : []))
    if (out.length) sink.push(file)
    return { exitCode: out.length ? 0 : 1, stdout: Buffer.from(out.join('\n')), stderr: Buffer.from('') }
  }
  const targets = args.slice(args.indexOf('-e') + 2).filter((arg, i, all) => !arg.startsWith('-') && !['--threads', '--glob'].includes(all[i - 1] ?? ''))
  const files = targets.flatMap((t) => listJsonl(t))
  const hits = files.filter((file) => regex.test(text(file)))
  sink.push(...hits)
  return { exitCode: hits.length ? 0 : 1, stdout: Buffer.from(hits.join('\n')), stderr: Buffer.from('') }
}

function listJsonl(target: string): string[] {
  if (!fs.existsSync(target)) return []
  if (fs.statSync(target).isFile()) return [target]
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listJsonl(path.join(target, e.name)) : e.name.endsWith('.jsonl') ? [path.join(target, e.name)] : [])
}

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync; spawn: typeof Bun.spawn }

/**
 * Temp CLAUDE/CODEX/PI homes, the tmux and rg doubles, and an in-memory
 * database. `dispose` restores everything.
 */
export class WitnessEnv {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-token-'))
  tmux = new Map<string, string>()
  /** Every log the rg double reported as holding a searched message. */
  rgHits: string[] = []
  db: SessionDatabase = initDatabase({ path: ':memory:' })
  registry = new SessionRegistry()
  private saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, pi: process.env.PI_HOME }
  private spawnSync = bunAny.spawnSync
  private spawn = bunAny.spawn

  constructor() {
    process.env.CLAUDE_CONFIG_DIR = path.join(this.root, 'claude')
    process.env.CODEX_HOME = path.join(this.root, 'codex')
    process.env.PI_HOME = path.join(this.root, 'pi')
    const answer = (args: string[]) => {
      if (args[0] === 'rg') return rgDouble(args, this.rgHits)
      expect(args[0]).toBe('tmux')
      const target = args[args.indexOf('-t') + 1] ?? ''
      return { exitCode: 0, stdout: Buffer.from(this.tmux.get(target) ?? ''), stderr: Buffer.from('') }
    }
    bunAny.spawnSync = ((args: string[]) => answer(args)) as unknown as typeof Bun.spawnSync
    bunAny.spawn = ((args: string[]) => {
      const result = answer(args)
      const stream = (buf: Buffer) => new ReadableStream({ start(c) { c.enqueue(buf); c.close() } })
      return { exited: Promise.resolve(result.exitCode), stdout: stream(result.stdout), stderr: stream(result.stderr), kill() {}, pid: 1 }
    }) as unknown as typeof Bun.spawn
  }

  /** A managed window whose scrollback shows `message` as the last exchange. */
  showWindow(n: number, message: string): TerminalSession {
    const session = managedWindow(n)
    this.tmux.set(session.tmuxWindow, `❯ previous\n⏺ ${message}\n❯ ${message}\n`)
    this.registry.replaceSessions([...this.registry.getAll().filter((s) => s.id !== session.id), session])
    return session
  }

  poller(): { poller: LogPoller; worker: InlineMatchWorkerClient; emptyLogCache: Map<string, string> } {
    const worker = new InlineMatchWorkerClient()
    const poller = new LogPoller(this.db, this.registry, { matchWorkerClient: worker })
    const emptyLogCache = (poller as unknown as { emptyLogCache: Map<string, string> }).emptyLogCache
    return { poller, worker, emptyLogCache }
  }

  dispose(): void {
    bunAny.spawnSync = this.spawnSync
    bunAny.spawn = this.spawn
    this.db.close()
    fs.rmSync(this.root, { recursive: true, force: true })
    for (const [key, value] of [['CLAUDE_CONFIG_DIR', this.saved.claude], ['CODEX_HOME', this.saved.codex], ['PI_HOME', this.saved.pi]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
