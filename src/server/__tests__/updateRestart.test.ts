// updateRestart.test.ts - supervisor detection and restart-verb selection:
// each launch mode maps to its own verb, a failed verb surfaces the named
// error, and bare mode exits after spawning the successor.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectRestartContext,
  performRestart,
  planRestart,
  planRestartAfterInstall,
  planSystemdSourceAdoption,
  restartAfterInstall,
  writeSystemdSourceAdoption,
  type SpawnedCommand,
  type SpawnResult,
} from '../updates/updateRestart'

const command = (result: SpawnResult): SpawnedCommand => ({ exited: Promise.resolve(result) })

describe('detectRestartContext', () => {
  test('systemd is detected from $INVOCATION_ID', () => {
    expect(detectRestartContext({ INVOCATION_ID: 'abc123' } as NodeJS.ProcessEnv)).toEqual({
      mode: 'systemd',
      systemdUnit: 'agentboard.service',
    })
  })

  test('systemd honors a pinned unit name', () => {
    expect(
      detectRestartContext({ INVOCATION_ID: 'abc', AGENTBOARD_SYSTEMD_UNIT: 'kawai.service' } as NodeJS.ProcessEnv),
    ).toEqual({ mode: 'systemd', systemdUnit: 'kawai.service' })
  })

  test('launchd is detected from $XPC_SERVICE_NAME', () => {
    expect(detectRestartContext({ XPC_SERVICE_NAME: 'com.agentboard' } as NodeJS.ProcessEnv)).toEqual({
      mode: 'launchd',
      launchdLabel: 'com.agentboard',
    })
    expect(
      detectRestartContext({ XPC_SERVICE_NAME: 'whatever', AGENTBOARD_LAUNCHD_LABEL: 'com.kawai' } as NodeJS.ProcessEnv),
    ).toEqual({ mode: 'launchd', launchdLabel: 'com.kawai' })
  })

  test('anything else is bare', () => {
    expect(detectRestartContext({})).toEqual({ mode: 'bare' })
  })
})

describe('planRestart', () => {
  test('systemd restarts its unit', () => {
    const plan = planRestart({ mode: 'systemd', systemdUnit: 'agentboard.service' })
    expect(plan.command).toEqual(['systemctl', '--user', 'restart', 'agentboard.service'])
    expect(plan.exitsAfterSpawn).toBe(false)
  })

  test('launchd kickstarts the agent for the current uid', () => {
    const plan = planRestart({ mode: 'launchd', launchdLabel: 'com.agentboard' }, { uid: 501 })
    expect(plan.command).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.agentboard'])
    expect(plan.exitsAfterSpawn).toBe(false)
  })

  test('bare re-execs the binary with the same argv after a grace period', () => {
    const plan = planRestart(
      { mode: 'bare' },
      { execPath: '/opt/agentboard/bin/agentboard', argv: ['--port', '4040'], bareDelayMs: 500 },
    )
    expect(plan.command).toEqual([
      'sh',
      '-c',
      'sleep 0.5; exec "$0" "$@"',
      '/opt/agentboard/bin/agentboard',
      '--port',
      '4040',
    ])
    expect(plan.exitsAfterSpawn).toBe(true)
    // No cwd pinned: the successor inherits this process's directory.
    expect(plan.cwd).toBeUndefined()
  })

  test('bare can pin the successor working directory', () => {
    const plan = planRestart({ mode: 'bare' }, { cwd: '/opt/agentboard' })
    expect(plan.cwd).toBe('/opt/agentboard')
  })
})

describe('planRestartAfterInstall', () => {
  test('a compiled install keeps its supervisor context', () => {
    const plan = planRestartAfterInstall(
      detectRestartContext({ INVOCATION_ID: 'abc123' } as NodeJS.ProcessEnv),
      { root: '/opt/agentboard', compiled: true },
    )
    expect(plan.mode).toBe('systemd')
    expect(plan.command).toEqual(['systemctl', '--user', 'restart', 'agentboard.service'])
    expect(plan.exitsAfterSpawn).toBe(false)
  })

  test('a source install under systemd adopts the unit instead of spawning a child', () => {
    // A bare successor would live in the unit's cgroup: service cleanup kills
    // it when this process exits (and Restart=always revives the source
    // build). The unit must be re-exec'd onto the installed binary itself.
    const plan = planRestartAfterInstall(
      detectRestartContext({ INVOCATION_ID: 'abc123', AGENTBOARD_SYSTEMD_UNIT: 'kawai.service' } as NodeJS.ProcessEnv),
      { root: '/home/dev/.agentboard/app', compiled: false },
    )
    expect(plan.mode).toBe('systemd')
    expect(plan.command).toEqual([
      'sh',
      '-c',
      'systemctl --user daemon-reload && exec systemctl --user restart "$0"',
      'kawai.service',
    ])
    expect(plan.exitsAfterSpawn).toBe(false)
    // No bare successor is spawned for this mode at all.
    expect(plan.command.join(' ')).not.toContain('sleep')
  })

  test('a source install execs the freshly installed binary under launchd or bare', () => {
    // Restarting the agent (or this bun process) would restart the source
    // build; the successor must be the release binary that just landed.
    const plan = planRestartAfterInstall(
      detectRestartContext({ XPC_SERVICE_NAME: 'com.agentboard' } as NodeJS.ProcessEnv),
      { root: '/home/dev/.agentboard/app', compiled: false },
      { bareDelayMs: 500 },
    )
    expect(plan.mode).toBe('bare')
    expect(plan.command).toEqual([
      'sh',
      '-c',
      'sleep 0.5; exec "$0" "$@"',
      '/home/dev/.agentboard/app/bin/agentboard',
    ])
    expect(plan.exitsAfterSpawn).toBe(true)
    // The successor runs from the install root so the cwd-relative client
    // bundle resolves to the fresh release, not the source checkout.
    expect(plan.cwd).toBe('/home/dev/.agentboard/app')
  })

  test('a source install carries no source argv into the successor', () => {
    const plan = planRestartAfterInstall(
      { mode: 'bare' },
      { root: '/home/dev/.agentboard/app', compiled: false },
      { execPath: '/usr/local/bin/bun', argv: ['src/server/index.ts'], bareDelayMs: 0 },
    )
    expect(plan.command).toEqual([
      'sh',
      '-c',
      'sleep 0; exec "$0" "$@"',
      '/home/dev/.agentboard/app/bin/agentboard',
    ])
  })

  test('a compiled bare install also restarts from the install root', () => {
    const plan = planRestartAfterInstall({ mode: 'bare' }, { root: '/opt/agentboard', compiled: true })
    expect(plan.mode).toBe('bare')
    expect(plan.cwd).toBe('/opt/agentboard')
  })
})

describe('systemd source adoption', () => {
  const systemd = detectRestartContext({ INVOCATION_ID: 'abc123' } as NodeJS.ProcessEnv)
  const install = { root: '/home/dev/.agentboard/app', compiled: false }

  test('plans a drop-in pointing the unit at the installed release', () => {
    const adoption = planSystemdSourceAdoption(systemd, install, { homeDir: '/home/dev' })
    expect(adoption.unitFile).toBe('agentboard.service')
    expect(adoption.dropInPath).toBe(
      '/home/dev/.config/systemd/user/agentboard.service.d/50-agentboard-update.conf',
    )
    expect(adoption.contents).toContain('[Service]')
    expect(adoption.contents).toContain('WorkingDirectory=/home/dev/.agentboard/app')
    // ExecStart is a list directive: the empty assignment must reset the
    // unit's own ExecStart immediately before the replacement is set, or
    // systemd rejects the unit for having two ExecStart entries.
    expect(adoption.contents).toContain(
      'ExecStart=\nExecStart=/home/dev/.agentboard/app/bin/agentboard\n',
    )
  })

  test('normalizes a suffix-less pinned unit and honors the pin', () => {
    const pinned = detectRestartContext({
      INVOCATION_ID: 'abc',
      AGENTBOARD_SYSTEMD_UNIT: 'kawai',
    } as NodeJS.ProcessEnv)
    const adoption = planSystemdSourceAdoption(pinned, install, { homeDir: '/home/dev' })
    expect(adoption.unitFile).toBe('kawai.service')
    expect(adoption.dropInPath).toBe(
      '/home/dev/.config/systemd/user/kawai.service.d/50-agentboard-update.conf',
    )
  })

  test('writes the drop-in directory and file', () => {
    const adoption = planSystemdSourceAdoption(systemd, install, { homeDir: '/home/dev' })
    const dirs: string[] = []
    const files: Array<{ path: string; contents: string }> = []
    writeSystemdSourceAdoption(adoption, {
      mkdir: (dir) => dirs.push(dir),
      writeFile: (file, contents) => files.push({ path: file, contents }),
    })
    expect(dirs).toEqual(['/home/dev/.config/systemd/user/agentboard.service.d'])
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe(adoption.dropInPath)
    expect(files[0]?.contents).toBe(adoption.contents)
  })

  test('restartAfterInstall writes the drop-in, then reloads and restarts the unit', async () => {
    const adoption = planSystemdSourceAdoption(systemd, install, { homeDir: '/home/dev' })
    const dirs: string[] = []
    const files: string[] = []
    const commands: string[][] = []
    const plan = await restartAfterInstall(systemd, install, {
      homeDir: '/home/dev',
      mkdir: (dir) => dirs.push(dir),
      writeFile: (file) => files.push(file),
      spawn: (command) => {
        commands.push(command)
        return { exited: Promise.resolve({ exitCode: 0, stderr: '' }) }
      },
    })
    expect(plan.mode).toBe('systemd')
    expect(dirs).toEqual([adoption.dropInPath.slice(0, adoption.dropInPath.lastIndexOf('/'))])
    expect(files).toEqual([adoption.dropInPath])
    expect(commands).toEqual([[
      'sh',
      '-c',
      'systemctl --user daemon-reload && exec systemctl --user restart "$0"',
      'agentboard.service',
    ]])
  })

  test('restartAfterInstall leaves non-systemd modes unprepared', async () => {
    const files: string[] = []
    const commands: string[][] = []
    await restartAfterInstall(
      { mode: 'bare' },
      { root: '/home/dev/.agentboard/app', compiled: false },
      {
        mkdir: () => { throw new Error('no adoption expected') },
        writeFile: () => files.push('unexpected'),
        spawn: (command, cwd) => {
          commands.push([String(cwd), ...command])
          return { exited: new Promise<SpawnResult>(() => {}) }
        },
        exit: () => {},
      },
    )
    expect(files).toEqual([])
    expect(commands).toHaveLength(1)
    expect(commands[0]?.[0]).toBe('/home/dev/.agentboard/app')
  })

  test('the generated drop-in passes systemd-analyze against a stock unit', async () => {
    const systemdAnalyze = Bun.which('systemd-analyze')
    if (systemdAnalyze === null) return // off-Linux: the reset-then-set shape is pinned above
    // Real install root so verify can check the ExecStart target exists.
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-adoption-'))
    try {
      fs.mkdirSync(path.join(workRoot, 'app', 'bin'), { recursive: true })
      const binPath = path.join(workRoot, 'app', 'bin', 'agentboard')
      fs.writeFileSync(binPath, '#!/bin/sh\nexec sleep 9999\n', { mode: 0o755 })
      const adoption = planSystemdSourceAdoption(systemd, { root: path.join(workRoot, 'app'), compiled: false }, { homeDir: '/home/dev' })
      const unitDir = path.join(workRoot, 'units')
      fs.mkdirSync(path.join(unitDir, 'agentboard.service.d'), { recursive: true })
      // The stock shape from systemd/install.sh, running a source command.
      fs.writeFileSync(
        path.join(unitDir, 'agentboard.service'),
        '[Unit]\nDescription=Agentboard\n\n[Service]\nType=simple\n' +
          `WorkingDirectory=${workRoot}/kawai\n` +
          'ExecStart=/usr/local/bin/bun run start\n',
      )
      fs.writeFileSync(path.join(unitDir, 'agentboard.service.d', '50-agentboard-update.conf'), adoption.contents)
      const proc = Bun.spawn([systemdAnalyze, 'verify', path.join(unitDir, 'agentboard.service')], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(stderr).not.toContain('more than one ExecStart')
      expect(stderr).not.toContain('Refusing')
      expect(exitCode).toBe(0)
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true })
    }
  })
})

describe('performRestart', () => {
  test('a supervisor verb that succeeds resolves', async () => {
    await performRestart(planRestart({ mode: 'systemd', systemdUnit: 'agentboard.service' }), {
      spawn: () => command({ exitCode: 0, stderr: '' }),
    })
  })

  test('a failed supervisor verb surfaces the named error', async () => {
    let refusal: unknown
    await performRestart(planRestart({ mode: 'systemd', systemdUnit: 'agentboard.service' }), {
      spawn: () => command({ exitCode: 1, stderr: 'Unit not found' }),
    }).catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_RESTART_FAILED')
    expect(String((refusal as Error).message)).toContain('Unit not found')
  })

  test('a spawn that throws surfaces the named error', async () => {
    const throwing = (): SpawnedCommand => { throw new Error('ENOENT systemctl') }
    let refusal: unknown
    await performRestart(planRestart({ mode: 'launchd', launchdLabel: 'com.agentboard' }, { uid: 501 }), { spawn: throwing })
      .catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_RESTART_FAILED')
    expect(String((refusal as Error).message)).toContain('ENOENT systemctl')
  })

  test('bare mode exits after spawning the successor, without awaiting it', async () => {
    const commands: string[][] = []
    const exits: number[] = []
    let successorResolved = false
    await performRestart(
      planRestart({ mode: 'bare' }, { execPath: '/opt/agentboard/bin/agentboard', bareDelayMs: 0 }),
      {
        // The successor never exits (it is a server); bare mode must not
        // wait for it.
        spawn: (cmd) => {
          commands.push(cmd)
          return { exited: new Promise<SpawnResult>(() => { successorResolved = true }) }
        },
        exit: (code) => exits.push(code),
      },
    )
    expect(commands).toHaveLength(1)
    expect(exits).toEqual([0])
    expect(successorResolved).toBe(true)
  })

  test('the successor working directory reaches the spawner', async () => {
    const spawned: Array<{ command: string[]; cwd?: string }> = []
    await performRestart(
      planRestartAfterInstall({ mode: 'bare' }, { root: '/home/dev/.agentboard/app', compiled: false }, { bareDelayMs: 0 }),
      {
        spawn: (command, cwd) => {
          spawned.push({ command, cwd })
          return { exited: new Promise<SpawnResult>(() => {}) }
        },
        exit: () => {},
      },
    )
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.cwd).toBe('/home/dev/.agentboard/app')
  })
})
