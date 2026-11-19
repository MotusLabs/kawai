// Production lookup plans and independent cohort oracles for the metrics loader.
import { expect, test } from 'bun:test'
import { readMetrics } from '../metrics/computeMetrics'
import { loadToolMetricInputs } from '../metrics/toolMetricInputs'
import { schemaCopy, schemaDb } from './schemaDb'
import { propertyCases } from './helpers/propertyCases'

const TEAM = '/repo/.git'
const END = Date.parse('2026-11-19T14:47:21.729Z')
const FROM = new Date(END - 14 * 86400000).toISOString()
const TO = new Date(END).toISOString()
const INSIDE = new Date(END - 86400000).toISOString()

interface Fact {
  kind: string
  team: string
  session: string | null
  turn: string | null
  at: string
  seq: number
}

function fixture(db = schemaCopy()) {
  const facts: Fact[] = []
  const lives: { session: string; scopeSession: string; turn: unknown }[] = []
  const insert = db.prepare(`INSERT INTO process_observations
    (source_key,kind,observed_at,recorded_at,version,team_id,session_id,turn_id,data)
    VALUES (?,?,?,?,1,?,?,?,'{}')`)
  return {
    db, facts, lives,
    add(overrides: Partial<Omit<Fact, 'seq'>> = {}) {
      const f = { kind: 'tool', team: TEAM, session: 's', turn: 't', at: INSIDE, ...overrides }
      const result = insert.run('fixture-' + facts.length, f.kind, f.at, INSIDE, f.team, f.session, f.turn)
      const fact = { ...f, seq: Number(result.lastInsertRowid) }
      facts.push(fact)
      return fact.seq
    },
    live(session = 's', scopeSession = session, turn: unknown = 't') {
      lives.push({ session, scopeSession, turn })
      db.prepare('INSERT INTO process_live_observations VALUES (?,?)')
        .run(session, JSON.stringify({ scope: { sessionId: scopeSession, turnId: turn } }))
    },
    read() { return loadToolMetricInputs(db, TEAM, FROM, TO, END) },
  }
}

// @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Large single-team history
// @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Live sessions with unrelated history
test('P1/P2: production tool lookups search session identities before executing on large history', () => {
  const h = fixture(schemaDb())
  const db = h.db
  const prepare = db.prepare.bind(db)
  const descriptor = Object.getOwnPropertyDescriptor(db, 'prepare')
  const checked: string[] = []
  try {
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) h.add({ kind: 'context', session: 'noise-' + i })
      for (let i = 0; i < 128; i++) {
        h.add({ session: 's' + i })
        h.add({ kind: 'turn_ended', session: 's' + i })
        if (i < 16) h.live('s' + i)
      }
    })()
    Object.defineProperty(db, 'prepare', { configurable: true, value: (...args: Parameters<typeof db.prepare>) => {
      const statement = prepare(...args)
      const sql = String(args[0])
      const closure = sql.startsWith('SELECT c.* FROM process_observations c')
      const live = sql.startsWith('SELECT l.session_id,')
      if (closure || live) {
        const all = statement.all.bind(statement)
        Object.defineProperty(statement, 'all', { value: (...bindings: Parameters<typeof statement.all>) => {
          const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(...bindings) as { detail: string }[]
          const inner = plan.filter(row => /\bSEARCH t\b/.test(row.detail)).map(row => row.detail)
          expect(inner, closure ? 'P1 closure identity search' : 'P2 live identity search').toHaveLength(1)
          expect(inner[0]).toContain('session_id=?')
          if (closure) expect(inner[0]).toContain('turn_id=?')
          expect(inner[0]).not.toContain('team_id=?')
          checked.push(closure ? 'P1' : 'P2')
          return all(...bindings)
        } })
      }
      return statement
    } })
    expect(readMetrics(db, TEAM, '7d', null, END).teamId).toBe(TEAM)
    expect(checked).toEqual(['P1', 'P2'])
  } finally {
    if (descriptor) Object.defineProperty(db, 'prepare', descriptor)
    else Reflect.deleteProperty(db, 'prepare')
    db.close()
  }
})

// Verbatim observable-result rows from design.md; O8 is the WAL test in toolMetrics.test.ts.
const ORACLES = [
  ['O1', 'In-window tool and same-team/session/turn closure', 'Closure included once'],
  ['O2', 'As O1, closure timestamp before `from` or at/after `to`', 'Closure still included once'],
  ['O3', "Only another team's, session's, or turn's tool; or a null closure session/turn", 'Closure excluded for each variant'],
  ['O4', 'Matching tool completion at `from`, then at `to` in separate fixtures', 'Included at `from`; excluded at `to`'],
  ['O5', 'Valid live identity; same-team/session tool is in-window but belongs to another turn', 'Current live identity included'],
  ['O6', 'Live scope session mismatches its row key, or its scope turn id is not a string', 'Live identity excluded for each variant'],
  ['O7', "No qualifying tool row, including a streak-only row or another team's tool", 'Neither a closure nor a live identity is qualified'],
  ['O9', 'Two tool rows qualify one closure; several closures are inserted out of time order', 'No duplicate closures; ascending sequence order'],
] as const

for (const [id, input, expected] of ORACLES) {
  // @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Closure outside the completion window
  // @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Other identities cannot satisfy a match
  // @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Live sessions with unrelated history
  test(`${id}: ${input} -> ${expected}`, () => {
    const variants = id === 'O3' ? 7 : id === 'O7' ? 3 : ['O2', 'O4', 'O6'].includes(id) ? 2 : 1
    for (let variant = 0; variant < variants; variant++) {
      const h = fixture()
      const wanted: number[] = []
      const live: string[] = []
      try {
        if (id === 'O1' || id === 'O2' || id === 'O4') {
          h.add({ at: id === 'O4' ? variant ? TO : FROM : INSIDE })
          const seq = h.add({ kind: 'turn_ended', at: id === 'O2' ? variant ? TO : '2026-01-01T00:00:00.000Z' : INSIDE })
          if (id !== 'O4' || variant === 0) wanted.push(seq)
        } else if (id === 'O3') {
          const tools: Partial<Fact>[] = [{ team: 'other' }, { session: 'other' }, { turn: 'other' },
            { session: null }, { turn: null }, {}, {}]
          h.add(tools[variant])
          h.add({ kind: 'turn_ended', ...(variant === 3 || variant === 5 ? { session: null } : {}),
            ...(variant === 4 || variant === 6 ? { turn: null } : {}) })
        } else if (id === 'O5') {
          h.add({ turn: 'previous' }); h.live()
          live.push(JSON.stringify(['s', 't']))
        } else if (id === 'O6') {
          h.add(); h.live('s', variant ? 's' : 'mismatch', variant ? 42 : 't')
        } else if (id === 'O7') {
          if (variant === 1) h.add({ kind: 'tool_streak' })
          if (variant === 2) h.add({ team: 'other' })
          h.add({ kind: 'turn_ended' }); h.live()
        } else {
          h.add(); h.add()
          wanted.push(h.add({ kind: 'turn_ended', at: TO }))
          wanted.push(h.add({ kind: 'turn_ended', at: FROM }))
        }
        const result = h.read()
        expect(result.closures.map(row => row.seq)).toEqual(wanted)
        expect([...result.live]).toEqual(live)
      } finally { h.db.close() }
    }
  })
}

function random(seed: number) {
  return (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % limit
  }
}

// @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Other identities cannot satisfy a match
// @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Closure outside the completion window
test('G1: closure cohorts equal an independent array oracle (128 cases, seed 0x19A11)', () => {
  const next = random(0x19A11)
  const identities = ['s', 'other', null]
  const times = [FROM, INSIDE, TO, '2026-01-01T00:00:00.000Z']
  for (let i = 0; i < propertyCases(128); i++) {
    const h = fixture()
    try {
      for (let j = 0; j < 40; j++) h.add({
        kind: ['tool', 'tool_streak', 'turn_ended'][next(3)]!, team: next(2) ? TEAM : 'other',
        session: identities[next(3)], turn: identities[next(3)], at: times[next(4)]!,
      })
      const wanted = h.facts.filter(c => c.kind === 'turn_ended' && c.team === TEAM &&
        c.session !== null && c.turn !== null && h.facts.some(t =>
          t.kind === 'tool' && t.team === c.team && t.session === c.session && t.turn === c.turn &&
          t.at >= FROM && t.at < TO)).map(c => c.seq)
      expect(h.read().closures.map(row => row.seq)).toEqual(wanted)
    } finally { h.db.close() }
  }
})

// @covers: team-process-metrics › Tool metric reads avoid multiplicative history scans › Live sessions with unrelated history
test('G2: live cohorts equal an independent array oracle (128 cases, seed 0x19A12)', () => {
  const next = random(0x19A12)
  for (let i = 0; i < propertyCases(128); i++) {
    const h = fixture()
    try {
      for (let j = 0; j < 6; j++) {
        const session = 's' + j
        h.live(session, next(3) ? session : 'mismatch', next(3) ? 'current' : null)
      }
      for (let j = 0; j < 30; j++) h.add({
        session: 's' + next(8), turn: next(2) ? 'current' : 'previous',
        team: next(3) ? TEAM : 'other', kind: next(3) ? 'tool' : 'tool_streak',
        at: [FROM, INSIDE, TO][next(3)]!,
      })
      const wanted = h.lives.filter(l => l.scopeSession === l.session && typeof l.turn === 'string' &&
        h.facts.some(t => t.team === TEAM && t.session === l.session && t.kind === 'tool' && t.at >= FROM && t.at < TO))
        .map(l => JSON.stringify([l.session, l.turn])).sort()
      expect([...h.read().live].sort()).toEqual(wanted)
    } finally { h.db.close() }
  }
})
