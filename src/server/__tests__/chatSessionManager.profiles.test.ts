// chatSessionManager split: profiles tests.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { MetricsSnapshot } from '../metrics/export/snapshot'
import { NOTIFY_DEBOUNCE_MS } from '../metrics/observations/service'
import { closeDispatchers, createHarness, flush, initMessage, assistantUsage, resultWithWindow, compactBoundary, writeTranscript, installManagerCleanup } from './helpers/chatSessionManagerHarness'

installManagerCleanup()

describe('ChatSessionManager', () => {

  let tempDir: string
  let db: SessionDatabase

  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatmgr-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
    // Isolate auth from the host: no API key, empty CLI config dir. HOME is
    // pinned so the profile catalog resolves against an empty home — a real
    // ~/.kawai must not leak into these tests.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
    process.env.HOME = tempDir
  })

  afterEach(() => {
    if (originalOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
    if (originalAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    closeDispatchers()
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('observability foundation records managed task context, compaction, usage and acceptance without Prometheus', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    const h = await createHarness(db)
    const task = h.manager.tasks.store.create({teamId:'/tmp/proj',title:'foundation',direction:'fixture only',creator:{kind:'human',sessionId:null}})
    const created = h.manager.createSession({projectPath:'/tmp/proj',taskId:task.id})
    if(!created.ok)throw Error('create failed')
    expect((await h.manager.send(created.session.id,'fixture work')).ok).toBe(true)
    const handle=h.handles[0]!
    handle.push(initMessage('sdk-observability'))
    handle.push(assistantUsage(12000,'context-before'))
    handle.push(resultWithWindow())
    await flush()
    // A second turn has a known context threshold; the boundary preserves both sizes.
    await h.manager.send(created.session.id,'compact and finish')
    handle.push(assistantUsage(14000,'context-next'))
    handle.push(compactBoundary(3000))
    handle.push(resultWithWindow())
    await flush()
    const result=h.manager.tasks.store.results.insert({teamId:'/tmp/proj',taskId:task.id,taskRevision:1,summary:'fixture accepted',commit:null,diff:null,worktree:null,tests:[],limitations:null,submittedBy:{kind:'agent',sessionId:created.session.id}})
    h.manager.tasks.store.setStatus(task.id,'done',()=>{h.manager.tasks.store.results.markAccepted(result.id,{kind:'human',sessionId:null})})
    await flush()
    // Post-commit notifications reconcile in one debounced pass.
    await new Promise((resolve) => setTimeout(resolve, NOTIFY_DEBOUNCE_MS + 20))
    const observations = db.db.prepare('SELECT kind,data FROM process_observations').all() as {kind:string;data:string}[]
    for(const kind of ['turn_started','turn_ended','context','compaction','usage','acceptance'])expect(observations.some(row=>row.kind===kind)).toBe(true)
    expect(h.manager.observations.recorder.failures).toBe(0)
    const snapshot=new MetricsSnapshot(h.manager.observations).read()
    expect(snapshot).toContain('kawai_task_acceptance_duration_seconds_count')
    expect(snapshot).toContain('kawai_agent_compactions_total')
    expect(snapshot).toContain('source="provider-quota"} 0')
    writeTranscript('sdk-observability','[]')
    h.manager.shutdown()
    const restarted=await createHarness(db)
    expect(new MetricsSnapshot(restarted.manager.observations).read()).toContain('kawai_task_acceptance_duration_seconds_count')
    expect((db.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='acceptance'").get() as {n:number}).n).toBe(1)
    const resumed=await restarted.manager.send(created.session.id,'work after restart')
    if(!resumed.ok)throw Error(resumed.error)
    expect(restarted.handles[0]!.options.resume).toBe('sdk-observability')
    restarted.handles[0]!.push(initMessage('sdk-observability'))
    restarted.handles[0]!.push(resultWithWindow())
    await flush()
    const turns=restarted.manager.turnUsage.forSession(created.session.id)
    expect(turns).toHaveLength(3)
    expect(new Set(turns.map(turn=>turn.turnId)).size).toBe(3)
    expect((db.db.prepare("SELECT count(*) n FROM process_observations WHERE kind='turn_ended'").get() as {n:number}).n).toBe(3)
    restarted.manager.shutdown()
  })

  test('profiles persist, retain metadata, reject unknown IDs, and restore the SDK conversation', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const first = await createHarness(db)
    expect(first.manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'unknown' }).ok).toBe(false)
    expect(db.getChatSessions()).toEqual([])
    expect(first.registry.getAll()).toEqual([])
    const created = first.manager.createSession({ projectPath: '/tmp/proj', claudeProfileId: 'glm' })
    if (!created.ok) throw new Error(created.error)
    expect(created.session.claudeProfileId).toBe('glm')
    const id = created.session.id
    expect(db.getChatSession(id)?.claudeProfileId).toBe('glm')
    await first.manager.send(id, 'first')
    first.handles[0]!.push(initMessage('profile-conversation'))
    await flush()
    writeTranscript('profile-conversation', JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }))
    first.manager.shutdown()
    const restored = await createHarness(db)
    expect(restored.registry.get(id)?.claudeProfileId).toBe('glm')
    expect((await restored.manager.send(id, 'resume')).ok).toBe(true)
    expect(restored.handles[0]!.options.resume).toBe('profile-conversation')
    expect(restored.handles[0]!.options.model).toBe('opus')
    expect(restored.handles[0]!.options.env?.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    restored.manager.shutdown()
    db.updateChatSession(id, { claudeProfileId: 'removed-profile' })
    const unknown = await createHarness(db)
    expect(unknown.registry.get(id)?.claudeProfileId).toBe('removed-profile')
    const result = await unknown.manager.send(id, 'resume')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('removed-profile')
    expect(unknown.handles).toHaveLength(0)
    expect(db.getChatSession(id)?.sdkSessionId).toBe('profile-conversation')
    unknown.manager.shutdown()
  })

})
