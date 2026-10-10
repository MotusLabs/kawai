// updateRestart.test.ts - supervisor detection and restart-verb selection:
// each launch mode maps to its own verb, a failed verb surfaces the named
// error, and bare mode exits after spawning the successor.
import { describe, expect, test } from 'bun:test'
import {
  detectRestartContext,
  performRestart,
  planRestart,
  type SpawnResult,
} from '../updates/updateRestart'

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

describe('performRestart', () => {
  const ok = async (): Promise<SpawnResult> => ({ exitCode: 0, stderr: '' })

  test('a supervisor verb that succeeds resolves', async () => {
    await performRestart(planRestart({ mode: 'systemd', systemdUnit: 'agentboard.service' }), { spawn: ok })
  })

  test('a failed supervisor verb surfaces the named error', async () => {
    const failing = async (): Promise<SpawnResult> => ({ exitCode: 1, stderr: 'Unit not found' })
    let refusal: unknown
    await performRestart(planRestart({ mode: 'systemd', systemdUnit: 'agentboard.service' }), { spawn: failing })
      .catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_RESTART_FAILED')
    expect(String((refusal as Error).message)).toContain('Unit not found')
  })

  test('a spawn that throws surfaces the named error', async () => {
    const throwing = async (): Promise<SpawnResult> => { throw new Error('ENOENT systemctl') }
    let refusal: unknown
    await performRestart(planRestart({ mode: 'launchd', launchdLabel: 'com.agentboard' }, { uid: 501 }), { spawn: throwing })
      .catch((cause) => { refusal = cause })
    expect(String((refusal as Error).message)).toContain('ERR_UPDATE_RESTART_FAILED')
    expect(String((refusal as Error).message)).toContain('ENOENT systemctl')
  })

  test('bare mode exits after spawning the successor', async () => {
    const commands: string[][] = []
    const exits: number[] = []
    await performRestart(
      planRestart({ mode: 'bare' }, { execPath: '/opt/agentboard/bin/agentboard', bareDelayMs: 0 }),
      {
        spawn: async (command) => { commands.push(command); return { exitCode: 0, stderr: '' } },
        exit: (code) => exits.push(code),
      },
    )
    expect(commands).toHaveLength(1)
    expect(exits).toEqual([0])
  })
})
