// launchdInstall.test.ts - the retargeted launchd installer runs the release
// binary: the wrapper execs the installed binary from the app root, the
// plist keeps the agent alive across clean exits (so a completed self-update
// restarts), a missing install downloads the platform tarball, and an
// existing one is reused.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..')
const INSTALL_SH = path.join(REPO_ROOT, 'launchd', 'install.sh')

let workRoot = ''
let home = ''
let shimDir = ''
let launchctlCalls: string[][] = []
let curlCalls: string[] = []
let fixtureTarball = ''

beforeEach(async () => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-launchd-install-'))
  home = path.join(workRoot, 'home')
  shimDir = path.join(workRoot, 'shims')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(shimDir, { recursive: true })
  launchctlCalls = []
  curlCalls = []

  const fixtureRoot = path.join(workRoot, 'fixture')
  fs.mkdirSync(path.join(fixtureRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, 'dist', 'client'), { recursive: true })
  fs.writeFileSync(path.join(fixtureRoot, 'bin', 'agentboard'), '#!/bin/sh\necho release\n', { mode: 0o755 })
  fs.writeFileSync(path.join(fixtureRoot, 'dist', 'client', 'index.html'), '<html>release</html>')
  fixtureTarball = path.join(workRoot, 'fixture.tar.gz')
  const tar = Bun.spawn(['tar', '-czf', fixtureTarball, '-C', fixtureRoot, 'bin', 'dist'], { stdout: 'ignore', stderr: 'ignore' })
  expect(await tar.exited).toBe(0)

  fs.writeFileSync(path.join(shimDir, 'launchctl'), '#!/bin/sh\necho "launchctl $*" >> "$LAUNCHCTL_CALLS_LOG"\nexit 0\n')
  fs.writeFileSync(
    path.join(shimDir, 'curl'),
    `#!/bin/sh\necho "$@" >> "$CURL_CALLS_LOG"\nOUT=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) OUT="$2"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\ncp "${fixtureTarball}" "$OUT"\n`,
  )
  fs.chmodSync(path.join(shimDir, 'launchctl'), 0o755)
  fs.chmodSync(path.join(shimDir, 'curl'), 0o755)
})

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true })
})

async function runInstaller(): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const launchctlLog = path.join(workRoot, 'launchctl-calls.log')
  const curlLog = path.join(workRoot, 'curl-calls.log')
  fs.writeFileSync(launchctlLog, '')
  fs.writeFileSync(curlLog, '')
  const proc = Bun.spawn(['bash', INSTALL_SH], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      LAUNCHCTL_CALLS_LOG: launchctlLog,
      CURL_CALLS_LOG: curlLog,
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
  launchctlCalls = fs.readFileSync(launchctlLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ').slice(1))
  curlCalls = fs.readFileSync(curlLog, 'utf8').split('\n').filter(Boolean)
  return { exitCode, stdout, stderr }
}

describe('launchd/install.sh', () => {
  test('downloads the release, wraps the binary, and keeps the agent alive across clean exits', async () => {
    const result = await runInstaller()
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)

    // The platform tarball was fetched and extracted into the app root.
    expect(curlCalls.join('\n')).toContain('agentboard-linux-x64.tar.gz')
    expect(fs.readFileSync(path.join(home, '.agentboard', 'app', 'bin', 'agentboard'), 'utf8')).toContain('release')

    // The wrapper execs the installed binary from the app root, with the
    // label pinned for the updater's kickstart verb.
    const wrapper = fs.readFileSync(path.join(home, '.agentboard', 'bin', 'agentboard-run.sh'), 'utf8')
    expect(wrapper).toContain(`exec "${home}/.agentboard/app/bin/agentboard"`)
    expect(wrapper).toContain(`cd "${home}/.agentboard/app"`)
    expect(wrapper).toContain('export AGENTBOARD_LAUNCHD_LABEL=com.agentboard')
    expect(wrapper).not.toContain('bun run start')

    const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.agentboard.plist'), 'utf8')
    expect(plist).toContain(`${home}/.agentboard/bin/agentboard-run.sh`)
    expect(plist).toContain(`<string>${home}/.agentboard/app</string>`)
    expect(plist).toContain('<key>SuccessfulExit</key><true/>')

    // Both agents were loaded.
    const verbs = launchctlCalls.map((args) => args.join(' '))
    expect(verbs).toContain(`load -w ${home}/Library/LaunchAgents/com.agentboard.plist`)
    expect(verbs).toContain(`load -w ${home}/Library/LaunchAgents/com.agentboard.logrotate.plist`)
  })

  test('reuses an existing install instead of downloading again', async () => {
    const appBin = path.join(home, '.agentboard', 'app', 'bin')
    fs.mkdirSync(appBin, { recursive: true })
    fs.writeFileSync(path.join(appBin, 'agentboard'), '#!/bin/sh\necho already here\n', { mode: 0o755 })

    const result = await runInstaller()
    expect(result.exitCode).toBe(0)
    expect(curlCalls).toEqual([])
    expect(fs.readFileSync(path.join(appBin, 'agentboard'), 'utf8')).toContain('already here')
  })
})
