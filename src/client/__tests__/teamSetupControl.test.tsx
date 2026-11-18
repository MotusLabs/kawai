// The Members tab's Set up team (starter-team-setup D1–D3, team-workspace
// ADDED requirement): offered from the snapshot's flag, above the group rows
// or in place of an empty list; choosing it asks for the preview and writes
// nothing until Confirm; Cancel sends nothing; the run's answer — success,
// skip, or refusal — shows inline, routed by the protocol handler; every
// control is disabled while disconnected, and a dropped connection releases
// the wait.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { TeamMemberRow } from '@shared/teamWorkspace'
import type { TeamSetupPreview } from '@shared/teamSetup'
import TeamSetupControl from '../components/team/TeamSetupControl'
import TeamMembersPanel from '../components/team/TeamMembersPanel'
import { useTeamSetupStore } from '../stores/teamSetupStore'
import { useTeamWorkspaceDataStore } from '../stores/teamWorkspaceDataStore'
import { handleTeamSetupMessage } from '../protocol/teamWorkspaceMessages'
import { releaseStrandedWaits } from '../protocol/connectionWaits'

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll(node => node.props['data-testid'] === id)
const one = (renderer: TestRenderer.ReactTestRenderer, id: string) => byId(renderer, id)[0]!

const PREVIEW: TeamSetupPreview = {
  available: true,
  targetDir: '/repo/.kawai/groups',
  groups: [
    { id: 'lead', label: 'Team Lead', description: 'Plans work.', workers: [{ profileId: 'codex-sol', cap: 1 }], max: 1, crossModelReview: false },
    { id: 'devs', label: 'Dev', description: 'Builds.', workers: [{ profileId: 'opus', cap: 1 }, { profileId: 'codex-sol', cap: 1 }], max: 2, crossModelReview: false },
    { id: 'reviewers', label: 'Reviewers', description: 'Reviews.', workers: [{ profileId: 'codex-sol', cap: 1 }, { profileId: 'opus', cap: 1 }], max: 2, crossModelReview: true },
  ],
  warnings: ['Profile codex-sol is not defined in this team\'s catalog; its slots will not staff until it is.'],
}

let sent: ClientMessage[]
beforeEach(() => {
  sent = []
  useTeamWorkspaceDataStore.setState({ views: { '/repo': { teamId: 'team', snapshot: null } }, approvalSaves: {} })
  useTeamSetupStore.setState({ setups: {} })
})
afterEach(() => {
  useTeamWorkspaceDataStore.setState({ views: {}, approvalSaves: {} })
  useTeamSetupStore.setState({ setups: {} })
})

const control = (available: boolean, connected = true) =>
  <TeamSetupControl teamPath="/repo" available={available} connected={connected} sendMessage={message => sent.push(message)} />
const mount = (available: boolean, connected = true) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(control(available, connected)) })
  return renderer
}
const row = (id: string): TeamMemberRow => ({
  id, label: id, description: '', canCreateTasks: false, approval: 'manual', approvalSource: 'built-in', max: 1,
  strategy: 'least-busy', onLimit: { parkIfResetWithinMs: 3_600_000, otherwise: 'park' }, profiles: [], warnings: [], members: [],
  sources: [{ file: `/home/u/.kawai/groups/${id}.md`, layer: 'user', inEffect: true }],
} as unknown as TeamMemberRow)
const panel = (members: TeamMemberRow[], available: boolean) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMembersPanel loaded members={members} onOpenSession={() => {}} setupControl={control(available)} />)
  })
  return renderer
}
const openPreview = (renderer: TestRenderer.ReactTestRenderer) => {
  act(() => one(renderer, 'team-setup-open').props.onClick())
  act(() => handleTeamSetupMessage({ type: 'team-workspace-setup-preview-result', teamPath: '/repo', ok: true, preview: PREVIEW }))
}

// @covers: team-workspace › Members offers Set up team as its only group-file write › The empty state offers setup
// @covers: team-setup › The setup action is offered to a team without project groups › A new repository is offered the action
test('a team with no groups anywhere shows Set up team where the rows would be', () => {
  const renderer = panel([], true)
  expect(textOf(one(renderer, 'team-setup-open'))).toBe('Set up team')
  expect(byId(renderer, 'member-group')).toHaveLength(0)
})

// @covers: team-workspace › Members offers Set up team as its only group-file write › User-level groups show beneath the action
// @covers: team-setup › The setup action is offered to a team without project groups › User-level groups do not hide the action
test('user-level groups list beneath the action', () => {
  const renderer = panel([row('reviewers-sol')], true)
  const container = one(renderer, 'team-members')
  const order = container.findAll(node => ['team-setup', 'member-group'].includes(node.props['data-testid'])).map(node => node.props['data-testid'])
  expect(order).toEqual(['team-setup', 'member-group'])
})

// @covers: team-setup › The setup action is offered to a team without project groups › Any project group file hides the action
// @covers: team-workspace › Members is a read-only inspection of group settings › Members cannot be edited
test('a team with project group files is not offered the action', () => {
  const renderer = panel([row('devs')], false)
  expect(byId(renderer, 'team-setup')).toHaveLength(0)
  expect(renderer.root.findAll(node => node.type === 'button' && /set up|edit|save/i.test(textOf(node)))).toHaveLength(0)
})

// @covers: team-setup › The setup previews the starter team before writing › The preview lists the three groups
// @covers: team-setup › The setup previews the starter team before writing › A missing worker profile is warned
test('choosing Set up team asks for the preview; it shows groups, workers, the flag, the target, and warnings', () => {
  const renderer = mount(true)
  act(() => one(renderer, 'team-setup-open').props.onClick())
  expect(sent).toEqual([{ type: 'team-workspace-setup-preview', teamPath: '/repo' }])
  expect(one(renderer, 'team-setup-open').props.disabled).toBe(true)
  act(() => handleTeamSetupMessage({ type: 'team-workspace-setup-preview-result', teamPath: '/repo', ok: true, preview: PREVIEW }))
  expect(textOf(one(renderer, 'team-setup-target'))).toBe('/repo/.kawai/groups')
  const groups = byId(renderer, 'team-setup-group').map(node => textOf(node))
  expect(groups).toEqual([
    'Team Lead (lead.md) · 1 × codex-sol · max 1Plans work.',
    'Dev (devs.md) · 1 × opus, 1 × codex-sol · max 2Builds.',
    'Reviewers (reviewers.md) · 1 × codex-sol, 1 × opus · max 2 · cross-model reviewReviews.',
  ])
  expect(textOf(one(renderer, 'team-setup-warnings'))).toContain('codex-sol is not defined')
  expect(one(renderer, 'team-setup-confirm').props.disabled).toBe(false)
  expect(sent).toHaveLength(1)
})

// @covers: team-setup › The setup previews the starter team before writing › Cancelling writes nothing
test('Cancel closes the preview and sends nothing', () => {
  const renderer = mount(true)
  openPreview(renderer)
  act(() => one(renderer, 'team-setup-cancel').props.onClick())
  expect(byId(renderer, 'team-setup-preview')).toHaveLength(0)
  expect(sent).toEqual([{ type: 'team-workspace-setup-preview', teamPath: '/repo' }])
})

test('Confirm sends the run; success names the files and the edit note, and the action leaves with the flag', () => {
  const renderer = mount(true)
  openPreview(renderer)
  act(() => one(renderer, 'team-setup-confirm').props.onClick())
  expect(sent.at(-1)).toEqual({ type: 'team-workspace-setup-run', teamPath: '/repo' })
  expect(one(renderer, 'team-setup-confirm').props.disabled).toBe(true)
  act(() => handleTeamSetupMessage({ type: 'team-workspace-setup-result', teamPath: '/repo', ok: true, created: ['lead.md', 'devs.md'], skipped: ['reviewers.md'] }))
  act(() => renderer.update(control(false)))
  expect(byId(renderer, 'team-setup-open')).toHaveLength(0)
  expect(textOf(one(renderer, 'team-setup-result'))).toBe(
    'Created lead.md, devs.md. Kept existing reviewers.md. Edit the files directly; prompt changes apply to future agent starts.')
})

test('a refusal shows inline as an alert, and a failed preview shows its error', () => {
  const renderer = mount(true)
  openPreview(renderer)
  act(() => one(renderer, 'team-setup-confirm').props.onClick())
  const error = 'The team already has group files: devs.md. Set up team never overwrites them.'
  act(() => handleTeamSetupMessage({ type: 'team-workspace-setup-result', teamPath: '/repo', ok: false, reason: 'already-set-up', error, created: [], skipped: [] }))
  expect(one(renderer, 'team-setup-result').props.role).toBe('alert')
  expect(textOf(one(renderer, 'team-setup-result'))).toBe(error)
  act(() => one(renderer, 'team-setup-open').props.onClick())
  act(() => handleTeamSetupMessage({ type: 'team-workspace-setup-preview-result', teamPath: '/repo', ok: false, error: 'Unknown team: /repo' }))
  expect(textOf(one(renderer, 'team-setup-result'))).toBe('Unknown team: /repo')
})

// @covers: team-workspace › Members offers Set up team as its only group-file write › Setup is disabled while disconnected
test('every control is disabled while disconnected, and a dropped connection releases the wait', () => {
  const offline = mount(true, false)
  expect(one(offline, 'team-setup-open').props.disabled).toBe(true)
  act(() => one(offline, 'team-setup-open').props.onClick())
  expect(sent).toEqual([])
  const renderer = mount(true)
  openPreview(renderer)
  act(() => renderer.update(control(true, false)))
  expect(one(renderer, 'team-setup-confirm').props.disabled).toBe(true)
  act(() => renderer.update(control(true, true)))
  act(() => one(renderer, 'team-setup-confirm').props.onClick())
  act(() => releaseStrandedWaits('disconnected'))
  expect(useTeamSetupStore.getState().setups['/repo']!.pending).toBeNull()
  expect(byId(renderer, 'team-setup-preview')).toHaveLength(1)
})

// @covers: team-workspace › Members is a read-only inspection of group settings › The only write is the setup action
test('with no project group files, Set up team is the tab’s only group-file write', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMembersPanel loaded members={[row('reviewers-sol')]} onOpenSession={() => {}}
      setupControl={control(true)} />)
  })
  const buttons = renderer.root.findAll(node => node.type === 'button').map(node => node.props['data-testid'] ?? textOf(node))
  expect(buttons).toEqual(['team-setup-open'])
})
