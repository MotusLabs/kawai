// updateRestart.test.ts - supervisor detection and restart-verb selection:
// each launch mode maps to its own verb, a failed verb surfaces the named
// error, and bare mode exits after spawning the successor.
import { describe, expect, test } from 'bun:test'
import {
  detectRestartContext,
  performRestart,
  planRestart,
  planRestartAfterInstall,
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

  test('a source install execs the freshly installed binary, even under a supervisor', () => {
    // Restarting the unit (or this bun process) would restart the source
    // build; the successor must be the release binary that just landed.
    const plan = planRestartAfterInstall(
      detectRestartContext({ INVOCATION_ID: 'abc123' } as NodeJS.ProcessEnv),
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
})
