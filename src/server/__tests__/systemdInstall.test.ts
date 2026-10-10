// systemdInstall.test.ts - the retargeted systemd installer drives the
// release binary: the generated unit's ExecStart is the installed binary
// with Restart=always, a missing install downloads the platform tarball, an
// existing one is reused, and systemctl is driven through daemon-reload →
// enable → start.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..')
const INSTALL_SH = path.join(REPO_ROOT, 'systemd', 'install.sh')

let workRoot = ''
let home = ''
let shimDir = ''
let systemctlCalls: string[][] = []
let curlCalls: string[] = []
let fixtureTarball = ''

beforeEach(async () => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-systemd-install-'))
  home = path.join(workRoot, 'home')
  shimDir = path.join(workRoot, 'shims')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(shimDir, { recursive: true })
  systemctlCalls = []
  curlCalls = []

  // A real tarball fixture the fake curl "downloads".
  const fixtureRoot = path.join(workRoot, 'fixture')
  fs.mkdirSync(path.join(fixtureRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, 'dist', 'client'), { recursive: true })
  fs.writeFileSync(path.join(fixtureRoot, 'bin', 'agentboard'), '#!/bin/sh\necho release\n', { mode: 0o755 })
  fs.writeFileSync(path.join(fixtureRoot, 'dist', 'client', 'index.html'), '<html>release</html>')
  fixtureTarball = path.join(workRoot, 'fixture.tar.gz')
  const tar = Bun.spawn(['tar', '-czf', fixtureTarball, '-C', fixtureRoot, 'bin', 'dist'], { stdout: 'ignore', stderr: 'ignore' })
  expect(await tar.exited).toBe(0)

  fs.writeFileSync(path.join(shimDir, 'systemctl'), '#!/bin/sh\necho "systemctl $*" >> "$SYSTEMD_CALLS_LOG"\nexit 0\n')
  fs.writeFileSync(
    path.join(shimDir, 'curl'),
    `#!/bin/sh\necho "$@" >> "$CURL_CALLS_LOG"\nOUT=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) OUT="$2"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\ncp "${fixtureTarball}" "$OUT"\n`,
  )
  fs.chmodSync(path.join(shimDir, 'systemctl'), 0o755)
  fs.chmodSync(path.join(shimDir, 'curl'), 0o755)
})

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true })
})

async function runInstaller(): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const callsLog = path.join(workRoot, 'systemctl-calls.log')
  const curlLog = path.join(workRoot, 'curl-calls.log')
  fs.writeFileSync(callsLog, '')
  fs.writeFileSync(curlLog, '')
  const proc = Bun.spawn(['bash', INSTALL_SH], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      SYSTEMD_CALLS_LOG: callsLog,
      CURL_CALLS_LOG: curlLog,
      // Keep the sandbox-visible temp dir out of the unit's PATH noise.
      TMPDIR: workRoot,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  systemctlCalls = fs.readFileSync(callsLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ').slice(1))
  curlCalls = fs.readFileSync(curlLog, 'utf8').split('\n').filter(Boolean)
  return { exitCode, stdout, stderr }
}

const unitPath = () => path.join(home, '.config', 'systemd', 'user', 'agentboard.service')

describe('systemd/install.sh', () => {
  test('downloads the release and generates a unit running the binary with Restart=always', async () => {
    const result = await runInstaller()
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)

    // The release tarball was fetched for this host platform and extracted.
    expect(curlCalls.join('\n')).toContain('agentboard-linux-x64.tar.gz')
    expect(fs.readFileSync(path.join(home, '.agentboard', 'app', 'bin', 'agentboard'), 'utf8')).toContain('release')
    expect(fs.readFileSync(path.join(home, '.agentboard', 'app', 'dist', 'client', 'index.html'), 'utf8')).toContain('release')

    const unit = fs.readFileSync(unitPath(), 'utf8')
    expect(unit).toContain(`ExecStart=${home}/.agentboard/app/bin/agentboard`)
    expect(unit).toContain(`WorkingDirectory=${home}/.agentboard/app`)
    // The policy that lets a clean exit (and a completed self-update
    // restart) bring the service back.
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment=AGENTBOARD_SYSTEMD_UNIT=agentboard.service')

    // The unit is written into the user directory, not the checkout.
    expect(fs.existsSync(path.join(REPO_ROOT, 'systemd', 'agentboard.service'))).toBe(false)

    // systemctl drove the full sequence.
    const verbs = systemctlCalls.map((args) => args.join(' '))
    expect(verbs).toContain('--user daemon-reload')
    expect(verbs).toContain('--user enable agentboard.service')
    expect(verbs).toContain('--user start agentboard.service')
  })

  test('reuses an existing install instead of downloading again', async () => {
    const appBin = path.join(home, '.agentboard', 'app', 'bin')
    fs.mkdirSync(appBin, { recursive: true })
    fs.writeFileSync(path.join(appBin, 'agentboard'), '#!/bin/sh\necho already here\n', { mode: 0o755 })

    const result = await runInstaller()
    expect(result.exitCode).toBe(0)
    expect(curlCalls).toEqual([])
    expect(fs.readFileSync(path.join(appBin, 'agentboard'), 'utf8')).toContain('already here')
    const unit = fs.readFileSync(unitPath(), 'utf8')
    expect(unit).toContain(`ExecStart=${home}/.agentboard/app/bin/agentboard`)
  })
})
