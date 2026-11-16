// The fake codex app-server publishes its FAKE_ENV_NAMES receipt atomically
// (complete staged write, then same-directory rename), so a reader of the
// final path either does not see it or sees the complete sorted NAMES — the
// empty-receipt observation behind the master coverage failure of
// registeredNamesRefusalWiring.test.ts:269 can no longer be produced. These
// tests run the REAL fixture process through ONE shared receipt oracle: a
// setup witness (stage-ready, or premature destination under a
// direct-publication regression), the absence assertion evaluated after
// setup, the release, and the consumers' existence/read protocol with
// exact-equality completeness. A faithful direct-write control — the old
// producer, verbatim, in a throwaway variant script — runs the same oracle
// with its violation arm asserted, proving the oracle rejects that
// publication after setup rather than through a setup timeout. That proof
// is final-path existence alone, whatever bytes it holds: the direct write
// exposes the path at open before its write lands (CI 43910736214 read ['']
// there), so a completeness read waits behind the child's exit — the
// completion witness — or never runs, and the pre-fix protocol is kept
// verbatim as the failing reproduction's reference. Witnesses: the staged
// path, the gate file, the final path and the child's exit, never a name.
// @reads: tests/fixtures/**
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE = path.resolve(import.meta.dir, '../../../tests/fixtures/fake-codex-app-server.ts')

/** A synthetic secret in the child env: the receipt must carry its NAME
 * (the fixture records names only) and never its value. */
const SECRET_NAME = 'KAWAI_SYNTHETIC_SECRET'
const SECRET_VALUE = 'synthetic-secret-value-never-real'

/** The old producer, verbatim: one direct writeFileSync to the final path
 * (the open makes the destination visible before the write lands), then the
 * same test-only hold. Differs from the fixed fixture only in publication.
 * The newline join is String.fromCharCode(10): no nested string escape sits
 * between this template and the variant's payload. */
const DIRECT_WRITE_VARIANT = `import { existsSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_ENV_NAMES!, Object.keys(process.env).sort().join(String.fromCharCode(10)))
const gate = process.env.FAKE_ENV_NAMES_GATE
if (gate) while (!existsSync(gate)) await Bun.sleep(10)
`

/** A deterministic zero/partial publisher: openSync makes the destination
 * visible with zero bytes, writeSync lands only a strict prefix of the
 * receipt's first sorted name, and the script then holds at the gate — it
 * never completes. This is the CI race's empty destination, constructed:
 * the corrected oracle must witness the violation from existence alone,
 * while the pre-fix protocol fails on it every time. */
const PARTIAL_WRITE_VARIANT = `import { closeSync, existsSync, openSync, writeSync } from 'node:fs'
const fd = openSync(process.env.FAKE_ENV_NAMES!, 'w')
writeSync(fd, Object.keys(process.env).sort()[0]!.slice(0, 4))
closeSync(fd)
const gate = process.env.FAKE_ENV_NAMES_GATE
if (gate) while (!existsSync(gate)) await Bun.sleep(10)
`

/** Poll until the predicate holds — the consumers' receipt-wait shape. */
async function until(predicate: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await Bun.sleep(10)
  }
}

/** Spawn a fake app-server variant with a fully controlled child env, so
 * the expected receipt is exactly that env's sorted keys. An empty
 * FAKE_TRANSCRIPT makes the real fixture exit right after publication. */
function makeChild(prepare?: (dir: string) => string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-names-receipt-')))
  const script = prepare ? prepare(dir) : FIXTURE
  const namesFile = path.join(dir, 'env-names.txt')
  const gateFile = path.join(dir, 'gate')
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    FAKE_ENV_NAMES: namesFile,
    FAKE_ENV_NAMES_GATE: gateFile,
    FAKE_TRANSCRIPT: path.join(dir, 'transcript.jsonl'),
    [SECRET_NAME]: SECRET_VALUE,
  }
  fs.writeFileSync(env.FAKE_TRANSCRIPT, '')
  const proc = Bun.spawn([process.execPath, script, 'app-server'], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  return { proc, dir, namesFile, gateFile, env }
}
type Child = ReturnType<typeof makeChild>

/** The staged path the fixture publishes through: owned, unique to this
 * child (its pid), same directory as the destination. */
function stagedPath(child: Child): string {
  return `${child.namesFile}.${child.proc.pid}.tmp`
}

/** Join the owned child within a bound, killing it if it overstays, then
 * remove its directory: no spawned fake outlives the test. */
async function joinBounded(child: Child, ms = 2_000): Promise<void> {
  const outcome = await Promise.race([child.proc.exited.then(() => 'exited'), Bun.sleep(ms).then(() => 'bound')])
  if (outcome === 'bound') child.proc.kill()
  await child.proc.exited
  fs.rmSync(child.dir, { recursive: true, force: true })
}

/** Release a held child (create the gate it waits on) and join it. Safe to
 * call after the test already released or the child already exited. */
async function releaseAndJoin(child: Child): Promise<void> {
  fs.writeFileSync(child.gateFile, '')
  await joinBounded(child)
}

/** How the oracle's completeness phase reads the released receipt:
 * - 'consumer-protocol': the consumers' existence/read protocol — valid only
 *   for the atomic producer, whose existence implies complete bytes.
 * - 'completion-witness': behind the child's exit — the direct-write control
 *   wrote before it held at the gate and exits once released, so its exit is
 *   the process witness that the non-atomic write landed, and the read then
 *   cannot race the write window CI read [''] in.
 * - 'none': no completeness phase — for a producer that never completes
 *   (the zero/partial control), whose violation is proven by existence
 *   alone. The gate stays unwritten; the caller's cleanup releases it. */
type Completeness = 'consumer-protocol' | 'completion-witness' | 'none'

/** The shared receipt oracle: one setup witness — stage-ready for the fixed
 * producer, premature destination under a direct-publication regression —
 * then the absence assertion evaluated after setup, and, unless `completeness`
 * is 'none', the release and one completeness read with exact-equality proof.
 * With `expectViolation` the absence assertion's violation is asserted
 * instead: how the finite controls prove the oracle rejects premature
 * publication after setup rather than at a staging timeout. The violation
 * proof is existence-only — it never inspects the destination's bytes, so a
 * zero or partial publication is witnessed exactly like a complete
 * premature one. */
async function runSharedReceiptOracle(child: Child, setupWitness: () => boolean, expectViolation: boolean, completeness: Completeness): Promise<void> {
  await until(setupWitness, 2_000)
  const premature = fs.existsSync(child.namesFile)
  if (expectViolation) expect(premature).toBe(true)
  else expect(premature).toBe(false)
  if (completeness === 'none') return
  // Release, then read: through the consumers' existence/read protocol for
  // the atomic producer, or behind the child-exit completion witness for
  // the non-atomic one.
  fs.writeFileSync(child.gateFile, '')
  if (completeness === 'completion-witness') await child.proc.exited
  else await until(() => fs.existsSync(child.namesFile))
  const receipt = fs.readFileSync(child.namesFile, 'utf8').split('\n')
  // Complete publication: exactly the child env's sorted names. A partial,
  // empty or mis-joined receipt cannot satisfy this equality.
  expect(receipt).toEqual(Object.keys(child.env).sort())
  // Names-only evidence: the synthetic secret appears as a name, its value
  // never does.
  expect(receipt).toContain(SECRET_NAME)
  expect(JSON.stringify(receipt)).not.toContain(SECRET_VALUE)
}

/** The oracle's pre-fix violation protocol, verbatim where it matters: after
 * witnessing premature existence it released the gate, waited for the final
 * path, read it and demanded the atomic completeness equality from the
 * intentionally non-atomic producer. CI 43910736214 failed exactly this step
 * (line 110: expected the sorted five names, received ['']) because the read
 * raced the direct write's open-to-write window. Kept as the failing
 * reproduction's reference; `observed` reports the bytes it read so the
 * reproduction can prove they were genuinely incomplete. */
async function runLegacyViolationProtocol(child: Child, observed: { receipt?: string[] }): Promise<void> {
  await until(() => fs.existsSync(child.namesFile), 2_000)
  fs.writeFileSync(child.gateFile, '')
  await until(() => fs.existsSync(child.namesFile))
  const receipt = fs.readFileSync(child.namesFile, 'utf8').split('\n')
  observed.receipt = receipt
  expect(receipt).toEqual(Object.keys(child.env).sort())
}

describe('fake codex env-name receipt publication', () => {
  test('the receipt appears only complete: absent while staged, complete after release', async () => {
    const child = makeChild()
    try {
      // Setup witness: stage-ready OR premature destination. Under the fixed
      // fixture only the staged path appears; a direct-publication
      // regression reveals the destination instead — and fails the absence
      // assertion inside the oracle, never this wait.
      await runSharedReceiptOracle(child, () => fs.existsSync(stagedPath(child)) || fs.existsSync(child.namesFile), false, 'consumer-protocol')
    } finally {
      await releaseAndJoin(child)
    }
  })

  test('direct publication is detected: the destination appears before release', async () => {
    const child = makeChild((dir) => {
      const variant = path.join(dir, 'direct-write-variant.ts')
      fs.writeFileSync(variant, DIRECT_WRITE_VARIANT)
      return variant
    })
    try {
      // The same oracle, violation arm: the faithful control's setup
      // witness is the premature destination itself, and the absence
      // assertion rejects after setup — never as a staging timeout. The
      // completeness read waits behind the child's exit: the control wrote
      // before it held, so exit proves the write landed and the equality
      // proves the variant stayed faithful — without demanding the atomic
      // visibility guarantee it intentionally lacks.
      await runSharedReceiptOracle(child, () => fs.existsSync(child.namesFile), true, 'completion-witness')
    } finally {
      await releaseAndJoin(child)
    }
  })

  test('a held zero/partial publication is witnessed as a violation without any completeness demand', async () => {
    const child = makeChild((dir) => {
      const variant = path.join(dir, 'partial-write-variant.ts')
      fs.writeFileSync(variant, PARTIAL_WRITE_VARIANT)
      return variant
    })
    try {
      // Corrected protocol, violation arm, no completeness phase: the
      // premature destination is the violation whatever bytes it holds —
      // here zero bytes or a four-byte fragment, never the receipt. The
      // oracle must not fail the control for the producer's intentional
      // incompleteness (the mechanism behind the CI failure).
      await runSharedReceiptOracle(child, () => fs.existsSync(child.namesFile), true, 'none')
      // Held and unreleased, the destination's bytes are genuinely
      // incomplete: strictly fewer lines than the receipt. Proves the
      // tolerated state was real, not vacuous.
      const held = fs.readFileSync(child.namesFile, 'utf8').split('\n')
      expect(held.length).toBeLessThan(Object.keys(child.env).sort().length)
    } finally {
      await releaseAndJoin(child)
    }
  })

  test('the pre-fix protocol fails that control: it demanded complete bytes from an incomplete publication', async () => {
    const child = makeChild((dir) => {
      const variant = path.join(dir, 'partial-write-variant.ts')
      fs.writeFileSync(variant, PARTIAL_WRITE_VARIANT)
      return variant
    })
    try {
      // The corrected oracle passes this producer: existence-only violation
      // proof, no completeness phase.
      await runSharedReceiptOracle(child, () => fs.existsSync(child.namesFile), true, 'none')
      // The pre-fix protocol, on the same held producer, fails exactly as CI
      // did: at the completeness equality, after reading the genuinely
      // incomplete destination — never at a wait (the read happened).
      const observed: { receipt?: string[] } = {}
      let legacyFailed = false
      try {
        await runLegacyViolationProtocol(child, observed)
      } catch {
        legacyFailed = true
      }
      expect(legacyFailed).toBe(true)
      expect(observed.receipt).toBeDefined()
      expect(observed.receipt!.length).toBeLessThan(Object.keys(child.env).sort().length)
    } finally {
      await releaseAndJoin(child)
    }
  })

  test('an unpublished receipt fails closed: the existence wait times out', async () => {
    const child = makeChild()
    try {
      // Setup proof before timing the unreleased wait: the child has staged
      // and is held alive at the gate. A dead or never-started child would
      // satisfy the timeout assertions below vacuously.
      await until(() => fs.existsSync(stagedPath(child)), 2_000)
      expect(child.proc.exitCode).toBeNull()
      // The gate is never created: the destination never appears. The
      // consumers' wait must fail closed — throw its timeout — never
      // resolve with an empty or partial receipt.
      let timedOut = false
      try {
        await until(() => fs.existsSync(child.namesFile), 250)
      } catch {
        timedOut = true
      }
      expect(timedOut).toBe(true)
      expect(fs.existsSync(child.namesFile)).toBe(false)
    } finally {
      // Bounded owned cleanup: release the held child, join it, remove the
      // directory even when the assertions above threw.
      await releaseAndJoin(child)
    }
  })

  test('a publication error survives cleanup: the original open failure is rethrown', async () => {
    // FAKE_ENV_NAMES beneath a regular file: open(staged) fails ENOTDIR, and
    // rmSync of the same path would fail ENOTDIR too (force suppresses
    // missing paths, not this). The fixture must rethrow the ORIGINAL
    // publication error, never a cleanup failure.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-names-receipt-')))
    const blocker = path.join(dir, 'not-a-dir')
    fs.writeFileSync(blocker, '')
    const namesFile = path.join(blocker, 'env-names.txt')
    const proc = Bun.spawn([process.execPath, FIXTURE, 'app-server'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_ENV_NAMES: namesFile },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
    try {
      const exitCode = await proc.exited
      expect(exitCode).not.toBe(0)
      const stderr = await new Response(proc.stderr).text()
      // The original open failure names the staged path...
      expect(stderr).toContain(`ENOTDIR: not a directory, open '${namesFile}.`)
      // ...and no cleanup error is surfaced in its place (the rm of the
      // same path would say "rm", not "open").
      expect(stderr).not.toContain(`rm '${namesFile}`)
      expect(fs.existsSync(namesFile)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an immediately-exiting child never stages or publishes', async () => {
    // Counterexample for the negative's setup proof: the real fixture
    // without its app-server argv exits before the names block — neither a
    // staged path nor a receipt appears, and the exit is observable. Held
    // (the negative above) and dead (this) children are distinguishable.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-names-receipt-')))
    const namesFile = path.join(dir, 'env-names.txt')
    const proc = Bun.spawn([process.execPath, FIXTURE], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_ENV_NAMES: namesFile },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      await until(() => proc.exitCode !== null, 2_000)
      expect(proc.exitCode).toBe(2)
      expect(fs.existsSync(namesFile)).toBe(false)
      expect(fs.existsSync(`${namesFile}.${proc.pid}.tmp`)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})


