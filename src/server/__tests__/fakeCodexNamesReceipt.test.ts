// The fake codex app-server publishes its FAKE_ENV_NAMES receipt atomically
// (complete staged write, then same-directory rename), so a reader of the
// final path either does not see it or sees the complete sorted NAMES — the
// empty-receipt observation behind the master coverage failure of
// registeredNamesRefusalWiring.test.ts:269 can no longer be produced. These
// tests run the REAL fixture process against the consumers' existence/read
// receipt protocol; a faithful direct-write control (the old producer,
// verbatim, in a throwaway variant script) proves the absence oracle
// detects that publication. Synchronization never waits on an expected env
// name: the witnesses are the staged path, the gate file and the final
// path only.
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
 * same test-only hold. Differs from the fixed fixture only in publication. */
const DIRECT_WRITE_VARIANT = `import { existsSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_ENV_NAMES!, Object.keys(process.env).sort().join('\\n'))
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

describe('fake codex env-name receipt publication', () => {
  test('the receipt appears only complete: absent while staged, complete after release', async () => {
    const child = makeChild()
    try {
      // Stage-ready witness: the fixture finished the staged write and is
      // holding at the test-only gate. The staged path derives from the
      // child pid this test owns.
      const staged = `${child.namesFile}.${child.proc.pid}.tmp`
      await until(() => fs.existsSync(staged), 2_000)
      // The absence oracle: while the receipt is staged but unreleased, the
      // destination does not exist — no empty state is observable.
      expect(fs.existsSync(child.namesFile)).toBe(false)
      // Release, then read through the consumers' existence/read protocol.
      fs.writeFileSync(child.gateFile, '')
      await until(() => fs.existsSync(child.namesFile))
      const receipt = fs.readFileSync(child.namesFile, 'utf8').split('\n')
      // Complete publication: exactly the child env's sorted names. A
      // partial or empty receipt cannot satisfy this equality.
      expect(receipt).toEqual(Object.keys(child.env).sort())
      // Names-only evidence: the synthetic secret appears as a name, its
      // value never does.
      expect(receipt).toContain(SECRET_NAME)
      expect(JSON.stringify(receipt)).not.toContain(SECRET_VALUE)
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
      // Setup witness: the direct producer has touched the destination —
      // never a staged-path or gate-readiness wait.
      await until(() => fs.existsSync(child.namesFile), 2_000)
      // The gated regression's absence oracle fails exactly here: the final
      // path is visible while the child still holds the unreleased receipt.
      // Its content may or may not be complete yet — that ambiguity is the
      // defect: bare existence carries no completion information.
      expect(fs.existsSync(child.namesFile)).toBe(true)
    } finally {
      await releaseAndJoin(child)
    }
  })

  test('an unpublished receipt fails closed: the existence wait times out', async () => {
    const child = makeChild()
    try {
      // The gate is never created: the child stages and holds forever, the
      // destination never appears. The consumers' wait must fail closed —
      // throw its timeout — never resolve with an empty or partial receipt.
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
})

