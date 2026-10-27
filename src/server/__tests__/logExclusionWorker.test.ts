// Witness WX (bounded-log-reads D1): the staged F → R → H chat-transcript
// exclusion through the real match-worker request handler, over temp Claude
// and Codex logs, with an observer on every file-open and content-read API.
// tmux and rg are argument-checking doubles; rg answers from the contents
// this file wrote, so it adds no file reads of its own.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalSession } from '../../shared/types'
import type { SessionSnapshot } from '../logMatchGate'
import { handleMatchWorkerRequest } from '../logMatchWorker'
import type { MatchWorkerRequest, MatchWorkerResponse } from '../logMatchWorkerTypes'
import type { KnownSession } from '../logPollData'

type Op = { api: string; path: string; position?: number | null; length?: number }
type Result = Required<Pick<MatchWorkerResponse, 'entries' | 'orphanEntries' | 'matches' | 'orphanMatches'>>

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const EXCLUDED_F = ID(1)
const EXCLUDED_R = ID(2)
const EXCLUDED_B = ID(3)
const EXCLUDED_H = ID(4)
const EXCLUDE = [EXCLUDED_F, EXCLUDED_R, EXCLUDED_B, EXCLUDED_H]

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync; spawn: typeof Bun.spawn }
const originalSpawnSync = bunAny.spawnSync
const originalSpawn = bunAny.spawn
const savedEnv = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, pi: process.env.PI_HOME }

let root = ''
let ops: Op[] = []
let rgTargets: string[] = []
const contents = new Map<string, string>()
const tmux = new Map<string, string>()
const spies: Array<{ mockRestore(): void }> = []

function observe() {
  const fdPath = new Map<number, string>()
  const record = (op: Op) => ops.push(op)
  const asPath = (value: unknown) => (typeof value === 'number' ? fdPath.get(value) ?? `fd:${value}` : String(value))
  const openSync = fs.openSync.bind(fs)
  const readSync = fs.readSync.bind(fs)
  const readFileSync = fs.readFileSync.bind(fs)
  const fstatSync = fs.fstatSync.bind(fs)
  spies.push(spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
    const fd = (openSync as (...a: unknown[]) => number)(file, ...rest)
    fdPath.set(fd, String(file))
    record({ api: 'open', path: String(file) })
    return fd
  }) as typeof fs.openSync))
  spies.push(spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    record({ api: 'read', path: asPath(fd), position, length })
    return readSync(fd, buffer, offset, length, position)
  }) as typeof fs.readSync))
  spies.push(spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    record({ api: 'readFile', path: asPath(file) })
    return (readFileSync as (...a: unknown[]) => unknown)(file, ...rest)
  }) as typeof fs.readFileSync))
  spies.push(spyOn(fs, 'fstatSync').mockImplementation(((fd: number, ...rest: unknown[]) => {
    record({ api: 'fstat', path: asPath(fd) })
    return (fstatSync as (...a: unknown[]) => unknown)(fd, ...rest)
  }) as typeof fs.fstatSync))
  // The log readers use none of these; any call is recorded as a read.
  for (const [target, name] of [[fs, 'readFile'], [fs, 'createReadStream'], [fs, 'openAsBlob'], [fs.promises, 'readFile'], [fs.promises, 'open']] as const) {
    const original = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
    spies.push(spyOn(target as never, name as never).mockImplementation(((file: unknown, ...rest: unknown[]) => {
      record({ api: name, path: asPath(file) })
      return original.call(target, file, ...rest)
    }) as never))
  }
}

function opsFor(logPath: string): Op[] {
  return ops.filter((op) => op.path === logPath)
}

/** Only the bounded head identity parse: opens and position-0 reads of at most 1 MiB. */
function expectIdentityOnly(logPath: string, parses = 1) {
  const seen = opsFor(logPath)
  expect(seen.filter((op) => op.api === 'open')).toHaveLength(parses)
  expect(seen.filter((op) => op.api !== 'open' && op.api !== 'read')).toEqual([])
  for (const op of seen.filter((o) => o.api === 'read')) {
    expect(op.position).toBe(0)
    expect(op.length).toBeLessThanOrEqual(1024 * 1024)
  }
}

function expectAbsent(result: Result, logPath: string) {
  expect(result.entries.map((e) => e.logPath)).not.toContain(logPath)
  expect(result.orphanEntries.map((e) => e.logPath)).not.toContain(logPath)
  expect(result.matches.map((m) => m.logPath)).not.toContain(logPath)
  expect(result.orphanMatches.map((m) => m.logPath)).not.toContain(logPath)
  expect(rgTargets).not.toContain(logPath)
}

function userLine(text: string, extra: Record<string, unknown>) {
  return JSON.stringify({ ...extra, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
}

function write(logPath: string, body: string, mtimeSec?: number) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, body)
  contents.set(logPath, body)
  if (mtimeSec) fs.utimesSync(logPath, mtimeSec, mtimeSec)
  return logPath
}

/** A Claude log whose head names `headId` (or no id), holding one message. */
function claudeLog(name: string, headId: string | null, message: string, mtimeSec?: number) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', '-tmp-wx')
  const head = headId ? { sessionId: headId, cwd: '/tmp/wx', slug: name } : { cwd: '/tmp/wx' }
  return write(path.join(dir, `${name}.jsonl`), `${userLine(message, head)}\n`, mtimeSec)
}

/** A Codex rollout whose file name carries `threadId` and whose session_meta names `headId`. */
function codexLog(threadId: string, headId: string, message: string) {
  const dir = path.join(process.env.CODEX_HOME as string, 'sessions', '2026', '10', '28')
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: headId, cwd: '/tmp/wx', source: 'cli' } })
  return write(path.join(dir, `rollout-2026-10-28T00-00-00-${threadId}.jsonl`), `${meta}\n${userLine(message, {})}\n`)
}

function known(logFilePath: string, sessionId: string, agentType: 'claude' | 'codex' = 'claude'): KnownSession {
  return { logFilePath, sessionId, projectPath: '/tmp/wx', slug: 'kept', agentType, isCodexExec: false }
}

function window(n: number, message: string): TerminalSession {
  const tmuxWindow = `wx:${n}`
  tmux.set(tmuxWindow, `❯ ${message}\n⏺ ok\n`)
  return {
    id: `w${n}`, name: `w${n}`, tmuxWindow, projectPath: '/tmp/wx', status: 'working',
    lastActivity: '2026-10-28T00:00:00.000Z', createdAt: '2026-10-28T00:00:00.000Z', agentType: 'claude', source: 'managed',
  }
}

/** Unread snapshot: a present entry gets its last user message read. */
function snapshot(logFilePath: string, sessionId: string): SessionSnapshot {
  return { sessionId, logFilePath, currentWindow: null, lastActivityAt: '2026-10-28T00:00:00.000Z', lastUserMessage: null, lastKnownLogSize: 0 }
}

function rgDouble(args: string[]) {
  expect(args[0]).toBe('rg')
  const pattern = args[args.indexOf('-e') + 1]
  expect(typeof pattern).toBe('string')
  const regex = new RegExp(pattern as string, 'm')
  const targets = args.slice(args.indexOf('-e') + 2).filter((arg, i, all) => !arg.startsWith('-') && !['--threads', '--glob'].includes(all[i - 1] ?? ''))
  const files = [...contents.keys()].filter((file) => targets.some((t) => file === t || file.startsWith(t + path.sep)))
  rgTargets.push(...files)
  const hits = files.filter((file) => regex.test(contents.get(file) ?? ''))
  if (args.includes('--json')) {
    const lines = (contents.get(files[0] ?? '') ?? '').split('\n')
    const out = lines.flatMap((line, i) => (regex.test(line) ? [JSON.stringify({ type: 'match', data: { line_number: i + 1 } })] : []))
    return { exitCode: out.length ? 0 : 1, stdout: Buffer.from(out.join('\n')), stderr: Buffer.from('') }
  }
  return { exitCode: hits.length ? 0 : 1, stdout: Buffer.from(hits.join('\n')), stderr: Buffer.from('') }
}

function spawnSyncDouble(args: string[]) {
  if (args[0] === 'rg') return rgDouble(args)
  expect(args[0]).toBe('tmux')
  const target = args[args.indexOf('-t') + 1] ?? ''
  expect(tmux.has(target)).toBe(true)
  return { exitCode: 0, stdout: Buffer.from(tmux.get(target) ?? ''), stderr: Buffer.from('') }
}

async function run(request: Partial<MatchWorkerRequest>): Promise<Result> {
  observe()
  try {
    const response = await handleMatchWorkerRequest({
      id: 'wx', windows: [], maxLogsPerPoll: 50, sessions: [], scrollbackLines: 25, ...request,
    })
    if (response.type !== 'result') throw new Error(`worker error: ${JSON.stringify(response)}`)
    const { entries = [], orphanEntries = [], matches = [], orphanMatches = [] } = response
    return { entries, orphanEntries, matches, orphanMatches }
  } finally {
    for (const spy of spies.splice(0)) spy.mockRestore()
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-wx-'))
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  process.env.CODEX_HOME = path.join(root, 'codex')
  process.env.PI_HOME = path.join(root, 'pi')
  ops = []
  rgTargets = []
  contents.clear()
  tmux.clear()
  bunAny.spawnSync = ((args: string[]) => spawnSyncDouble(args)) as unknown as typeof Bun.spawnSync
  bunAny.spawn = ((args: string[]) => {
    const result = spawnSyncDouble(args)
    const stream = (buf: Buffer) => new ReadableStream({ start(c) { c.enqueue(buf); c.close() } })
    return { exited: Promise.resolve(result.exitCode), stdout: stream(result.stdout), stderr: stream(result.stderr), kill() {}, pid: 1 }
  }) as unknown as typeof Bun.spawn
})

afterEach(() => {
  bunAny.spawnSync = originalSpawnSync
  bunAny.spawn = originalSpawn
  fs.rmSync(root, { recursive: true, force: true })
  for (const [key, value] of [['CLAUDE_CONFIG_DIR', savedEnv.claude], ['CODEX_HOME', savedEnv.codex], ['PI_HOME', savedEnv.pi]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** The collector corpus: every row X0–X4 as new and known logs. */
function collectorCorpus() {
  const logs = {
    fNew: codexLog(EXCLUDED_F, ID(20), 'wx rollout f new'),
    // A known log whose name carries the excluded thread id: F hits first.
    fKnown: claudeLog(`rollout-2026-10-28T00-00-00-${EXCLUDED_F}`, ID(21), 'wx claude f known'),
    rKnown: claudeLog('r-known', ID(22), 'wx known r'),
    knownAheadB: claudeLog('known-a-head-b', EXCLUDED_B, 'wx known a head b'),
    newHeadH: claudeLog('new-head-h', EXCLUDED_H, 'wx new head h'),
    knownControl: claudeLog('known-control', ID(30), 'wx known control'),
    newControl: claudeLog('new-control', ID(31), 'wx new control'),
    codexControl: codexLog(ID(32), ID(32), 'wx codex control'),
    newUnresolved: claudeLog('new-unresolved', null, 'wx new unresolved'),
    knownUnresolved: claudeLog('known-unresolved', null, 'wx known unresolved'),
  }
  const knownSessions = [
    known(logs.fKnown, ID(21)),
    known(logs.rKnown, EXCLUDED_R),
    known(logs.knownAheadB, ID(10)),
    known(logs.knownControl, ID(30)),
    known(logs.knownUnresolved, ID(33)),
  ]
  const sessions = knownSessions.map((k) => snapshot(k.logFilePath, k.sessionId))
  const windows = [
    window(1, 'wx known a head b'), window(2, 'wx new head h'), window(3, 'wx known r'),
    window(4, 'wx known control'), window(5, 'wx new control'),
  ]
  return { logs, knownSessions, sessions, windows }
}

describe('WX: staged exclusion through handleMatchWorkerRequest', () => {
  for (const mode of ['batch', 'paths'] as const) {
    // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Rollout excluded by file name
    // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Chat record excluded without a read
    // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Excluded head id on any candidate
    // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Unresolved head identity
    // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Unexcluded logs unchanged
    test(`${mode} collector: rows X0–X4 for new and known logs, known A / head B dropped`, async () => {
      const { logs, knownSessions, sessions, windows } = collectorCorpus()
      const result = await run({
        windows, sessions, knownSessions, excludeSessionIds: EXCLUDE,
        ...(mode === 'paths' ? { preFilteredPaths: Object.values(logs) } : {}),
      })

      // X0 / X1: never opened, absent everywhere.
      for (const p of [logs.fNew, logs.fKnown, logs.rKnown]) {
        expect(opsFor(p)).toEqual([])
        expectAbsent(result, p)
      }
      // X2, the named witness and a new log: one identity parse, nothing else.
      for (const p of [logs.knownAheadB, logs.newHeadH]) {
        expectIdentityOnly(p)
        expect(opsFor(p)).toEqual([{ api: 'open', path: p }, { api: 'read', path: p, position: 0, length: 64 * 1024 }])
        expectAbsent(result, p)
      }
      // X3 controls: present, enriched and matched as before (positive
      // controls: the observer sees their token and last-message reads).
      const byPath = new Map(result.entries.map((e) => [e.logPath, e]))
      expect(byPath.get(logs.newControl)?.sessionId).toBe(ID(31))
      expect(byPath.get(logs.knownControl)?.sessionId).toBe(ID(30))
      expect(byPath.get(logs.codexControl)?.agentType).toBe('codex')
      expect(opsFor(logs.newControl).some((op) => op.api === 'readFile')).toBe(true)
      expect(opsFor(logs.knownControl).some((op) => op.api === 'fstat')).toBe(true)
      expect(byPath.get(logs.knownControl)?.lastUserMessage).toBe('wx known control')
      expect(result.matches).toContainEqual({ logPath: logs.newControl, tmuxWindow: 'wx:5' })
      expect(result.matches).toContainEqual({ logPath: logs.knownControl, tmuxWindow: 'wx:4' })
      // X4: kept; nothing fabricated, stored metadata kept.
      expect(byPath.get(logs.newUnresolved)?.sessionId).toBeNull()
      expect(byPath.get(logs.knownUnresolved)?.sessionId).toBe(ID(33))
      expect(result.entries).toHaveLength(5)
    })
  }

  // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Chat record excluded without a read
  // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Excluded head id on any candidate
  test('orphan and backfill records: rows X0–X4, and a dropped path is never reintroduced', async () => {
    const o = {
      f: codexLog(EXCLUDED_F, ID(40), 'wx orphan f'),
      r: claudeLog('orphan-r', ID(41), 'wx orphan r'),
      aHeadB: claudeLog('orphan-a-head-b', EXCLUDED_B, 'wx orphan a head b'),
      control: claudeLog('orphan-control', ID(42), 'wx orphan control'),
      unresolved: claudeLog('orphan-unresolved', null, 'wx orphan unresolved'),
    }
    const b = {
      r: claudeLog('backfill-r', ID(51), 'wx backfill r'),
      aHeadB: claudeLog('backfill-a-head-b', EXCLUDED_H, 'wx backfill a head b'),
      control: claudeLog('backfill-control', ID(52), 'wx backfill control'),
      unresolved: claudeLog('backfill-unresolved', null, 'wx backfill unresolved'),
    }
    const collected = claudeLog('collected-known-a-head-b', EXCLUDED_B, 'wx collected a head b')
    const orphan = (logFilePath: string, sessionId: string) => ({ sessionId, logFilePath, projectPath: '/tmp/wx', agentType: 'claude' as const, currentWindow: null })
    const backfill = (logFilePath: string, sessionId: string) => ({ sessionId, logFilePath, projectPath: '/tmp/wx', agentType: 'claude' as const })
    const result = await run({
      windows: [window(1, 'wx orphan a head b'), window(2, 'wx orphan control'), window(3, 'wx collected a head b')],
      preFilteredPaths: [collected],
      knownSessions: [known(collected, ID(60))],
      excludeSessionIds: EXCLUDE,
      forceOrphanRematch: true,
      orphanCandidates: [
        { ...orphan(o.f, ID(40)), agentType: 'codex' }, orphan(o.r, EXCLUDED_R), orphan(o.aHeadB, ID(43)),
        orphan(o.control, ID(42)), orphan(o.unresolved, ID(44)),
      ],
      lastMessageCandidates: [
        backfill(b.r, EXCLUDED_R), backfill(b.aHeadB, ID(53)), backfill(b.control, ID(52)), backfill(b.unresolved, ID(54)),
        // Reintroduction: paths the collector and the orphan stage dropped.
        backfill(collected, ID(60)), backfill(o.aHeadB, ID(43)),
      ],
    })

    for (const p of [o.f, o.r, b.r]) {
      expect(opsFor(p)).toEqual([])
      expectAbsent(result, p)
    }
    for (const p of [o.aHeadB, b.aHeadB, collected]) {
      expectIdentityOnly(p)
      expectAbsent(result, p)
    }
    expect(result.orphanEntries.map((e) => e.logPath).sort()).toEqual([o.control, o.unresolved].sort())
    expect(result.orphanMatches).toEqual([{ logPath: o.control, tmuxWindow: 'wx:2' }])
    expect(opsFor(o.control).some((op) => op.api === 'readFile')).toBe(true)
    const backfilled = new Map(result.entries.map((e) => [e.logPath, e]))
    expect([...backfilled.keys()].sort()).toEqual([b.control, b.unresolved].sort())
    expect(backfilled.get(b.control)?.lastUserMessage).toBe('wx backfill control')
    expect(backfilled.get(b.unresolved)?.sessionId).toBe(ID(54))
  })

  // @covers: terminal-streaming › Log discovery excludes chat transcripts before reading their content › Unexcluded logs unchanged
  test('no exclude set: every log is kept and known logs get no head read', async () => {
    const { logs, knownSessions, windows } = collectorCorpus()
    // Snapshots already hold a last message at the current size, so a known
    // log is opened only if something parses its head.
    const sessions = knownSessions.map((k) => ({
      ...snapshot(k.logFilePath, k.sessionId), lastUserMessage: 'seen', lastKnownLogSize: fs.statSync(k.logFilePath).size,
    }))
    for (const excludeSessionIds of [undefined, []]) {
      ops = []
      const result = await run({ windows, sessions, knownSessions, excludeSessionIds })
      expect(result.entries.map((e) => e.logPath).sort()).toEqual(Object.values(logs).sort())
      for (const k of knownSessions) expect(opsFor(k.logFilePath)).toEqual([])
    }
    // Positive control: with a set (even of unrelated ids) each known log
    // costs exactly one bounded head parse.
    ops = []
    await run({ windows, sessions, knownSessions, excludeSessionIds: [ID(99)] })
    for (const k of knownSessions) {
      expect(opsFor(k.logFilePath)).toEqual([{ api: 'open', path: k.logFilePath }, { api: 'read', path: k.logFilePath, position: 0, length: 64 * 1024 }])
    }
  })

  test('maxLogs selects the newest before exclusion; excluded logs keep their slots', async () => {
    const newest = claudeLog('newest-excluded', EXCLUDED_H, 'wx newest', 2_000_000_000)
    const middle = claudeLog('middle-control', ID(70), 'wx middle', 1_900_000_000)
    const oldest = claudeLog('oldest-control', ID(71), 'wx oldest', 1_800_000_000)
    const result = await run({ maxLogsPerPoll: 2, excludeSessionIds: EXCLUDE })
    expect(result.entries.map((e) => e.logPath)).toEqual([middle])
    expectIdentityOnly(newest)
    expect(opsFor(oldest)).toEqual([])
  })
})
