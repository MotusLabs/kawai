import { describe, expect, test } from 'bun:test'
import type { GroupDefinition } from '../team/groupFile'
import { buildTeamPrompt } from '../team/teamPrompt'

const settings = { canCreateTasks: false, max: 1, approval: 'manual' } as const
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

  test('ordinary contributors and group-less sessions get the tools, journal role, and change authority but no creation right', () => {
    for (const prompt of [
      buildTeamPrompt({ sessionId: 'chat-5', group: devs, groups: [devs] }),
      buildTeamPrompt({ sessionId: 'chat-6', groups: [devs] }),
    ]) {
      expect(prompt).toContain('You cannot create tasks')
      for (const name of ['task_get', 'task_list', 'task_note', 'task_update_status', 'task_amend']) {
        expect(prompt).toContain(`\`mcp__kawai-team__${name}\``)
      }
      expect(prompt).toContain('add a journal note or message the creator')
      expect(prompt).toContain("that change's proposal, design, and tasks are the authoritative direction")
      expect(prompt).toContain('`done` or `cancelled` (the creator only)')
    }
  })
})
