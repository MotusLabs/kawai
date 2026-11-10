// The Codex I2 reference (task 4.4, Codex unit): a caller's durable store
// across host lifetimes, written from the contract, never from the driver.
// It reuses the Claude unit's fixed generator (resumeModel.ts:
// generateSequence, targetOf) and differs where the Codex contract does:
// - The thread identity is known at start (thread/start), so a fresh
//   lifetime offers exactly one checkpoint, and readiness awaits it: a held
//   persistence keeps start waiting until it commits, a rejection fails
//   start with category `checkpoint` (the driver disposes itself; the stop
//   reports the raw failure). Succession flags never apply: a Codex thread
//   keeps its id.
// - A resumed lifetime offers nothing: the supplied identity counts as
//   reported (any identity the runtime accepts, including one whose earlier
//   persistence was rejected).
// - A target the runtime does not hold fails start with category `resume`,
//   whether the app-server refuses it or answers with another thread; the
//   substituted thread never reaches the caller (so it is not modelled) and
//   nothing falls back. Thread names are minted in offer order; the runner
//   aliases the real ids the same way.
// - Crashes: `after-id` (offer made, nothing decided) and `after-commit`
//   (offer decided) apply to a fresh lifetime's start; `after-admission` and
//   `after-result` to the crash turn. A crash runs no stop; the store keeps
//   what committed, or the pending write when it landed.
// - I1: a disposed driver refuses every later send.
import { targetOf, type ResumeSequence } from './resumeModel.js'

export function predictCodex(seq: ResumeSequence, index: number): string[] {
  const log: string[] = []
  const runtime = new Set<string>()
  const known: string[] = []
  const disposed: number[] = []
  let store: string | null = null
  let minted = 0
  const mint = () => `thread-${index}-${++minted}`

  seq.lifetimes.forEach((spec, n) => {
    const L = `L${n}`
    const target = targetOf(spec, store, known, index, n)
    log.push(`${L} options ${target ?? '-'}`)
    const end = (dispose: boolean) => {
      log.push(`${L} store ${store ?? '-'}`)
      for (const k of disposed) log.push(`stale L${k} refused`)
      if (dispose) disposed.push(n)
    }
    if (target !== null && !runtime.has(target)) {
      log.push(`${L} start resume`, `${L} stop stop`)
      return end(true)
    }
    if (target === null) {
      const id = mint()
      runtime.add(id)
      known.push(id)
      const decision = spec.decisions[0]!
      log.push(`${L} checkpoint ${decision}`)
      if (spec.crash.at === 'after-id') {
        if (spec.crash.landed) store = id
        log.push(`${L} crash`)
        return end(false)
      }
      if (decision === 'hold') log.push(`${L} start waits`)
      if (decision !== 'reject') store = id
      if (spec.crash.at === 'after-commit') {
        log.push(`${L} crash`)
        return end(false)
      }
      if (decision === 'reject') {
        log.push(`${L} start checkpoint`, `${L} stop stop`)
        return end(true)
      }
    }
    log.push(`${L} start ok`)
    for (let j = 0; j < spec.turns; j++) {
      log.push(`${L} send${j} ack`)
      if (spec.crash.at === 'after-admission' && spec.crash.turn === j) {
        log.push(`${L} crash`)
        return end(false)
      }
      log.push(`${L} turn${j} success`)
      if (spec.crash.at === 'after-result' && spec.crash.turn === j) {
        log.push(`${L} crash`)
        return end(false)
      }
    }
    log.push(`${L} stop ok`)
    end(true)
  })
  return log
}
