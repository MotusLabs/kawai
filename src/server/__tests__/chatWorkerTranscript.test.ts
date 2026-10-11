import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readWorkerTranscript } from '../chat/chatWorkerTranscript'

const SDK_ID = 'sdk-parent-1'
const WORKER_ID = 'toolu_spawn_1'

describe('readWorkerTranscript', () => {
  let tempDir: string
  let projectDir: string
  let subagentsDir: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-workers-'))
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-proj')
    subagentsDir = path.join(projectDir, SDK_ID, 'subagents')
    fs.mkdirSync(subagentsDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${SDK_ID}.jsonl`), '')
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const writeAgent = (agentId: string, toolUseId: string, lines: string) => {
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'Explore', toolUseId, spawnDepth: 1 })
    )
    fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), lines)
  }

  const sidechainLine = (uuid: string, type: 'user' | 'assistant', content: unknown) =>
    JSON.stringify({
      uuid,
      isSidechain: true,
      type,
      timestamp: '2026-10-11T10:00:00.000Z',
      message: { role: type, content },
    })

  test('reads the sidechain body of the agent whose meta claims the tool call', () => {
    writeAgent('other', 'toolu_other', sidechainLine('o1', 'user', 'not mine') + '\n')
    writeAgent(
      'a1',
      WORKER_ID,
      [
        sidechainLine('u1', 'user', 'Map the workspace'),
        sidechainLine('a1', 'assistant', [{ type: 'text', text: 'Found three packages.' }]),
      ].join('\n') + '\n'
    )

    const result = readWorkerTranscript(SDK_ID, WORKER_ID)
    expect(result.status).toBe('ok')
    const texts = result.events.map(event =>
      'text' in event ? event.text : event.type
    )
    expect(texts).toEqual(['Map the workspace', 'Found three packages.'])
  })

  test('drops a trailing partial line written while the worker still runs', () => {
    writeAgent(
      'a1',
      WORKER_ID,
      sidechainLine('u1', 'user', 'Map the workspace') + '\n{"uuid":"a1","isSide'
    )
    const result = readWorkerTranscript(SDK_ID, WORKER_ID)
    expect(result.status).toBe('ok')
    expect(result.events).toHaveLength(1)
  })

  test('skips a corrupt meta and keeps scanning', () => {
    fs.writeFileSync(path.join(subagentsDir, 'agent-bad.meta.json'), '{not json')
    writeAgent('a1', WORKER_ID, sidechainLine('u1', 'user', 'hello') + '\n')
    expect(readWorkerTranscript(SDK_ID, WORKER_ID).status).toBe('ok')
  })

  test('reports unavailable for every missing link', () => {
    expect(readWorkerTranscript(null, WORKER_ID)).toEqual({ status: 'unavailable', events: [] })
    expect(readWorkerTranscript('sdk-unknown', WORKER_ID).status).toBe('unavailable')
    // Parent found, but no meta claims the call.
    expect(readWorkerTranscript(SDK_ID, WORKER_ID).status).toBe('unavailable')
    // Meta claims it, but the body file is gone.
    writeAgent('a1', WORKER_ID, '')
    fs.rmSync(path.join(subagentsDir, 'agent-a1.jsonl'))
    expect(readWorkerTranscript(SDK_ID, WORKER_ID).status).toBe('unavailable')
  })

  test('reports unavailable when the session has no subagents directory', () => {
    fs.rmSync(path.join(projectDir, SDK_ID), { recursive: true })
    expect(readWorkerTranscript(SDK_ID, WORKER_ID).status).toBe('unavailable')
  })
})
