// @reads: openspec/changes/process-quota-history-and-incident-advice/design.md, src/server/__tests__/quota*.test.ts, src/server/__tests__/chatSessionManager.provider-usage-*.test.ts
// Table S completeness (process-quota-history-and-incident-advice V1,
// decision-ed5e5e77 option A). The domain is reasons × reader × in flight ×
// event: 4 × 2 × 2 × 11 = 176 combinations. Every combination falls in
// exactly one class: a literal row S1–S14, a bound rule (B1–B6, the B3
// drain of decision-760c0f6f (a), P1) applied through a stated equivalence,
// or an unreachable claim with its reason. Each reachable class names the
// tests that exercise it, and each named test must exist under that exact
// title. Every literal row's own combinations must land in its own class.
//
// Axes are the state before the event, except for the two settlement
// events (`3rd consecutive failure`, `success after failures`): there the
// in-flight axis records the settled state, as rows S5 and S6 do — the
// settling request was in flight just before; "yes" means another request
// is current after it settles. `unsubscribe` and `worker removed` both
// remove the key's worker reason (one team's subscription; the last one
// takes the reason); the pre-event reasons tell S7 from S8. A spawn pull's
// reasons are those before the starting session is counted.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const REASONS = ['none', 'session', 'worker', 'both'] as const
const READERS = ['standalone', 'agent-only'] as const
const IN_FLIGHT = ['no', 'yes'] as const
const EVENTS = [
  'subscribe', 'tick', 'timeout', '3rd consecutive failure', 'success after failures', 'unsubscribe',
  'worker removed', 'spawn pull', 'shutdown', 'restart', 'config change of credential',
] as const

type Reason = (typeof REASONS)[number]
type Reader = (typeof READERS)[number]
type InFlight = (typeof IN_FLIGHT)[number]
type Event = (typeof EVENTS)[number]
interface Combination { reasons: Reason; reader: Reader; inFlight: InFlight; event: Event }

/** A test that exercises a class: its file under src/server/__tests__ and its exact title. */
interface Evidence { file: string; title: string }

interface Class {
  id: string
  /** The governing row or bound rule, or `unreachable`. */
  rule: string
  /** What happens, or why the combination cannot occur. */
  statement: string
  match: (c: Combination) => boolean
  evidence: Evidence[]
}

const TABLE_S = 'quotaReaderTableS.test.ts'
const CLASSES_FILE = 'quotaReaderTableSClasses.test.ts'
const COMPOSITION = 'quotaReaderComposition.test.ts'
const ACCOUNTS = 'quotaReaderAccounts.test.ts'
const row = (title: string): Evidence => ({ file: TABLE_S, title })
const cls = (title: string): Evidence => ({ file: CLASSES_FILE, title })
const P1: Evidence = { file: 'quotaReaderP1.property.test.ts', title: 'P1: at most one request per account key, none after the last unsubscribe or shutdown (seed 0x51A7, 200 cases)' }
const JOINED: Evidence = { file: ACCOUNTS, title: 'a spawn pull and a worker subscription during held requests join them: one fetch each time, and both teams\' histories get it' }
const ROTATION: Evidence = { file: ACCOUNTS, title: 'after a rotation a session on the new key pulls its own account, not the retired worker key\'s, and the new key\'s observation reaches the worker and session teams' }
const SESSION_TICK: Evidence = { file: 'chatSessionManager.provider-usage-refresh.test.ts', title: 'a routed profile refreshes on the cadence without a turn' }
const SESSION_STOP: Evidence = { file: 'chatSessionManager.provider-usage-lifecycle.test.ts', title: 'archiving the last live session stops the pulls' }
const SESSION_FAILURE: Evidence = { file: 'chatSessionManager.provider-usage-cadence.test.ts', title: 'a failed first pull still arms the cadence; the next tick shows the meters' }
const AGENT_LIFECYCLE = cls('agent-only lifecycle: each team, a removal and re-add, a restart and a configuration change record one unsupported observation; nothing is requested')

const std = (c: Combination) => c.reader === 'standalone'
const agent = (c: Combination) => c.reader === 'agent-only'
const busy = (c: Combination) => c.inFlight === 'yes'
const is = (c: Combination, ...events: Event[]) => events.includes(c.event)
const among = (c: Combination, ...reasons: Reason[]) => reasons.includes(c.reasons)
const SETTLEMENT: Event[] = ['3rd consecutive failure', 'success after failures']
const REMOVAL: Event[] = ['unsubscribe', 'worker removed']
/** Events whose agent-only in-flight state is unreachable (shutdown is S11's literal domain; tick and settlements have their own claims). */
const AGENT_BUSY_EVENTS: Event[] = ['subscribe', 'timeout', 'unsubscribe', 'worker removed', 'spawn pull', 'restart', 'config change of credential']

const CLASSES: Class[] = [
  // ------------------------------------------------------------ subscribe
  { id: 'S1', rule: 'S1', statement: 'one request now; timer armed', match: c => is(c, 'subscribe') && c.reasons === 'none' && std(c) && !busy(c), evidence: [row('S1: one request now; timer armed')] },
  { id: 'sub-drain', rule: 'B1, B3, P1', statement: 'a subscription during the B3 drain joins the in-flight request (no second request); the timer arms after it settles',
    match: c => is(c, 'subscribe') && c.reasons === 'none' && std(c) && busy(c), evidence: [cls('subscribe during a drained request joins it, then arms the timer')] },
  { id: 'sub-session', rule: 'B1, B6, P1', statement: 'a new worker key a same-key session holds: idle polls once now, busy joins the request; the session cadence then serves it',
    match: c => is(c, 'subscribe') && c.reasons === 'session' && std(c), evidence: [cls('a new worker key a same-key session cadence holds polls once, joining a request in flight, then the session cadence serves it'), JOINED] },
  { id: 'S13-sub', rule: 'S13, B1', statement: 'a subscription on a key that already has a worker reason adds only the team; a request in flight settles to it too',
    match: c => is(c, 'subscribe') && among(c, 'worker', 'both') && std(c), evidence: [row('S13: one request; both teams\' histories get it'), cls('a second team subscribing while a request is in flight is added to that settlement')] },
  { id: 'S9', rule: 'S9', statement: 'no request; one unsupported observation per team and configuration; no agent launched (a session reason keeps S10)',
    match: c => is(c, 'subscribe') && agent(c) && !busy(c), evidence: [row('S9: no request; one `unsupported` observation; no agent launched'), AGENT_LIFECYCLE] },
  // ----------------------------------------------------------------- tick
  { id: 'tick-none', rule: 'S7, B6', statement: 'no worker timer survives S7; the session cadence tick finding no live session stops the cadence and requests nothing (a drained request is untouched)',
    match: c => is(c, 'tick') && c.reasons === 'none' && std(c), evidence: [row('S7: timer removed; no further request'), SESSION_STOP] },
  { id: 'tick-session', rule: 'B6', statement: 'today\'s fixed session cadence: one request through the gate', match: c => is(c, 'tick') && c.reasons === 'session' && std(c) && !busy(c), evidence: [SESSION_TICK] },
  { id: 'tick-session-busy', rule: 'B6, P1', statement: 'the session tick joins the request in flight: no new request', match: c => is(c, 'tick') && c.reasons === 'session' && std(c) && busy(c), evidence: [JOINED] },
  { id: 'S2', rule: 'S2, S13', statement: 'one request; next at cadence ± jitter; with two teams on the key, both teams\' histories get it (S13)',
    match: c => is(c, 'tick') && c.reasons === 'worker' && std(c) && !busy(c), evidence: [row('S2: one request; next at cadence ± jitter'), row('S13: one request; both teams\' histories get it')] },
  { id: 'S3', rule: 'S3', statement: 'no new request', match: c => is(c, 'tick') && among(c, 'worker', 'both') && std(c) && busy(c), evidence: [row('S3: no new request'), JOINED] },
  { id: 'tick-both', rule: 'B6, S8', statement: 'the same-key session cadence serves the key: one request per cadence, the worker tick reschedules without one',
    match: c => is(c, 'tick') && c.reasons === 'both' && std(c) && !busy(c), evidence: [row('S8: cadence continues (session reason)')] },
  { id: 'tick-agent', rule: 'unreachable', statement: 'no timer is armed for an agent-only key: no worker timer (S9) and the session cadence is armed only for a provider pulled through its base URL (S10)',
    match: c => is(c, 'tick') && agent(c), evidence: [] },
  // -------------------------------------------------------------- timeout
  { id: 'timeout-idle', rule: 'unreachable', statement: 'the 10 s bound runs only on an outstanding request', match: c => is(c, 'timeout') && !busy(c), evidence: [] },
  { id: 'S4', rule: 'S4', statement: 'request abandoned; failure counted; backoff (with a session reason the same-key cadence keeps serving, B6)',
    match: c => is(c, 'timeout') && among(c, 'worker', 'both') && std(c) && busy(c), evidence: [row('S4: request abandoned; failure counted; backoff')] },
  { id: 'timeout-session', rule: 'B6', statement: 'abandoned at the bound as a failure; the fixed session cadence has no backoff; the held report stays',
    match: c => is(c, 'timeout') && c.reasons === 'session' && std(c) && busy(c), evidence: [cls('a session-reason request abandoned at the bound keeps the fixed cadence with no backoff')] },
  { id: 'timeout-drain', rule: 'B3 (decision-760c0f6f (a))', statement: 'the drained request is recorded as a failure with its original reason; nothing is rescheduled',
    match: c => is(c, 'timeout') && c.reasons === 'none' && std(c) && busy(c), evidence: [cls('a drained request that times out is recorded as a failure with its original reason and schedules nothing')] },
  // ----------------------------------------------------------- settlements
  { id: 'S5', rule: 'S5', statement: 'next delay 4 min (bounded at 30); with a session reason the worker backoff defers to the same-key cadence (B6)',
    match: c => is(c, '3rd consecutive failure') && among(c, 'worker', 'both') && std(c) && !busy(c), evidence: [row('S5: next delay 4 min (bounded at 30)')] },
  { id: 'S6', rule: 'S6', statement: 'backoff reset; windows replaced only if newer', match: c => is(c, 'success after failures') && among(c, 'worker', 'both') && std(c) && !busy(c), evidence: [row('S6: backoff reset; windows replaced only if newer')] },
  { id: 'settle-session', rule: 'B6', statement: 'the fixed session cadence: no backoff to grow or reset; a failure keeps the held report, a success replaces it',
    match: c => is(c, ...SETTLEMENT) && c.reasons === 'session' && std(c) && !busy(c), evidence: [SESSION_FAILURE, cls('a session-reason request abandoned at the bound keeps the fixed cadence with no backoff')] },
  { id: 'settle-drain', rule: 'B3 (decision-760c0f6f (a))', statement: 'the drained settlement is recorded with its original reason and time; nothing is rescheduled or published live',
    match: c => is(c, ...SETTLEMENT) && c.reasons === 'none' && std(c) && !busy(c), evidence: [row('S7: timer removed; no further request'), cls('a drained request that times out is recorded as a failure with its original reason and schedules nothing')] },
  { id: 'settle-late', rule: 'S4, P1', statement: 'one request per key is in flight, so a settlement with another request current can only be a late answer to an attempt abandoned at the bound: it is dropped (no settlement, no publication, no backoff change) and the current request settles normally',
    match: c => is(c, ...SETTLEMENT) && std(c) && busy(c), evidence: [cls('a late answer to an abandoned request is dropped while the current request settles normally'), P1] },
  { id: 'settle-agent', rule: 'unreachable', statement: 'the reader service never requests an agent-only target (no worker poll, S9; the session tick and spawn pull skip a target without a base URL, S10), so nothing of it settles',
    match: c => is(c, ...SETTLEMENT) && agent(c), evidence: [] },
  // --------------------------------------------------------------- removal
  { id: 'S7', rule: 'S7, B3', statement: 'timer removed; no further request; a request in flight drains (B3); with another team still listing the key only that team leaves the fan-out',
    match: c => is(c, ...REMOVAL) && c.reasons === 'worker' && std(c), evidence: [row('S7: timer removed; no further request'), cls('removing one of two teams keeps polling the key for the other team only')] },
  { id: 'S8', rule: 'S8', statement: 'cadence continues (session reason)', match: c => is(c, ...REMOVAL) && c.reasons === 'both' && std(c), evidence: [row('S8: cadence continues (session reason)')] },
  { id: 'removal-agent', rule: 'S9', statement: 'the unsupported record is cleared, so a re-added worker reports once again; no request (a session reason keeps S10)',
    match: c => is(c, ...REMOVAL) && among(c, 'worker', 'both') && agent(c) && !busy(c), evidence: [AGENT_LIFECYCLE] },
  { id: 'removal-none', rule: 'unreachable', statement: 'these events remove an existing worker subscription of the key; reconciliation computes removals only from existing worker entries, so a key without a worker reason has none to remove',
    match: c => is(c, ...REMOVAL) && among(c, 'none', 'session') && !(agent(c) && busy(c)), evidence: [] },
  // ------------------------------------------------------------ spawn pull
  { id: 'spawn', rule: 'S10, B6', statement: 'the starting session adds the session reason (none ≡ session, worker ≡ both): today\'s spawn pull through the gate, one request; a provider already routed on this key arms its cadence without one, and a worker on another key never counts (B5)',
    match: c => is(c, 'spawn pull') && std(c) && !busy(c), evidence: [SESSION_FAILURE, ROTATION] },
  { id: 'spawn-busy', rule: 'P1', statement: 'the spawn pull joins the request in flight: one fetch, and the session\'s team receives its settlement', match: c => is(c, 'spawn pull') && std(c) && busy(c), evidence: [JOINED] },
  { id: 'S10', rule: 'S10', statement: 'today\'s spawn pull unchanged', match: c => is(c, 'spawn pull') && agent(c) && !busy(c), evidence: [row('S10: today\'s spawn pull unchanged')] },
  // -------------------------------------------------------------- shutdown
  { id: 'S11', rule: 'S11', statement: 'timer cancelled; in-flight result discarded, nothing published (an agent-only key has no service request: only its timers go)',
    match: c => is(c, 'shutdown') && busy(c), evidence: [row('S11: timer cancelled; in-flight result discarded, nothing published')] },
  { id: 'shutdown-idle', rule: 'B4, S11', statement: 'every timer is cancelled; nothing is requested or published afterwards', match: c => is(c, 'shutdown') && !busy(c), evidence: [P1] },
  // --------------------------------------------------------------- restart
  { id: 'restart-busy', rule: 'unreachable', statement: 'a new process inherits no request: the old transport ends with it and its settlement was suppressed (B4)', match: c => is(c, 'restart') && std(c) && busy(c), evidence: [] },
  { id: 'S12', rule: 'S12', statement: 'UsageLimitStore empty; one startup poll; history rows intact (no agent is live at a start, so both ≡ worker)',
    match: c => is(c, 'restart') && among(c, 'worker', 'both') && std(c) && !busy(c), evidence: [row('S12: UsageLimitStore empty; one startup poll; history rows intact')] },
  { id: 'restart-none', rule: 'S12', statement: 'the store starts empty and history stays; with no worker reason (session ≡ none at a start) nothing is polled',
    match: c => is(c, 'restart') && among(c, 'none', 'session') && std(c) && !busy(c), evidence: [cls('a restart with no configured worker polls nothing and keeps history')] },
  { id: 'restart-agent', rule: 'S9', statement: 'the new process records one unsupported observation per configured agent-only worker; nothing is requested',
    match: c => is(c, 'restart') && agent(c) && !busy(c), evidence: [AGENT_LIFECYCLE] },
  // ------------------------------------------------------ credential change
  { id: 'S14', rule: 'S14, B5', statement: 'old key unsubscribed, new key polled once; an old-key request drains under its own identity and never replaces the live report; a same-profile session follows the new key at its next tick (B6)',
    match: c => is(c, 'config change of credential') && among(c, 'worker', 'both') && std(c), evidence: [row('S14: old key unsubscribed, new key polled once'), cls('a credential change during an old-key request polls the new key once and the old settlement keeps its identity'), ROTATION] },
  { id: 'cred-session', rule: 'B5, B6', statement: 'the session cadence resolves the live session\'s current credential at each tick; an old-key request drains; a session spawned after it pulls its own account',
    match: c => is(c, 'config change of credential') && c.reasons === 'session' && std(c), evidence: [ROTATION, SESSION_TICK] },
  { id: 'cred-none', rule: 'B3, B5', statement: 'no reason holds either key: nothing is polled; a drained old-key request settles under its own identity', match: c => is(c, 'config change of credential') && c.reasons === 'none' && std(c), evidence: [row('S7: timer removed; no further request')] },
  { id: 'cred-agent', rule: 'S9', statement: 'a changed agent-only configuration is a new configuration: one unsupported observation for a worker reason; nothing is requested',
    match: c => is(c, 'config change of credential') && agent(c) && !busy(c), evidence: [AGENT_LIFECYCLE] },
  // ------------------------------------------------------- agent-only busy
  { id: 'agent-busy', rule: 'unreachable', statement: 'the reader service never requests an agent-only target (S9, S10), so no agent-only request is ever in flight',
    match: c => agent(c) && busy(c) && is(c, ...AGENT_BUSY_EVENTS), evidence: [] },
]

/** Each literal row's combinations (its `*` and transitions expanded on the pre-event state). */
const LITERAL: Record<string, Combination[]> = {}
function literal(id: string, reasons: Reason[], reader: Reader[], inFlight: InFlight[], event: Event): void {
  LITERAL[id] = reasons.flatMap(r => reader.flatMap(d => inFlight.map(f => ({ reasons: r, reader: d, inFlight: f, event }))))
}
literal('S1', ['none'], ['standalone'], ['no'], 'subscribe')
literal('S2', ['worker'], ['standalone'], ['no'], 'tick')
literal('S3', ['worker'], ['standalone'], ['yes'], 'tick')
literal('S4', ['worker'], ['standalone'], ['yes'], 'timeout')
literal('S5', ['worker'], ['standalone'], ['no'], '3rd consecutive failure')
literal('S6', ['worker'], ['standalone'], ['no'], 'success after failures')
literal('S7', ['worker'], ['standalone'], ['no', 'yes'], 'unsubscribe')
literal('S8', ['both'], ['standalone'], ['no', 'yes'], 'worker removed')
literal('S9', ['worker'], ['agent-only'], ['no'], 'subscribe')
literal('S10', ['session'], ['agent-only'], ['no'], 'spawn pull')
literal('S11', [...REASONS], [...READERS], ['yes'], 'shutdown')
literal('S12', ['worker'], ['standalone'], ['no'], 'restart')
literal('S13', ['worker'], ['standalone'], ['no'], 'tick')
literal('S14', ['worker'], ['standalone'], ['no', 'yes'], 'config change of credential')

const ROW_CLASS: Record<string, string> = { S13: 'S2' }

function combinations(): Combination[] {
  return REASONS.flatMap(reasons => READERS.flatMap(reader => IN_FLIGHT.flatMap(inFlight => EVENTS.map(event => ({ reasons, reader, inFlight, event })))))
}

/** Every `test('…')` title of a test file, unescaped. */
function titlesOf(file: string): Set<string> {
  const source = fs.readFileSync(path.join(import.meta.dir, file), 'utf8')
  return new Set([...source.matchAll(/\btest\('((?:[^'\\]|\\.)*)'/g)].map(match => match[1]!.replace(/\\(.)/g, '$1')))
}

describe('Table S completeness', () => {
  test('the domain is 4 reasons × 2 readers × 2 in-flight states × 11 events', () => {
    expect(combinations()).toHaveLength(176)
    const design = fs.readFileSync(path.join(import.meta.dir, '../../../openspec/changes/process-quota-history-and-incident-advice/design.md'), 'utf8')
    const events = design.split('\n').filter(line => /^\| S\d+ \|/.test(line)).map(line => line.split('|')[5]!.trim())
    // Every event a row names is one of the eleven (S4 adds its bound; S13 its team count).
    for (const event of events) expect(EVENTS.some(known => event.startsWith(known))).toBe(true)
  })

  test('every combination falls in exactly one class: no gap, no ambiguous match', () => {
    const problems: string[] = []
    for (const c of combinations()) {
      const matched = CLASSES.filter(entry => entry.match(c)).map(entry => entry.id)
      if (matched.length !== 1) problems.push(`${c.reasons}/${c.reader}/${c.inFlight}/${c.event}: ${matched.length === 0 ? 'no class' : matched.join(', ')}`)
    }
    expect(problems).toEqual([])
  })

  test('each literal row\'s combinations land in its own class', () => {
    for (const [id, combos] of Object.entries(LITERAL)) {
      for (const c of combos) expect(CLASSES.find(entry => entry.match(c))?.id).toBe(ROW_CLASS[id] ?? id)
    }
  })

  test('every reachable class names existing tests; unreachable classes name none and state why', () => {
    const titles = new Map<string, Set<string>>()
    for (const entry of CLASSES) {
      if (entry.rule === 'unreachable') {
        expect(entry.evidence).toEqual([])
        expect(entry.statement.length).toBeGreaterThan(20)
        continue
      }
      expect(entry.evidence.length).toBeGreaterThan(0)
      for (const { file, title } of entry.evidence) {
        if (!titles.has(file)) titles.set(file, titlesOf(file))
        expect(`${file} › ${titles.get(file)!.has(title) ? title : `missing: ${title}`}`).toBe(`${file} › ${title}`)
      }
    }
  })

  test('the reachable and unreachable counts', () => {
    const reachable = combinations().filter(c => CLASSES.find(entry => entry.match(c))!.rule !== 'unreachable').length
    expect({ reachable, unreachable: 176 - reachable }).toEqual({ reachable: REACHABLE, unreachable: 176 - REACHABLE })
  })
})

const REACHABLE = 100
