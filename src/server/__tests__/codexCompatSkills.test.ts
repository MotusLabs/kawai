// @reads: packages/agent-runtime/__tests__/fixtures/**
// C2 (task-752c9e4c; source codexSkillInputs S2/S7 and codex-chat-autocomplete
// design 97): a human send to a ready Codex chat keeps the skill identities
// its own catalog named when Kawai accepted it, through Kawai's production
// composition (createChatDriver → codexRuntime.ts → the public package
// factory) and the package's owned fake app-server over stdio (the
// codexSkillDirectory.test.ts setup). Expected inputs come from the catalog
// this test wrote and the caller's own send order; the turn input is what
// the process received.
// - A project move straight after the send, or from the getEffort or
//   onStatus callback that send runs, still loads the new directory at once
//   on the same process (R11) and reaches the next send.
// - A send those callbacks make goes after the one that ran them.
// - A send while the driver boots, and peer mail, carry text only; a steer
//   carries text only.
// Teardown kills the adapter, joins settled() and only then removes the root.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatEvent, ChatPeerMessage } from '../../shared/chat'
import type { SessionStatus } from '../../shared/types'
import { formatEnvelope } from '../team/envelope'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { codexRoot, type CodexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'

type Adapter = ReturnType<typeof createChatDriver> & { settled(): Promise<void> }
interface Run { root: CodexRoot; driver: Adapter; events: ChatEvent[]; work: string; changed: string }

const OLD = { name: 'deploy', path: '/old-project/skills/deploy/SKILL.md', description: 'old project deployment', scope: 'repo', enabled: true }
const NEW = { name: 'deploy', path: '/new-project/skills/deploy/SKILL.md', description: 'new project deployment', scope: 'repo', enabled: true }
const text = (t: string) => ({ type: 'text', text: t, text_elements: [] })
const skill = (s: { name: string; path: string }) => ({ type: 'skill', name: s.name, path: s.path })

const runs: Run[] = []
afterEach(async () => {
  for (const run of runs.splice(0)) {
    try {
      run.driver.kill()
      await run.driver.settled()
    } finally {
      fs.rmSync(run.root.root, { recursive: true, force: true })
    }
  }
})

async function until(probe: () => boolean) {
  const end = Date.now() + 5000
  while (!probe()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await Bun.sleep(5)
  }
}

interface Hooks { getEffort?: () => 'low' | 'high' | undefined; onStatus?: (status: SessionStatus) => void }

/** A Codex chat over the fake; the launch directory lists OLD, `other-project` lists NEW. */
function open(hooks: Hooks = {}): Run {
  const root = codexRoot()
  const work = path.join(root.root, 'work')
  const changed = path.join(root.root, 'other-project')
  fs.mkdirSync(changed)
  fs.writeFileSync(path.join(root.home, 'skills.json'), JSON.stringify({ skills: [OLD], byCwd: { [changed]: { skills: [NEW] } } }))
  const events: ChatEvent[] = []
  const driver = createChatDriver({ runtime: 'codex', options: {
    sessionId: 'chat-codex-c2', projectPath: work, executable: root.wrapper, codexHome: root.home, network: false,
    serverEnv: { PATH: process.env.PATH ?? '', HOME: root.root },
    withheldCredentials: () => new Set(), wire: { record() {} }, claimRateLimitsRead: () => false,
    onEvent: (event: ChatEvent) => events.push(event), onStatus: (status: SessionStatus) => hooks.onStatus?.(status),
    ...(hooks.getEffort ? { getEffort: hooks.getEffort } : {}),
  } as never }) as Adapter
  const run = { root, driver, events, work, changed }
  runs.push(run)
  return run
}

const received = (run: Run, method: string) => run.root.received().filter((m) => m.method === method)
const inputs = (run: Run, method = 'turn/start') => received(run, method).map((m) => m.params.input)
const lists = (run: Run) => received(run, 'skills/list').map((m) => m.params)
const completed = (run: Run) => run.events.filter((event) => event.type === 'turn_completed').length

async function ready(run: Run): Promise<void> {
  run.driver.start()
  await until(() => run.driver.getCommandState().status === 'ready')
}

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Invoke a completed or manually typed skill
test('C2: a ready send keeps the skill its catalog named when the project moves right after it; the same process then lists the new project for the next send', async () => {
  const run = open()
  await ready(run)
  run.driver.send('/deploy')
  run.driver.setProjectPath(run.changed)
  const afterMove = run.driver.getCommandState().status
  await until(() => completed(run) === 1 && run.driver.getCommandState().status === 'ready')
  run.driver.send('/deploy')
  await until(() => completed(run) === 2)
  expect({ afterMove, inputs: inputs(run), lists: lists(run), processes: received(run, 'initialize').length }).toEqual({
    afterMove: 'loading',
    inputs: [[text('/deploy'), skill(OLD)], [text('/deploy'), skill(NEW)]],
    lists: [{ cwds: [run.work], forceReload: false }, { cwds: [run.changed], forceReload: true }],
    processes: 1,
  })
})

for (const via of ['getEffort', 'onStatus'] as const) {
  test(`C2: a project move from the send's own ${via} callback leaves that send's skill and effort and moves the live catalog`, async () => {
    let armed = false
    let run!: Run
    const move = () => {
      if (!armed) return
      armed = false
      run.driver.setProjectPath(run.changed)
    }
    run = open({
      getEffort: () => {
        if (via === 'getEffort') move()
        return 'high'
      },
      onStatus: (status) => {
        if (via === 'onStatus' && status === 'working') move()
      },
    })
    await ready(run)
    armed = true
    run.driver.send('/deploy')
    await until(() => completed(run) === 1 && run.driver.getCommandState().status === 'ready')
    const start = received(run, 'turn/start')[0]!.params
    expect({ armed, input: start.input, effort: start.effort, last: lists(run).at(-1) }).toEqual({
      armed: false, input: [text('/deploy'), skill(OLD)], effort: 'high', last: { cwds: [run.changed], forceReload: true },
    })
  })
}

test("C2: a send from a send's own getEffort callback steers after it, and both steers carry text only", async () => {
  let nested = false
  let run!: Run
  run = open({
    getEffort: () => {
      if (nested) {
        nested = false
        run.driver.send('/deploy second')
      }
      return 'low'
    },
  })
  await ready(run)
  run.driver.send('/hold')
  await until(() => run.events.some((event) => event.type === 'turn_started'))
  nested = true
  run.driver.send('/deploy first')
  await until(() => received(run, 'turn/steer').length === 2)
  expect({ starts: inputs(run), steers: inputs(run, 'turn/steer') }).toEqual({
    starts: [[text('/hold')]],
    steers: [[text('/deploy first')], [text('/deploy second')]],
  })
})

test("C2: a send from a send's own onStatus callback cannot open its turn before that send", async () => {
  let nested = false
  let run!: Run
  run = open({
    onStatus: (status) => {
      if (nested && status === 'working') {
        nested = false
        run.driver.send('/deploy second')
      }
    },
  })
  // Its own teardown: the refused send is a reported owned failure.
  runs.splice(runs.indexOf(run), 1)
  try {
    await ready(run)
    nested = true
    run.driver.send('/deploy first')
    await until(() => completed(run) === 1)
    await Bun.sleep(100)
    // The nested send is a second new turn while the first is being admitted;
    // the package refuses it as busy, as it refuses any second new turn then.
    expect({
      nested,
      inputs: inputs(run),
      errors: run.events.flatMap((event) => (event.type === 'error' ? [event.message] : [])),
    }).toEqual({ nested: false, inputs: [[text('/deploy first'), skill(OLD)]], errors: ['Codex refused the turn: a turn is active'] })
  } finally {
    run.driver.kill()
    const failure = await run.driver.settled().then(() => null, (error: unknown) => error)
    fs.rmSync(run.root.root, { recursive: true, force: true })
    expect(String(failure)).toContain('a turn is active')
  }
})

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › A reference no longer resolves
test('C2 guard: a send made while the driver boots carries its text only even once the catalog is ready, with its own effort', async () => {
  const run = open({ getEffort: () => 'low' })
  run.driver.send('/deploy')
  await until(() => completed(run) === 1 && run.driver.getCommandState().status === 'ready')
  const start = received(run, 'turn/start')[0]!.params
  expect({ input: start.input, effort: start.effort }).toEqual({ input: [text('/deploy')], effort: 'low' })
})

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Peer mail and history
test('C2 guard: peer mail naming a ready skill carries its envelope text only', async () => {
  const run = open()
  await ready(run)
  const peer: ChatPeerMessage = {
    messageId: 'mail-1', senderSession: 'sender', senderGroup: null, priority: 'normal', possibleDuplicate: false,
    originPath: '/project', threadId: 'thread-1', tags: [], body: '/deploy',
  }
  run.driver.deliver(peer)
  await until(() => completed(run) === 1)
  expect(inputs(run)).toEqual([[text(formatEnvelope(peer))]])
})
