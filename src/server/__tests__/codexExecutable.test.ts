import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_MIN_VERSION,
  CodexExecutableError,
  checkCodexExecutable,
  parseCodexVersion,
  resetCodexExecutableCache,
  resolveCodexExecutable,
} from '../chat/codex/codexExecutable'
import { hasCodexLogin, codexLoginErrorMessage } from '../chat/codex/codexAuth'

/** Write an executable shell script and return its path. */
function makeExecutable(dir: string, name: string, script: string): string {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, script)
  fs.chmodSync(file, 0o755)
  return file
}

const versionScript = (version: string) =>
  `#!/bin/sh\necho "codex-cli ${version}"\n`

/** Throw with the kind and message when the promise rejects, else fail. */
async function expectRejection(
  promise: Promise<unknown>,
  kind: CodexExecutableError['kind']
): Promise<CodexExecutableError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CodexExecutableError)
    const typed = error as CodexExecutableError
    expect(typed.kind).toBe(kind)
    return typed
  }
  throw new Error('expected the executable check to fail')
}

beforeEach(() => resetCodexExecutableCache())

describe('resolveCodexExecutable', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-resolve-'))
  })
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  test('uses KAWAI_CODEX_PATH when set', () => {
    const exe = makeExecutable(tempDir, 'codex', '#!/bin/sh\n')
    expect(resolveCodexExecutable({ KAWAI_CODEX_PATH: exe, PATH: '/nonexistent' })).toBe(exe)
  })

  test('falls back to PATH when the override is unset', () => {
    const exe = makeExecutable(tempDir, 'codex', '#!/bin/sh\n')
    expect(resolveCodexExecutable({ PATH: tempDir })).toBe(exe)
  })

  test('falls back to PATH when the override is blank', () => {
    const exe = makeExecutable(tempDir, 'codex', '#!/bin/sh\n')
    expect(resolveCodexExecutable({ KAWAI_CODEX_PATH: '   ', PATH: tempDir })).toBe(exe)
  })

  test('returns null when nothing resolves', () => {
    expect(resolveCodexExecutable({ PATH: '/nonexistent' })).toBeNull()
  })

  test('makes a relative override absolute against the server working directory', () => {
    const exe = makeExecutable(tempDir, 'codex-relative', '#!/bin/sh\n')
    const resolved = resolveCodexExecutable({ KAWAI_CODEX_PATH: path.basename(exe) })
    expect(resolved).toBe(path.resolve(path.basename(exe)))
  })
})

describe('checkCodexExecutable', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-check-'))
  })
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  test('accepts an explicit path containing spaces as one path', async () => {
    const dir = path.join(tempDir, 'with spaces')
    const exe = makeExecutable(dir, 'codex', versionScript(CODEX_MIN_VERSION))
    const check = await checkCodexExecutable(exe)
    expect(check.path).toBe(exe)
  })

  test('the version probe gets PATH and HOME only, never a credential (openrouter-provider 1.8)', async () => {
    const names = path.join(tempDir, 'names.txt')
    const exe = makeExecutable(tempDir, 'codex', `#!/bin/sh\nenv | cut -d= -f1 > "${names}"\necho "codex-cli ${CODEX_MIN_VERSION}"\n`)
    const saved = { key: process.env.OPENROUTER_API_KEY, mgmt: process.env.OPENROUTER_MANAGEMENT_KEY }
    process.env.OPENROUTER_API_KEY = 'fake-or-key'
    process.env.OPENROUTER_MANAGEMENT_KEY = 'fake-or-mgmt'
    try {
      resetCodexExecutableCache()
      await checkCodexExecutable(exe)
    } finally {
      if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = saved.key
      if (saved.mgmt === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY
      else process.env.OPENROUTER_MANAGEMENT_KEY = saved.mgmt
    }
    const received = fs.readFileSync(names, 'utf8').split('\n')
    expect(received).toContain('PATH')
    expect(received).not.toContain('OPENROUTER_API_KEY')
    expect(received).not.toContain('OPENROUTER_MANAGEMENT_KEY')
  })

  test('refuses a value with arguments as a missing executable', async () => {
    const error = await expectRejection(
      checkCodexExecutable(`${tempDir}/codex --flag`),
      'missing'
    )
    expect(error.message).toContain(tempDir)
  })

  test('refuses a missing path with the install hint', async () => {
    const error = await expectRejection(
      checkCodexExecutable(path.join(tempDir, 'absent')),
      'missing'
    )
    expect(error.message).toContain('KAWAI_CODEX_PATH')
  })

  test('refuses a directory as not-executable', async () => {
    const error = await expectRejection(checkCodexExecutable(tempDir), 'not-executable')
    expect(error.message).toContain(tempDir)
  })

  test('refuses a file without execute permission', async () => {
    const file = path.join(tempDir, 'quiet')
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, 0o644)
    await expectRejection(checkCodexExecutable(file), 'not-executable')
  })

  test('refuses a version below the baseline, naming both versions', async () => {
    const exe = makeExecutable(tempDir, 'codex', versionScript('0.150.0'))
    const error = await expectRejection(checkCodexExecutable(exe), 'unsupported')
    expect(error.message).toContain('0.150.0')
    expect(error.message).toContain(CODEX_MIN_VERSION)
    expect(error.message).toContain(exe)
  })

  test('accepts the baseline version and newer ones', async () => {
    await checkCodexExecutable(makeExecutable(tempDir, 'a', versionScript(CODEX_MIN_VERSION)))
    await checkCodexExecutable(makeExecutable(tempDir, 'b', versionScript('1.0.0')))
  })
})

describe('executable cache', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-cache-'))
  })
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  test('re-checks after a failure once the executable is repaired', async () => {
    const exe = path.join(tempDir, 'codex')
    fs.writeFileSync(exe, versionScript('0.1.0'))
    fs.chmodSync(exe, 0o755)
    await expectRejection(checkCodexExecutable(exe), 'unsupported')
    fs.writeFileSync(exe, versionScript(CODEX_MIN_VERSION))
    await checkCodexExecutable(exe)
  })

  test('caches success until mtime changes, then re-probes', async () => {
    const exe = makeExecutable(tempDir, 'cached-codex', versionScript(CODEX_MIN_VERSION))
    // Pin exact whole-millisecond mtimes: Date objects carry no nanoseconds,
    // so a freshly written file could otherwise never match a restored one.
    const t0 = new Date(Date.now() - 60_000)
    fs.utimesSync(exe, t0, t0)
    await expect(checkCodexExecutable(exe)).resolves.toMatchObject({ path: exe })

    // Same mtime: the cached success returns even though the file now hangs.
    fs.writeFileSync(exe, '#!/bin/sh\nsleep 30\n')
    fs.chmodSync(exe, 0o755)
    fs.utimesSync(exe, t0, t0)
    await expect(checkCodexExecutable(exe, { timeoutMs: 200 })).resolves.toMatchObject({ path: exe })

    // A bumped mtime invalidates the cache; the hanging probe now fails.
    const t1 = new Date(t0.getTime() + 5000)
    fs.utimesSync(exe, t1, t1)
    await expectRejection(checkCodexExecutable(exe, { timeoutMs: 200 }), 'probe-failed')
  })

  test('kills a probe that exceeds its deadline', async () => {
    const exe = makeExecutable(tempDir, 'slow', '#!/bin/sh\nsleep 30\n')
    const started = Date.now()
    const error = await expectRejection(
      checkCodexExecutable(exe, { timeoutMs: 150 }),
      'probe-failed'
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(error.message).toContain('stopped')
  })

  test('refuses unparsable output, quoting it', async () => {
    const exe = makeExecutable(tempDir, 'chatty', '#!/bin/sh\necho "not a version"\n')
    const error = await expectRejection(checkCodexExecutable(exe), 'probe-failed')
    expect(error.message).toContain('not a version')
  })

  test('refuses a non-zero probe exit', async () => {
    const exe = makeExecutable(tempDir, 'failing', '#!/bin/sh\nexit 3\n')
    await expectRejection(checkCodexExecutable(exe), 'probe-failed')
  })
})

describe('version parsing', () => {
  test('parses the leading semver of real codex output', () => {
    expect(parseCodexVersion('codex-cli 0.163.0\n')).toBe('0.163.0')
  })

  test('rejects output without a leading version', () => {
    expect(parseCodexVersion('no version here')).toBeNull()
  })
})

describe('protocol baseline pairing (design D3)', () => {
  test('CODEX_MIN_VERSION equals the vendored protocol VERSION', async () => {
    const file = path.join(import.meta.dir, '../chat/codex/protocol/VERSION')
    expect((await Bun.file(file).text()).trim()).toBe(CODEX_MIN_VERSION)
  })
})

describe('hasCodexLogin', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-login-'))
  })
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  const home = (auth: unknown) => {
    const dir = path.join(tempDir, `home-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth))
    return dir
  }

  test('a missing auth file reads as no login', () => {
    expect(hasCodexLogin(path.join(tempDir, 'absent'))).toBeFalse()
  })

  test('an API key login is usable', () => {
    expect(hasCodexLogin(home({ OPENAI_API_KEY: 'sk-test', tokens: null }))).toBeTrue()
  })

  test('a ChatGPT token login is usable', () => {
    expect(hasCodexLogin(home({ OPENAI_API_KEY: null, tokens: { access_token: 'tok' } }))).toBeTrue()
  })

  test('empty strings read as no login; any nonempty value counts (N2)', () => {
    // Presence and type decide (N2): the value is never inspected beyond its
    // length, so whitespace still counts and the app-server re-verifies it.
    expect(hasCodexLogin(home({ OPENAI_API_KEY: '' }))).toBeFalse()
    expect(hasCodexLogin(home({ tokens: { access_token: '' } }))).toBeFalse()
    expect(hasCodexLogin(home({ OPENAI_API_KEY: '   ' }))).toBeTrue()
    expect(hasCodexLogin(home({ tokens: { access_token: '   ' } }))).toBeTrue()
    expect(hasCodexLogin(home({ tokens: null }))).toBeFalse()
  })

  test('an unparsable or non-object file reads as no login', () => {
    const broken = path.join(tempDir, 'broken')
    fs.mkdirSync(broken)
    fs.writeFileSync(path.join(broken, 'auth.json'), '{ torn')
    expect(hasCodexLogin(broken)).toBeFalse()
    expect(hasCodexLogin(home(['array']))).toBeFalse()
  })

  test('the refusal names the profile, never the home path (N1)', () => {
    const dir = path.join(tempDir, 'signed-out')
    const message = codexLoginErrorMessage('codex-a')
    // The profile-anchored shape: the pre-fix wording ("Codex home <path> …")
    // fails this anchor, as would any wording that echoes a path.
    expect(message).toMatch(/^Codex profile "codex-a" has no usable login/)
    expect(message).toContain('codex login')
    // The home path is trusted-tier filesystem layout: it stays on the
    // server and must not reach the browser through the refusal.
    expect(message).not.toContain(dir)
    expect(message).not.toContain(tempDir)
  })
})
