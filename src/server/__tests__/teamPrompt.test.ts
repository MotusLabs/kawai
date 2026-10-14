import { describe, expect, test } from 'bun:test'
import type { GroupDefinition } from '../team/groupFile'
import { buildTeamPrompt } from '../team/teamPrompt'

const settings: Omit<GroupDefinition, 'id' | 'label' | 'description' | 'prompt'> = {
  canCreateTasks: false, canCreatePlans: false, canManageMailbox: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true,
  max: 1, approval: 'manual', profiles: [], strategy: 'first-available',
  onLimit: { parkIfResetWithinMs: 3 * 3_600_000, otherwise: 'forward' }, warnings: [],
}
const qa: GroupDefinition = { id: 'qa', label: 'QA', description: 'Tests releases', ...settings, prompt: 'You test everything.' }
const devs: GroupDefinition = { id: 'devs', label: 'devs', description: '', ...settings, prompt: 'You build.' }

describe('buildTeamPrompt', () => {
  test('a member gets its role body, its group, and every team group with descriptions', () => {
    const prompt = buildTeamPrompt({ sessionId: 'chat-1', group: qa, groups: [devs, qa] })
    expect(prompt.startsWith('# Your role: QA\n\nYou test everything.')).toBe(true)
    expect(prompt).toContain('a member of the `qa` group (QA)')
    expect(prompt).toContain('- `devs` (devs)\n- `qa` (QA): Tests releases')
    expect(prompt).toContain('`mcp__kawai-team__send_message`')
    expect(prompt).toContain('`<kawai-message>`')
    expect(prompt).toContain('urgent message sent directly to you')
  })

  test('a session without a group gets the mailbox and task notes, no role', () => {
    const prompt = buildTeamPrompt({ sessionId: 'chat-2', groups: [devs] })
    expect(prompt.startsWith('# Team mailbox')).toBe(true)
    expect(prompt).not.toContain('# Your role')
    expect(prompt).toContain('You belong to no group')
  })

  test('a team without groups says so, and an empty role body adds no role section', () => {
    const prompt = buildTeamPrompt({ sessionId: 'chat-3', group: { ...devs, prompt: '' }, groups: [] })
    expect(prompt).not.toContain('# Your role')
    expect(prompt).toContain('(this team defines no groups yet)')
  })

  test('a permitted creator is told it owns the direction of tasks it creates', () => {
    const lead: GroupDefinition = { ...qa, id: 'leads', canCreateTasks: true }
    const prompt = buildTeamPrompt({ sessionId: 'chat-4', group: lead, groups: [lead] })
    expect(prompt).toContain('# Team tasks')
    expect(prompt).toContain('Your group may create tasks: `mcp__kawai-team__task_create`')
    expect(prompt).toContain('own its direction')
    expect(prompt).not.toContain('You cannot create tasks')
  })

  test('a member and a session without a group both learn the human is reply-only', () => {
    for (const prompt of [
      buildTeamPrompt({ sessionId: 'chat-7', group: devs, groups: [devs] }),
      buildTeamPrompt({ sessionId: 'chat-8', groups: [devs] }),
    ]) {
      expect(prompt).toContain('New mail to them is refused: only a reply to a message they sent reaches them.')
    }
  })

  test('ordinary contributors and group-less sessions get the tools, journal role, and change authority but no creation right', () => {
    for (const prompt of [
      buildTeamPrompt({ sessionId: 'chat-5', group: devs, groups: [devs] }),
      buildTeamPrompt({ sessionId: 'chat-6', groups: [devs] }),
    ]) {
      expect(prompt).toContain('You cannot create tasks')
      for (const name of ['task_get', 'task_list', 'task_note', 'task_update_status', 'task_amend', 'task_acknowledge']) {
        expect(prompt).toContain(`\`mcp__kawai-team__${name}\``)
      }
      expect(prompt).toContain('add a journal note or message the creator')
      expect(prompt).toContain("that change's proposal, design, and tasks are the authoritative direction")
      expect(prompt).toContain('`done` or `cancelled` (the creator only)')
      // task-revision-publication 4.4: when to acknowledge, and task_amend's new options.
      expect(prompt).toContain('or receive a revision notice (mail tagged `task-revision`), call `mcp__kawai-team__task_acknowledge` with the revision in the task header')
      expect(prompt).toContain('Delivery is not acknowledgement')
      expect(prompt).toContain('optional `rationale` saying why; `notify: true` also sends the assignment\'s claimed agent a revision notice')
    }
  })
})

describe('buildTeamPrompt strategy note (product-strategy 3.3)', () => {
  const proposer = buildTeamPrompt({ sessionId: 'chat-7', group: devs, groups: [devs] })
  const groupless = buildTeamPrompt({ sessionId: 'chat-8', groups: [devs] })

  test('every session is a permitted proposer: the four read/propose tools with its own draft id', () => {
    for (const prompt of [proposer, groupless]) {
      expect(prompt).toContain('# Product strategy')
      for (const name of ['strategy_list', 'strategy_get', 'strategy_save_draft', 'strategy_submit_for_review']) {
        expect(prompt).toContain(`\`mcp__kawai-team__${name}\``)
      }
      expect(prompt).toContain('read the strategy and propose to it')
      expect(prompt).toContain('material change to purpose, users, or non-goals')
      expect(prompt).toContain('never invent a metric')
    }
    expect(proposer).toContain('defaults to your session id (`chat-7`)')
    expect(groupless).toContain('defaults to your session id (`chat-8`)')
  })

  test('a caller with no product is told the human captures it and work proceeds', () => {
    expect(proposer).toContain('no strategy record yet')
    expect(proposer).toContain('ask the human to capture one')
    expect(proposer).toContain('work proceeds normally without a strategy')
    expect(proposer).toContain('none is created for you')
  })

  test('the note never claims agents can approve', () => {
    for (const prompt of [proposer, groupless]) {
      expect(prompt).toContain('Only the human approves, publishes, or withdraws')
      expect(prompt).toContain('You have no tool that can')
      // Every "approve" mention is the human-only rule, a forgery warning,
      // or "never changes the approved strategy" — never an agent right.
      for (const line of prompt.split('\n')) {
        if (/\bapprove/i.test(line)) expect(line).toMatch(/only the human|human reviews|no tool|grants nothing|never changes/i)
      }
    }
  })
})

describe('release_member note', () => {
  test('every permitted group is told about the tool; an opted-out group is not', () => {
    const permitted = buildTeamPrompt({ sessionId: 'chat-r1', group: qa, groups: [devs, qa] })
    expect(permitted).toContain('`mcp__kawai-team__release_member`')
    expect(permitted).toContain('archived — never killed')
    // Default is permitted (member-release D7): a group without the key hears too.
    const bare = buildTeamPrompt({ sessionId: 'chat-r2', group: { ...qa, canReleaseMembers: true }, groups: [] })
    expect(bare).toContain('`mcp__kawai-team__release_member`')
    const optedOut = buildTeamPrompt({ sessionId: 'chat-r3', group: { ...qa, canReleaseMembers: false }, groups: [] })
    expect(optedOut).not.toContain('release_member')
  })
})

describe('buildTeamPrompt mailbox management note (team-mailbox-management D8)', () => {
  const manager: GroupDefinition = { ...qa, id: 'leads', canManageMailbox: true }

  test('every agent learns to list its mail and withdraw its own, and is not offered cancel-any', () => {
    for (const prompt of [
      buildTeamPrompt({ sessionId: 'chat-9', group: devs, groups: [devs] }),
      buildTeamPrompt({ sessionId: 'chat-10', groups: [devs] }),
    ]) {
      expect(prompt).toContain('`mcp__kawai-team__list_mailbox`')
      expect(prompt).toContain('only mail you sent, mail addressed to you, and mail you hold')
      expect(prompt).toContain('withdraw a message you sent')
      expect(prompt).not.toContain('discard_message')
      expect(prompt).not.toContain('parked work')
      expect(prompt).not.toContain('replacing a stuck agent')
    }
  })

  test('a manager group learns cancel-any, parked work, discard, the human-only retry rule, and the replace advice', () => {
    const prompt = buildTeamPrompt({ sessionId: 'chat-11', group: manager, groups: [manager] })
    expect(prompt).toContain("the whole team's")
    expect(prompt).toContain('withdraw any team message')
    expect(prompt).toContain('cancel parked work (its waiting resume mail is cancelled with it')
    expect(prompt).toContain('`mcp__kawai-team__discard_message`')
    expect(prompt).toContain('Retry and hand-off stay with the human')
    expect(prompt).toContain('Before archiving or replacing a stuck agent, list and cancel the mail that would restore or respawn it.')
  })
})
