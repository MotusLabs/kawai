// @reads: packages/agent-runtime/__tests__/fixtures/**
// A Codex send keeps the skill inputs its catalog named when send() was
// called (task-752c9e4c C2; source codexSkillInputs S7, "skill identities
// captured at send remain fixed"), through the public factory and the owned
// fake app-server over stdio. The send's admission yields before its
// beforeSubmit and commit; a directory move in that gap — straight after the
// call, or from the host's own beforeSubmit — still clears the live catalog
// at once (R11), but cannot change the inputs of the send already made. The
// expected paths are the catalog this test wrote; the turn input is what the
// process received.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import type { CommandState } from '../src/activity.js'
import type { CodexAgentDriver } from '../src/contract.js'
import { codexDriver, sent, stopDrivers, waitFor, type CodexRoot, type HarnessOptions } from './helpers/codexDriverHarness.js'

afterEach(async () => {
  await stopDrivers()
})

const DEPLOY = { name: 'deploy', path: '/old-project/skills/deploy/SKILL.md', description: 'old deployment', scope: 'repo', enabled: true }
const MOVED = { name: 'deploy', path: '/new-project/skills/deploy/SKILL.md', description: 'new deployment', scope: 'repo', enabled: true }
const text = (t: string) => ({ type: 'text', text: t, text_elements: [] })
const skill = (s: { name: string; path: string }) => ({ type: 'skill', name: s.name, path: s.path })
const inputs = (root: CodexRoot) => sent(root, 'turn/start').map((message) => message.params.input)
const listed = (root: CodexRoot) => sent(root, 'skills/list').map((message) => message.params)

/** A ready driver listing DEPLOY at its launch cwd and MOVED at a second directory. */
async function ready(options: HarnessOptions = {}) {
  const states: CommandState[] = []
  const h = { ...codexDriver({ ...options, callbacks: { onCommandState: (state) => states.push(state) } }), states }
  const moved = join(h.root.root, 'other-project')
  mkdirSync(moved)
  writeFileSync(join(h.root.home, 'skills.json'), JSON.stringify({ skills: [DEPLOY], byCwd: { [moved]: { skills: [MOVED] } } }))
  await h.driver.start()
  await waitFor(() => h.states.at(-1)?.status === 'ready')
  return { ...h, moved }
}

// @covers: agent-runtime › Host-compatibility inputs and observations are optional › Native Codex skill input
test('C2: a send keeps the skill its catalog named at send() when the directory moves straight after the call', async () => {
  const h = await ready()
  const opening = h.driver.send('/deploy')
  h.driver.setSkillDirectory!(h.moved)
  const afterMove = h.states.at(-1)?.status
  await (await opening).result
  await waitFor(() => h.states.at(-1)?.status === 'ready' && listed(h.root).length === 2)
  await (await h.driver.send('/deploy')).result
  expect({ afterMove, inputs: inputs(h.root), listed: listed(h.root), processes: sent(h.root, 'initialize').length }).toEqual({
    afterMove: 'loading',
    inputs: [[text('/deploy'), skill(DEPLOY)], [text('/deploy'), skill(MOVED)]],
    listed: [{ cwds: [h.root.launch().cwd], forceReload: false }, { cwds: [h.moved], forceReload: true }],
    processes: 1,
  })
})

// @covers: agent-runtime › Host-compatibility inputs and observations are optional › Native Codex skill input
test("C2: a move from the host's own beforeSubmit leaves that send's captured skill and moves the live catalog", async () => {
  let driver!: CodexAgentDriver
  let moved = ''
  const seen: string[] = []
  const h = await ready({
    beforeSubmit: (submission) => {
      seen.push(submission.text)
      if (seen.length === 1) driver.setSkillDirectory!(moved)
      return { accepted: true }
    },
  })
  driver = h.driver
  moved = h.moved
  await (await h.driver.send('/deploy')).result
  await waitFor(() => h.states.at(-1)?.status === 'ready' && listed(h.root).length === 2)
  expect({ seen, inputs: inputs(h.root), last: listed(h.root).at(-1), states: h.states.map((state) => state.status) }).toEqual({
    seen: ['/deploy'],
    inputs: [[text('/deploy'), skill(DEPLOY)]],
    last: { cwds: [h.moved], forceReload: true },
    states: ['loading', 'ready', 'loading', 'ready'],
  })
})
