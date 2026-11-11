// An independent reference for I2 (task 4.4, Claude unit): a caller's
// durable store across host lifetimes. It is written from the contract,
// never from the driver's output:
// - R10/design §2. The identity a caller supplies counts as already
//   reported. Each identity the runtime reports afterwards is offered to
//   onCheckpoint once. A send made while that persistence is pending is
//   acknowledged only after it commits. A rejection is sticky: the driver
//   reports it and disposes itself, its open turn ends as a stop ends it
//   (L11: interrupted, category stopped), and every later send is refused
//   with category checkpoint.
// - G1/R10. A launch resumes exactly the target the caller supplied. A
//   target the runtime does not hold either fails start with category
//   resume (a CLI that refuses before initialize) or, from a substituting
//   runtime, fails the first turn with category resume; no identity of the
//   substituted conversation reaches the caller. Either way the stop
//   reports the owned failure.
// - A host crash ends a lifetime at a boundary with no stop. The store then
//   holds what committed; a persistence still pending at the crash may or
//   may not have reached the disk (`landed`), and nothing acknowledged it.
// - I1. A disposed driver refuses every later send.
// The runner (resume.test.ts) plays the runtime and the caller store, and
// logs what it observed in the same vocabulary; the two logs must be equal.
export type LaunchKind = 'store' | 'held' | 'invalid' | 'fresh'
export type Decision = 'commit' | 'reject' | 'hold'
export type Boundary = 'none' | 'after-admission' | 'after-id' | 'after-commit' | 'after-result'

export interface LifetimeSpec {
  launch: LaunchKind
  /** Which caller-held identity a `held` launch supplies. */
  pick: number
  turns: number
  /** Per turn: the runtime moves the conversation to a new identity at this turn's init (never on turn 0). */
  succession: boolean[]
  /** The store's answer to each checkpoint offer of the lifetime, in order. */
  decisions: Decision[]
  crash: { at: Boundary; turn: number; landed: boolean }
}

export interface ResumeSequence {
  /** How the runtime answers a target it does not hold. */
  mode: 'refuse' | 'substitute'
  lifetimes: LifetimeSpec[]
}

const KINDS: LaunchKind[] = ['store', 'store', 'held', 'invalid', 'fresh']
const DECISIONS: Decision[] = ['commit', 'commit', 'reject', 'hold']
const BOUNDARIES: Boundary[] = ['none', 'after-admission', 'after-id', 'after-commit', 'after-result']

export function generateSequence(seed: number): ResumeSequence {
  let state = seed >>> 0
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) >>> 0
    return (state >>> 16) % n
  }
  const mode = next(2) === 0 ? 'refuse' : 'substitute'
  const lifetimes = Array.from({ length: 1 + next(3) }, (): LifetimeSpec => {
    const launch = KINDS[next(KINDS.length)]!
    const pick = next(8)
    const turns = 1 + next(3)
    const succession = Array.from({ length: turns }, (_, j) => j > 0 && next(4) === 0)
    const decisions = Array.from({ length: turns }, () => DECISIONS[next(DECISIONS.length)]!)
    const crash = { at: BOUNDARIES[next(BOUNDARIES.length)]!, turn: next(turns), landed: next(2) === 0 }
    return { launch, pick, turns, succession, decisions, crash }
  })
  return { mode, lifetimes }
}

/** The caller's target for a lifetime: a pure function of what the caller holds. */
export function targetOf(spec: LifetimeSpec, store: string | null, known: readonly string[], sequence: number, lifetime: number): string | null {
  switch (spec.launch) {
    case 'store':
      return store
    case 'held':
      return known.length > 0 ? known[spec.pick % known.length]! : null
    case 'invalid':
      return `bogus-${sequence}-${lifetime}`
    case 'fresh':
      return null
  }
}

/** The log the runner must observe for `seq`. */
export function predict(seq: ResumeSequence, index: number): string[] {
  const log: string[] = []
  const runtime = new Set<string>()
  const known: string[] = []
  const disposed: number[] = []
  let store: string | null = null
  let minted = 0
  const mint = () => `conv-${index}-${++minted}`
  const hold = (id: string) => {
    if (!known.includes(id)) known.push(id)
  }

  seq.lifetimes.forEach((spec, n) => {
    const L = `L${n}`
    const target = targetOf(spec, store, known, index, n)
    log.push(`${L} options ${target ?? '-'}`)
    const accepted = target === null || runtime.has(target)
    const crashAt = (at: Boundary, turn: number) => spec.crash.at === at && spec.crash.turn === turn
    const endStale = () => {
      for (const k of disposed) log.push(`stale L${k} refused`)
    }

    if (!accepted && seq.mode === 'refuse') {
      log.push(`${L} start resume`, `${L} stop stop`, `${L} store ${store ?? '-'}`)
      endStale()
      disposed.push(n)
      return
    }
    log.push(`${L} start ok`)
    if (!accepted) {
      log.push(`${L} send0 ack`)
      if (crashAt('after-admission', 0)) {
        // The host died before the runtime ran the turn: no stop, nothing disposed.
        log.push(`${L} crash`, `${L} store ${store ?? '-'}`)
        endStale()
        return
      }
      // The substituting runtime starts a conversation of its own; the caller never learns it.
      runtime.add(mint())
      log.push(`${L} turn0 failed:resume`, `${L} send1 refused:resume`, `${L} stop stop`, `${L} store ${store ?? '-'}`)
      endStale()
      disposed.push(n)
      return
    }

    let reported = target
    let current = target
    let pending: string | null = null
    let offers = 0
    let crashed = false
    let rejected = false
    const crash = () => {
      if (pending !== null && spec.crash.landed) store = pending
      crashed = true
      log.push(`${L} crash`)
    }
    for (let j = 0; j < spec.turns; j++) {
      if (pending !== null) {
        log.push(`${L} send${j} waits`)
        store = pending
        pending = null
      }
      log.push(`${L} send${j} ack`)
      if (crashAt('after-admission', j)) {
        crash()
        break
      }
      const id = current === null || spec.succession[j] ? mint() : current
      runtime.add(id)
      current = id
      let decision: Decision | null = null
      if (id !== reported) {
        reported = id
        decision = spec.decisions[offers++ % spec.decisions.length]!
        log.push(`${L} checkpoint ${id} ${decision}`)
        hold(id)
        pending = id
      }
      if (crashAt('after-id', j)) {
        crash()
        break
      }
      if (decision === 'commit') {
        store = id
        pending = null
      } else if (decision === 'reject') {
        pending = null
        rejected = true
      }
      if (crashAt('after-commit', j)) {
        crash()
        break
      }
      if (rejected) {
        log.push(`${L} turn${j} interrupted:stopped`, `${L} send${j + 1} refused:checkpoint`)
        break
      }
      log.push(`${L} turn${j} success`)
      if (crashAt('after-result', j)) {
        crash()
        break
      }
    }
    if (!crashed) {
      if (pending !== null) store = pending
      log.push(`${L} stop ${rejected ? 'stop' : 'ok'}`)
    }
    log.push(`${L} store ${store ?? '-'}`)
    endStale()
    if (!crashed) disposed.push(n)
  })
  return log
}
