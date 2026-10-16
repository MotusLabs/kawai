// The OpenSpec adapter (plan-validation design D3) against a stub CLI on a
// private PATH and an injected runner. No test spawns the real OpenSpec CLI
// or reaches the network. The stub is a bash script in a temporary directory
// prepended to PATH for the duration of each spawn test.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenspecAdapter, type OpenspecCall, type OpenspecRunner } from '../plans/validation/openspecAdapter'

const STUB = `#!/usr/bin/env bash
# Concurrency accounting under flock: count and peak, exact across processes.
enter() {
  exec 9>>"$STUB_LOCK"
  flock 9
  local count peak
  count=$(cat "$STUB_COUNT" 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > "$STUB_COUNT"
  peak=$(cat "$STUB_PEAK" 2>/dev/null || echo 0); [ "$count" -gt "$peak" ] && echo "$count" > "$STUB_PEAK"
  flock -u 9
}
leave() {
  exec 9>>"$STUB_LOCK"
  flock 9
  local count; count=$(cat "$STUB_COUNT" 2>/dev/null || echo 1); echo "$((count - 1))" > "$STUB_COUNT"
  flock -u 9
}
case "$1" in
  --version)
    echo "$STUB_VERSION"
    exit 0
    ;;
  validate)
    enter
    trap leave EXIT
    case "$2" in
      broken)
        printf '{"items":[{"id":"broken","type":"change","valid":false,"issues":[{"level":"ERROR","path":"spec.md","message":"No deltas"}]}]}'
        exit 1
        ;;
      sleeper) sleep 2; printf '{}'; exit 0 ;;
      stubborn) trap '' TERM; sleep 2 & wait; printf '{}'; exit 0 ;;
      wrong-id) printf '{"items":[{"id":"another-change","type":"change","valid":true,"issues":[]}]}'; exit 0 ;;
      bad-issue) printf '{"items":[{"id":"bad-issue","type":"change","valid":false,"issues":["nope"]}]}'; exit 1 ;;
      *) printf '{"items":[{"id":"%s","type":"change","valid":true,"issues":[]}],"summary":{}}' "$2"; exit 0 ;;
    esac
    ;;
  show)
    case "$2" in
      rename-change)
        printf '{"deltas":[{"spec":"chat","operation":"RENAMED","description":"renames","rename":{"from":"Old","to":"New"}}]}'
        ;;
      broken-rename)
        printf '{"deltas":[{"spec":"chat","operation":"RENAMED","rename":{"from":"Old"}}]}'
        ;;
      no-requirement)
        printf '{"deltas":[{"spec":"chat","operation":"ADDED","description":"no requirement"}]}'
        ;;
      bogus-op)
        printf '{"deltas":[{"spec":"chat","operation":"BOGUS","requirement":{"name":"X"}}]}'
        ;;
      alpha)
        printf '{"deltas":[{"spec":"chat","operation":"MODIFIED","requirement":{"name":"Presence"}}]}'
        ;;
      *)
        printf '{"deltas":[]}'
        ;;
    esac
    exit 0
    ;;
esac
printf 'unknown command'; exit 2
`

const runner = (result: Partial<OpenspecCall>): OpenspecRunner => async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result })

describe('OpenspecAdapter probe', () => {
  test('a valid version grants both capabilities', async () => {
    const probe = await new OpenspecAdapter(runner({ stdout: '1.14.2\n' })).probe(true)
    expect(probe).toEqual({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null })
  })

  test('an unparsable version and a below-floor version are unavailable, never success', async () => {
    const unparsable = await new OpenspecAdapter(runner({ stdout: 'openspec tomorrow\n' })).probe(true)
    expect(unparsable.ok).toBe(false)
    expect(unparsable.version).toBeNull()
    expect(unparsable.capabilities).toEqual([])
    const old = await new OpenspecAdapter(runner({ stdout: '1.12.0\n' })).probe(true)
    expect(old.ok).toBe(false)
    expect(old.error).toContain('below the supported floor')
    // A missing executable (the spawn failed) is unavailable too.
    const missing = await new OpenspecAdapter(async () => ({ ok: false, exitCode: null, stdout: '', stderr: 'openspec spawn failed', timedOut: false })).probe(true)
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('openspec executable not found')
  })

  test('caches only a successful probe; a failed one re-probes next call', async () => {
    let calls = 0
    const counting: OpenspecRunner = async () => {
      calls += 1
      return { ok: calls === 1, exitCode: calls === 1 ? 0 : 1, stdout: calls === 1 ? 'openspec tomorrow' : '1.14.2', stderr: '', timedOut: false }
    }
    const adapter = new OpenspecAdapter(counting)
    const failed = await adapter.probe(true)
    expect(failed.ok).toBe(false)
    const retry = await adapter.probe()
    expect(retry.ok).toBe(true)
    expect(calls).toBe(2)
    // A success is cached: no further call.
    await adapter.probe()
    expect(calls).toBe(2)
    await adapter.probe(true)
    expect(calls).toBe(3)
  })
})

describe('OpenspecAdapter validate and showDeltas through a stub CLI', () => {
  const originalPath = process.env.PATH
  let dir: string
  let log: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-openspec-stub-'))
    log = path.join(dir, 'calls.log')
    fs.writeFileSync(path.join(dir, 'openspec'), STUB, { mode: 0o755 })
    process.env.PATH = `${dir}:${originalPath}`
    process.env.STUB_LOG = log
    process.env.STUB_LOCK = path.join(dir, 'stub.lock')
    process.env.STUB_COUNT = path.join(dir, 'stub.count')
    process.env.STUB_PEAK = path.join(dir, 'stub.peak')
    process.env.STUB_VERSION = '1.14.2'
  })

  afterEach(() => {
    process.env.PATH = originalPath
    delete process.env.STUB_LOG
    delete process.env.STUB_LOCK
    delete process.env.STUB_COUNT
    delete process.env.STUB_PEAK
    delete process.env.STUB_VERSION
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a missing executable is unavailable', async () => {
    // An isolated PATH with no openspec anywhere: the spawn itself fails.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-empty-path-'))
    const previous = process.env.PATH
    process.env.PATH = empty
    try {
      const probe = await new OpenspecAdapter(undefined, 2_000).probe(true)
      expect(probe.ok).toBe(false)
      expect(probe.error).toBe('openspec executable not found')
    } finally {
      process.env.PATH = previous
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  test('the probe passes --version, verified through the stub', async () => {
    // The stub answers --version only; a bare `openspec` reaches its
    // fallthrough, so this fails if the argument is dropped.
    const probe = await new OpenspecAdapter(undefined, 5_000).probe(true)
    expect(probe).toEqual({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null })
  })

  test('a valid and an invalid change', async () => {
    const adapter = new OpenspecAdapter(undefined, 5_000)
    const valid = await adapter.validate(dir, 'good-change')
    expect(valid).toEqual({ ok: true, error: null, valid: true, issues: [], issueCount: 0 })
    const invalid = await adapter.validate(dir, 'broken')
    expect(invalid.ok).toBe(true)
    expect(invalid.valid).toBe(false)
    expect(invalid.issues).toEqual([{ level: 'ERROR', message: 'No deltas' }])
  })

  test('a timeout is an error for that change', async () => {
    const adapter = new OpenspecAdapter(undefined, 200)
    const outcome = await adapter.validate(dir, 'sleeper')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('timed out')
  })

  test('a timeout kills the process group and returns within the grace, freeing the pool slot', async () => {
    const adapter = new OpenspecAdapter(undefined, 200)
    // `sleeper` blocks on a `sleep` grandchild; `stubborn` ignores SIGTERM.
    for (const change of ['sleeper', 'stubborn']) {
      const started = Date.now()
      const outcome = await adapter.validate(dir, change)
      const elapsed = Date.now() - started
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toContain('timed out')
      // 200 ms timeout + 250 ms grace + spawn slack — not the 2 s the stub sleeps.
      expect(elapsed).toBeLessThan(1_500)
    }
    // The pool slots freed: later calls still run.
    const after = await adapter.validate(dir, 'alpha')
    expect(after.ok).toBe(true)
  })

  test('unknown JSON shapes are errors', async () => {
    const adapter = new OpenspecAdapter(runner({ stdout: '{"summary":{}}' }), 5_000)
    const validate = await adapter.validate(dir, 'good-change')
    expect(validate.ok).toBe(false)
    expect(validate.error).toContain('unknown shape')
    const show = await new OpenspecAdapter(runner({ stdout: '{"deltas":"no"}' }), 5_000).showDeltas(dir, 'good-change')
    expect(show.ok).toBe(false)
    expect(show.error).toContain('unknown shape')
    const noJson = await new OpenspecAdapter(runner({ stdout: 'plain text', ok: false, exitCode: 1 }), 5_000).validate(dir, 'good-change')
    expect(noJson.ok).toBe(false)
    expect(noJson.error).toContain('no JSON')
  })

  test('a mismatched item id, a bogus operation, and a non-object issue are errors, not verdicts', async () => {
    const stub = new OpenspecAdapter(undefined, 5_000)
    expect((await stub.validate(dir, 'wrong-id')).error).toContain('unknown shape')
    expect((await stub.validate(dir, 'bad-issue')).error).toContain('unknown issue shape')
    expect((await stub.showDeltas(dir, 'bogus-op')).error).toContain('unknown operation BOGUS')
  })

  test('the exit code must agree with the verdict', async () => {
    const json = (valid: boolean) => `{"items":[{"id":"good-change","type":"change","valid":${valid},"issues":[]}]}`
    // Exit 0 while reporting invalid.
    const mismatched = await new OpenspecAdapter(runner({ stdout: json(false), exitCode: 0 }), 5_000).validate(dir, 'good-change')
    expect(mismatched.ok).toBe(false)
    expect(mismatched.error).toContain('reports valid=false')
    // Exit 1 while reporting valid.
    const reverse = await new OpenspecAdapter(runner({ stdout: json(true), ok: false, exitCode: 1 }), 5_000).validate(dir, 'good-change')
    expect(reverse.ok).toBe(false)
    expect(reverse.error).toContain('reports valid=true')
    // Exit 2 is a hard CLI failure even when the output parses.
    const crashed = await new OpenspecAdapter(runner({ stdout: json(false), ok: false, exitCode: 2 }), 5_000).validate(dir, 'good-change')
    expect(crashed.ok).toBe(false)
    expect(crashed.error).toContain('exited 2')
  })

  test('issues are capped at 50 with the full count kept', async () => {
    const issues = Array.from({ length: 60 }, (_, index) => ({ level: 'ERROR', message: `issue ${index}` }))
    const stdout = JSON.stringify({ items: [{ id: 'many-issues', type: 'change', valid: false, issues }] })
    const outcome = await new OpenspecAdapter(runner({ stdout, ok: false, exitCode: 1 }), 5_000).validate(dir, 'many-issues')
    expect(outcome.ok).toBe(true)
    expect(outcome.valid).toBe(false)
    expect(outcome.issues).toHaveLength(50)
    expect(outcome.issues.at(-1)!.message).toBe('issue 49')
    expect(outcome.issueCount).toBe(60)
  })

  test('a RENAMED delta yields two touches; a rename missing a name is an error', async () => {
    const adapter = new OpenspecAdapter(undefined, 5_000)
    const renamed = await adapter.showDeltas(dir, 'rename-change')
    expect(renamed).toEqual({
      ok: true, error: null,
      touches: [
        { capability: 'chat', operation: 'RENAMED', requirement: 'Old' },
        { capability: 'chat', operation: 'RENAMED', requirement: 'New' },
      ],
    })
    const broken = await adapter.showDeltas(dir, 'broken-rename')
    expect(broken.ok).toBe(false)
    expect(broken.error).toContain('RENAMED delta without both names')
    const noRequirement = await adapter.showDeltas(dir, 'no-requirement')
    expect(noRequirement.ok).toBe(false)
    expect(noRequirement.error).toContain('without requirement.name')
    const modified = await adapter.showDeltas(dir, 'alpha')
    expect(modified.touches).toEqual([{ capability: 'chat', operation: 'MODIFIED', requirement: 'Presence' }])
  })

  test('more than four calls at once wait for the pool', async () => {
    const adapter = new OpenspecAdapter(undefined, 5_000)
    const changes = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
    const outcomes = await Promise.all(changes.map(change => adapter.validate(dir, change)))
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    // The stub keeps an exact concurrency peak under flock (STUB_PEAK).
    const peak = Number(fs.readFileSync(process.env.STUB_PEAK!, 'utf8').trim())
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
})
