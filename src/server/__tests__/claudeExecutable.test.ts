import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_CODE_MIN_VERSION,
  ClaudeExecutableError,
  checkClaudeExecutable,
  compareVersions,
  ensureClaudeExecutable,
  parseClaudeVersion,
  resetClaudeExecutableCache,
  resolveClaudeExecutable,
} from '../chat/claudeExecutable'

/** Write an executable shell script and return its path. */
function makeExecutable(dir: string, name: string, script: string): string {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, script)
  fs.chmodSync(file, 0o755)
  return file
}

const versionScript = (version: string) =>
  `#!/bin/sh\necho "${version} (Claude Code)"\n`

/** Throw with the kind and message when the promise rejects, else fail. */
async function expectRejection(
  promise: Promise<unknown>,
  kind: ClaudeExecutableError['kind']
): Promise<ClaudeExecutableError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeExecutableError)
    const typed = error as ClaudeExecutableError
    expect(typed.kind).toBe(kind)
    return typed
  }
  throw new Error('expected the executable check to fail')
}

describe('resolveClaudeExecutable', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-claude-resolve-'))
  })
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  test('uses KAWAI_CLAUDE_PATH when set', () => {
    expect(
      resolveClaudeExecutable({ KAWAI_CLAUDE_PATH: '/opt/claude/bin', PATH: tempDir })
    ).toBe('/opt/claude/bin')
  })

  test('falls back to PATH when the override is unset', () => {
    makeExecutable(tempDir, 'claude', '#!/bin/sh\ntrue\n')
    expect(resolveClaudeExecutable({ PATH: tempDir })).toBe(path.join(tempDir, 'claude'))
  })

  test('falls back to PATH when the override is blank', () => {
    makeExecutable(tempDir, 'claude', '#!/bin/sh\ntrue\n')
    expect(resolveClaudeExecutable({ KAWAI_CLAUDE_PATH: '   ', PATH: tempDir })).toBe(
      path.join(tempDir, 'claude')
    )
  })

  test('returns null when nothing resolves', () => {
    expect(resolveClaudeExecutable({ KAWAI_CLAUDE_PATH: '', PATH: '' })).toBeNull()
  })

  test('makes a relative override absolute against the server working directory', () => {
    // The SDK spawns from each project directory; a relative path must not
    // be reinterpreted there.
    expect(resolveClaudeExecutable({ KAWAI_CLAUDE_PATH: './review-bin/claude', PATH: '' })).toBe(
      path.join(process.cwd(), 'review-bin', 'claude')
    )
  })
})

describe('checkClaudeExecutable', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-claude-exe-'))
    resetClaudeExecutableCache()
  })
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  test('accepts an explicit path containing spaces as one path', async () => {
    const exe = makeExecutable(
      tempDir,
      path.join('my tools', 'claude code'),
      versionScript('2.1.300')
    )
    await expect(checkClaudeExecutable(exe)).resolves.toMatchObject({ path: exe })
  })

  test('refuses a value with arguments as a missing executable', async () => {
    const error = await expectRejection(
      checkClaudeExecutable(path.join(tempDir, 'claude --verbose')),
      'missing'
    )
    expect(error.message).toContain('claude --verbose')
    expect(error.message).toContain('KAWAI_CLAUDE_PATH')
  })

  test('refuses a missing path with the install hint', async () => {
    const error = await expectRejection(
      checkClaudeExecutable(path.join(tempDir, 'absent-claude')),
      'missing'
    )
    expect(error.message).toContain('absent-claude')
    expect(error.message).toContain('Install Claude Code')
  })

  test('refuses a directory as not-executable', async () => {
    const dir = path.join(tempDir, 'a-directory')
    fs.mkdirSync(dir)
    const error = await expectRejection(checkClaudeExecutable(dir), 'not-executable')
    expect(error.message).toContain(dir)
  })

  test('refuses a file without execute permission', async () => {
    const exe = makeExecutable(tempDir, 'noexec-claude', versionScript('2.1.300'))
    fs.chmodSync(exe, 0o644)
    const error = await expectRejection(checkClaudeExecutable(exe), 'not-executable')
    expect(error.message).toContain(exe)
  })

  test('refuses a version below the baseline, naming both versions', async () => {
    const exe = makeExecutable(tempDir, 'old-claude', versionScript('2.1.100'))
    const error = await expectRejection(checkClaudeExecutable(exe), 'unsupported')
    expect(error.message).toContain('2.1.100')
    expect(error.message).toContain(CLAUDE_CODE_MIN_VERSION)
  })

  test('accepts the baseline version and newer ones', async () => {
    const base = makeExecutable(tempDir, 'base-claude', versionScript(CLAUDE_CODE_MIN_VERSION))
    await expect(checkClaudeExecutable(base)).resolves.toMatchObject({ path: base })
    const newer = makeExecutable(tempDir, 'new-claude', versionScript('3.0.0'))
    await expect(checkClaudeExecutable(newer)).resolves.toMatchObject({ path: newer })
  })

  test('refuses unparsable output, quoting it', async () => {
    const exe = makeExecutable(tempDir, 'weird-claude', '#!/bin/sh\necho "not a version"\n')
    const error = await expectRejection(checkClaudeExecutable(exe), 'probe-failed')
    expect(error.message).toContain('not a version')
  })

  test('refuses a non-zero probe exit', async () => {
    const exe = makeExecutable(tempDir, 'failing-claude', '#!/bin/sh\necho boom >&2\nexit 3\n')
    const error = await expectRejection(checkClaudeExecutable(exe), 'probe-failed')
    expect(error.message).toContain('exit code 3')
  })

  test('kills a probe that exceeds its deadline', async () => {
    const marker = path.join(tempDir, 'probe-ran')
    const exe = makeExecutable(
      tempDir,
      'hanging-claude',
      `#!/bin/sh\nsleep 1\necho ran > ${JSON.stringify(marker)}\necho "2.1.300"\n`
    )
    const error = await expectRejection(
      checkClaudeExecutable(exe, { timeoutMs: 150 }),
      'probe-failed'
    )
    expect(error.message).toContain('did not report its version')
    // The killed shell never reaches its marker write; an unkilled probe
    // would create it within ~1 s.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(fs.existsSync(marker)).toBe(false)
  })

  test('reaps a timed-out probe even when it ignores SIGTERM', async () => {
    const pidFile = path.join(tempDir, 'probe.pid')
    const exe = makeExecutable(
      tempDir,
      'ignores-term-claude',
      `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nwhile :; do sleep 1; done\n`
    )
    let pid: number | undefined
    try {
      const error = await expectRejection(
        checkClaudeExecutable(exe, { timeoutMs: 200 }),
        'probe-failed'
      )
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      expect(error.message).toContain('was stopped')
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      // Keep the test safe against regressions that leave the probe alive.
      if (pid === undefined && fs.existsSync(pidFile)) {
        pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      }
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL') } catch { /* Already reaped. */ }
      }
    }
  })

  test('re-checks after a failure once the executable is repaired', async () => {
    const exe = makeExecutable(tempDir, 'repaired-claude', versionScript('2.1.100'))
    await expectRejection(checkClaudeExecutable(exe), 'unsupported')
    fs.writeFileSync(exe, versionScript('2.1.300'))
    fs.chmodSync(exe, 0o755)
    await expect(checkClaudeExecutable(exe)).resolves.toMatchObject({ path: exe })
  })

  test('caches success until mtime changes, then re-probes', async () => {
    const exe = makeExecutable(tempDir, 'cached-claude', versionScript('2.1.300'))
    // Pin exact whole-millisecond mtimes: Date objects carry no nanoseconds,
    // so a freshly written file could otherwise never match a restored one.
    const t0 = new Date(Date.now() - 60_000)
    fs.utimesSync(exe, t0, t0)
    await expect(checkClaudeExecutable(exe)).resolves.toMatchObject({ path: exe })

    // Same mtime: the cached success returns even though the file now hangs.
    fs.writeFileSync(exe, '#!/bin/sh\nsleep 30\n')
    fs.chmodSync(exe, 0o755)
    fs.utimesSync(exe, t0, t0)
    await expect(checkClaudeExecutable(exe, { timeoutMs: 200 })).resolves.toMatchObject({ path: exe })

    // A bumped mtime invalidates the cache; the hanging probe now fails.
    const t1 = new Date(t0.getTime() + 5000)
    fs.utimesSync(exe, t1, t1)
    await expectRejection(checkClaudeExecutable(exe, { timeoutMs: 200 }), 'probe-failed')
  })
})

describe('ensureClaudeExecutable', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-claude-ensure-'))
    resetClaudeExecutableCache()
  })
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  test('resolves and checks the explicit override', async () => {
    const exe = makeExecutable(tempDir, 'explicit-claude', versionScript('2.1.300'))
    await expect(
      ensureClaudeExecutable({ KAWAI_CLAUDE_PATH: exe, PATH: '' })
    ).resolves.toMatchObject({ path: exe })
  })

  test('verifies and returns a relative override as an absolute path', async () => {
    const exe = makeExecutable(tempDir, 'relative-claude', versionScript('2.1.300'))
    const relative = path.relative(process.cwd(), exe)
    expect(path.isAbsolute(relative)).toBe(false)
    const checked = await ensureClaudeExecutable({ KAWAI_CLAUDE_PATH: relative, PATH: '' })
    expect(checked.path).toBe(exe)
  })

  test('resolves claude from PATH when no override is set', async () => {
    const exe = makeExecutable(tempDir, 'claude', versionScript('2.1.300'))
    await expect(ensureClaudeExecutable({ PATH: tempDir })).resolves.toMatchObject({ path: exe })
  })

  test('refuses creation with an actionable error when nothing resolves', async () => {
    const error = await expectRejection(ensureClaudeExecutable({ PATH: '' }), 'missing')
    expect(error.message).toContain('No Claude Code executable found')
    expect(error.message).toContain('KAWAI_CLAUDE_PATH')
  })

  test('reports a PATH-resolved executable that is too old', async () => {
    makeExecutable(tempDir, 'claude', versionScript('2.0.5'))
    const error = await expectRejection(ensureClaudeExecutable({ PATH: tempDir }), 'unsupported')
    expect(error.message).toContain('2.0.5')
  })
})

describe('version parsing', () => {
  test('parses the leading semver of real output', () => {
    expect(parseClaudeVersion('2.1.291 (Claude Code)\n')).toBe('2.1.291')
    expect(parseClaudeVersion('v2.2.0-beta.1 (Claude Code)')).toBe('2.2.0')
  })

  test('rejects output without a leading version', () => {
    expect(parseClaudeVersion('Claude Code version: 2.1.291')).toBeNull()
    expect(parseClaudeVersion('')).toBeNull()
  })

  test('compares numerically per component', () => {
    expect(compareVersions('2.1.289', '2.1.289')).toBe(0)
    expect(compareVersions('2.1.290', '2.1.289')).toBe(1)
    expect(compareVersions('2.1.99', '2.1.289')).toBe(-1)
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1)
  })
})

describe('baseline pinning', () => {
  test('CLAUDE_CODE_MIN_VERSION equals the SDK claudeCodeVersion', () => {
    const sdkPackage = JSON.parse(
      fs.readFileSync(
        path.join(
          import.meta.dir,
          '../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json'
        ),
        'utf8'
      )
    )
    expect(CLAUDE_CODE_MIN_VERSION).toBe(sdkPackage.claudeCodeVersion)
  })
})
