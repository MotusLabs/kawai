// A Kawai project move reaches the live Codex skill catalog (task 6.1 R11,
// F2/A9/A14; reviewer reproducer findings-ae03e397, SHA 6e1c412f), through the
// public createChatDriver and the owned fake app-server over stdio. As the
// source CodexSessionDriver.setProjectPath -> commands.changeDirectory did:
// the catalog is loading at once, so the next human send carries its text
// only, then the same process lists the new directory (forceReload) and a
// later send carries the new directory's skill path. A move while the driver
// boots reaches the catalog once it is ready.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { codexRoot, type CodexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'

type Adapter = ReturnType<typeof createChatDriver> & { settled(): Promise<void> }

async function until(probe: () => boolean) {
  const end = Date.now() + 5000
  while (!probe()) {
    if (Date.now() > end) throw new Error('cwd probe did not reach its native boundary')
    await Bun.sleep(5)
  }
}

const OLD = { name: 'deploy', path: '/old-project/skills/deploy/SKILL.md', description: 'old project deployment', scope: 'repo', enabled: true }
const NEW = { name: 'deploy', path: '/new-project/skills/deploy/SKILL.md', description: 'new project deployment', scope: 'repo', enabled: true }

function adapter(root: CodexRoot): Adapter {
  return createChatDriver({ runtime: 'codex', options: {
    sessionId: 'cwd-catalog', projectPath: path.join(root.root, 'work'), executable: root.wrapper,
    codexHome: root.home, network: false,
    serverEnv: { PATH: process.env.PATH ?? '', HOME: root.root },
    withheldCredentials: () => new Set(), wire: { record() {} }, onEvent() {}, onStatus() {},
  } as never }) as Adapter
}

const turnStarts = (root: CodexRoot) => root.received().filter((m) => m.method === 'turn/start')
const lists = (root: CodexRoot) => root.received().filter((m) => m.method === 'skills/list').map((m) => m.params)

// @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex skill directory moves on a live process
test('public default Codex composition: moving the project invalidates old skills before the next human send', async () => {
  const root = codexRoot()
  const changed = path.join(root.root, 'other-project')
  fs.mkdirSync(changed)
  fs.writeFileSync(path.join(root.home, 'skills.json'), JSON.stringify({ skills: [OLD] }))
  const driver = adapter(root)
  try {
    driver.start()
    await until(() => driver.getCommandState().status === 'ready')
    expect(driver.getCommandState().commands.map((c) => c.name)).toEqual(['deploy'])
    driver.setProjectPath(changed)
    const afterMove = driver.getCommandState().status
    driver.send('/deploy')
    await until(() => turnStarts(root).length > 0)
    const sent = turnStarts(root)[0]!
    expect({ afterMove, nativeInput: sent.params.input }).toEqual({
      afterMove: 'loading', nativeInput: [{ type: 'text', text: '/deploy', text_elements: [] }],
    })
  } finally {
    driver.kill()
    await driver.settled().catch(() => {})
    fs.rmSync(root.root, { recursive: true, force: true })
  }
})

test('public default Codex composition: after a move the same process lists the new project and the next send carries its skill path', async () => {
  const root = codexRoot()
  const work = path.join(root.root, 'work')
  const changed = path.join(root.root, 'other-project')
  fs.mkdirSync(changed)
  fs.writeFileSync(path.join(root.home, 'skills.json'), JSON.stringify({ skills: [OLD], byCwd: { [changed]: { skills: [NEW] } } }))
  const driver = adapter(root)
  try {
    driver.start()
    await until(() => driver.getCommandState().status === 'ready')
    driver.setProjectPath(changed)
    await until(() => driver.getCommandState().status === 'ready')
    driver.send('/deploy')
    await until(() => turnStarts(root).length > 0)
    expect({
      lists: lists(root),
      processes: root.received().filter((m) => m.method === 'initialize').length,
      nativeInput: turnStarts(root)[0]!.params.input,
    }).toEqual({
      lists: [{ cwds: [work], forceReload: false }, { cwds: [changed], forceReload: true }],
      processes: 1,
      nativeInput: [{ type: 'text', text: '/deploy', text_elements: [] }, { type: 'skill', name: 'deploy', path: NEW.path }],
    })
  } finally {
    driver.kill()
    await driver.settled().catch(() => {})
    fs.rmSync(root.root, { recursive: true, force: true })
  }
})

async function bootMove(when: 'before its launch' | 'after its process started'): Promise<void> {
  const root = codexRoot()
  const changed = path.join(root.root, 'other-project')
  fs.mkdirSync(changed)
  fs.writeFileSync(path.join(root.home, 'skills.json'), JSON.stringify({ skills: [OLD], byCwd: { [changed]: { skills: [NEW] } } }))
  const driver = adapter(root)
  try {
    driver.start()
    if (when === 'after its process started') await until(() => root.received().some((m) => m.method === 'initialize'))
    driver.setProjectPath(changed)
    await until(() => driver.getCommandState().status === 'ready' && lists(root).some((p) => p.cwds[0] === changed))
    driver.send('/deploy')
    await until(() => turnStarts(root).length > 0)
    // Before its launch the new directory is the launch cwd; after, the live process lists it with forceReload.
    expect({ last: lists(root).at(-1), nativeInput: turnStarts(root)[0]!.params.input }).toEqual({
      last: { cwds: [changed], forceReload: when === 'after its process started' },
      nativeInput: [{ type: 'text', text: '/deploy', text_elements: [] }, { type: 'skill', name: 'deploy', path: NEW.path }],
    })
  } finally {
    driver.kill()
    await driver.settled().catch(() => {})
    fs.rmSync(root.root, { recursive: true, force: true })
  }
}

test("public default Codex composition: a move while the driver boots, before its launch, lists only the new project's skills", () => bootMove('before its launch'))

test("public default Codex composition: a move while the driver boots, after its process started, lists only the new project's skills", () => bootMove('after its process started'))
