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

  test('a session without a group gets the mailbox note only', () => {
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
})
