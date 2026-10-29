// The dormant recognition and classifier helper against the landed literal
// policy rows (tool-call-metrics D4/D6: TN1–TN6, A1, A3, FC1–FC10). Recognition
// and classification only: no slots, streaks, or live recording are claimed.
import { describe, expect, test } from 'bun:test'
import {
  BUILT_IN_TOOLS,
  PUBLIC_BUILT_IN_LABELS,
  TEAM_TOOL_PREFIX,
  classifyToolResult,
  recognizeTool,
  type BuiltInTool,
  type TeamCatalogue,
  type TrustedDenial,
} from '../metrics/observations/toolCalls'

// Synthetic fixture members, not a copy of the production catalogue.
// `task_journal_read` is a FUTURE member: absent from today's catalogue, it is
// recognized here only because this fixture injects it.
const catalogue: TeamCatalogue = {
  prefix: TEAM_TOOL_PREFIX,
  members: new Set([
    'mcp__kawai-team__task_submit_result',
    'mcp__kawai-team__task_get',
    'mcp__kawai-team__task_journal_read',
    'mcp__kawai-team__fixture__multi__sep',
    'mcp__other-team__task_get',
  ]),
}
const noMembers: TeamCatalogue = { prefix: TEAM_TOOL_PREFIX, members: new Set() }

function failedResult(tool: string, output: string, trustedDenial: TrustedDenial = 'not-supplied') {
  return classifyToolResult({ failed: true, trustedDenial, tool: recognizeTool(tool, catalogue), output })
}

// The agreed closed vocabularies, written out here rather than read from the
// helper, so a substituted, dropped, or duplicated name in either helper array
// fails. Order is not part of the contract.
const EXPECTED_BUILT_INS = [
  'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'EnterWorktree', 'ExitPlanMode', 'Glob', 'Grep',
  'Monitor', 'MultiEdit', 'NotebookEdit', 'Read', 'Skill', 'Task', 'TaskCreate', 'TaskOutput',
  'TaskStop', 'TaskUpdate', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
]
const EXPECTED_PUBLIC_LABELS = [
  'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Monitor',
  'MultiEdit', 'NotebookEdit', 'Read', 'Skill', 'Task', 'TaskOutput', 'ToolSearch', 'WebFetch',
  'WebSearch', 'Write',
]

function expectExactVocabulary(actual: readonly string[], expected: readonly string[], size: number) {
  expect(expected).toHaveLength(size)
  expect(new Set(expected).size).toBe(size)
  expect(actual).toHaveLength(size)
  expect(new Set(actual).size).toBe(size)
  expect([...actual].sort()).toStrictEqual([...expected].sort())
}

describe('recognition', () => {
  test('TN1: every supported built-in keeps its own name; Agent and Task stay distinct', () => {
    expect(recognizeTool('Bash', catalogue)).toStrictEqual({ kind: 'builtin', name: 'Bash' })
    expect(recognizeTool('Agent', catalogue)).toStrictEqual({ kind: 'builtin', name: 'Agent' })
    expect(recognizeTool('Task', catalogue)).toStrictEqual({ kind: 'builtin', name: 'Task' })
    expectExactVocabulary(BUILT_IN_TOOLS, EXPECTED_BUILT_INS, 22)
    for (const name of EXPECTED_BUILT_INS) {
      expect(recognizeTool(name, noMembers)).toStrictEqual({ kind: 'builtin', name: name as BuiltInTool })
    }
  })

  test('an unapproved CLI tool name is foreign, not a built-in', () => {
    expect(recognizeTool('TodoWrite', noMembers)).toStrictEqual({ kind: 'foreign', label: 'other' })
  })

  test('the 18 public labels are exactly the agreed set, with no duplicates', () => {
    expectExactVocabulary(PUBLIC_BUILT_IN_LABELS, EXPECTED_PUBLIC_LABELS, 18)
    expect(EXPECTED_BUILT_INS.filter(name => !EXPECTED_PUBLIC_LABELS.includes(name)).sort())
      .toStrictEqual(['EnterWorktree', 'TaskCreate', 'TaskStop', 'TaskUpdate'])
  })

  test('the four built-ins beyond the 18 public labels are built-in identities, not foreign', () => {
    expect(PUBLIC_BUILT_IN_LABELS).toHaveLength(18)
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskStop', 'EnterWorktree'] as const) {
      expect(recognizeTool(name, catalogue)).toStrictEqual({ kind: 'builtin', name })
      expect(PUBLIC_BUILT_IN_LABELS as readonly string[]).not.toContain(name)
    }
    for (const label of PUBLIC_BUILT_IN_LABELS) expect(BUILT_IN_TOOLS as readonly string[]).toContain(label)
  })

  test('TN2/TN3: an exact full-prefixed member is its suffix in both runtimes, never double-wrapped', () => {
    // Claude names it directly; Codex builds the same string as mcp__<namespace>__<tool>.
    expect(recognizeTool('mcp__kawai-team__task_submit_result', catalogue)).toStrictEqual({ kind: 'team', name: 'task_submit_result' })
    expect(recognizeTool('mcp__kawai-team__task_get', catalogue)).toStrictEqual({ kind: 'team', name: 'task_get' })
    expect(TEAM_TOOL_PREFIX).toBe('mcp__kawai-team__')
  })

  test('an injected future member is recognized only through the catalogue it comes from', () => {
    expect(recognizeTool('mcp__kawai-team__task_journal_read', catalogue)).toStrictEqual({ kind: 'team', name: 'task_journal_read' })
    expect(recognizeTool('mcp__kawai-team__task_journal_read', noMembers)).toStrictEqual({ kind: 'foreign', label: 'other' })
  })

  test('TN4: the team prefix without membership is foreign with label other', () => {
    expect(recognizeTool('mcp__kawai-team__not_a_tool', catalogue)).toStrictEqual({ kind: 'foreign', label: 'other' })
  })

  test('a set member under another prefix, or a catalogue with the wrong prefix, never becomes team', () => {
    expect(recognizeTool('mcp__other-team__task_get', catalogue)).toStrictEqual({ kind: 'foreign', label: 'mcp:other' })
    // Outside the type contract on purpose: a catalogue whose prefix is not the full literal.
    for (const prefix of ['', 'mcp__']) {
      const members = new Set(['mcp__docs-search__query', 'mcp__kawai-team__task_get'])
      const wrongPrefix = { prefix, members } as unknown as TeamCatalogue
      expect(recognizeTool('mcp__docs-search__query', wrongPrefix)).toStrictEqual({ kind: 'foreign', label: 'mcp:other' })
      expect(recognizeTool('mcp__kawai-team__task_get', wrongPrefix)).toStrictEqual({ kind: 'foreign', label: 'other' })
    }
  })

  test('TN5: another MCP server tool is foreign with label mcp:other', () => {
    expect(recognizeTool('mcp__docs-search__query', catalogue)).toStrictEqual({ kind: 'foreign', label: 'mcp:other' })
  })

  test('TN6 and A1: bare echo, the dynamic namespace, collapsed placeholders and empty names are unknown', () => {
    expect(recognizeTool('echo', catalogue)).toStrictEqual({ kind: 'unknown', reason: 'ambiguous', label: 'other' })
    expect(recognizeTool('mcp__dynamic__echo', catalogue)).toStrictEqual({ kind: 'unknown', reason: 'ambiguous', label: 'mcp:other' })
    expect(recognizeTool('mcp__dynamic__task_submit_result', catalogue)).toStrictEqual({ kind: 'unknown', reason: 'ambiguous', label: 'mcp:other' })
    for (const name of ['collabAgentToolCall', 'subAgentActivity', '']) {
      expect(recognizeTool(name, catalogue)).toStrictEqual({ kind: 'unknown', reason: 'ambiguous', label: 'other' })
    }
  })

  test('separators: two extra in an MCP name, or two in another name, are ambiguous', () => {
    const foreignMcp = { kind: 'foreign', label: 'mcp:other' } as const
    const unknownMcp = { kind: 'unknown', reason: 'ambiguous', label: 'mcp:other' } as const
    expect(recognizeTool('mcp__srv__tool', catalogue)).toStrictEqual(foreignMcp)
    expect(recognizeTool('mcp__srv__tool__x', catalogue)).toStrictEqual(foreignMcp)
    expect(recognizeTool('mcp__srv__tool__x__y', catalogue)).toStrictEqual(unknownMcp)
    expect(recognizeTool('a__b', catalogue)).toStrictEqual({ kind: 'foreign', label: 'other' })
    expect(recognizeTool('a__b__c', catalogue)).toStrictEqual({ kind: 'unknown', reason: 'ambiguous', label: 'other' })
    // Adjacent underscores count as non-overlapping pairs: 4, 6 and 8 make 2, 3 and 4.
    expect(recognizeTool('mcp____tool', catalogue)).toStrictEqual(foreignMcp)
    expect(recognizeTool('mcp______tool', catalogue)).toStrictEqual(foreignMcp)
    expect(recognizeTool('mcp________tool', catalogue)).toStrictEqual(unknownMcp)
    expect(recognizeTool('mcp__kawai-team__x__y__z', catalogue)).toStrictEqual({ kind: 'unknown', reason: 'ambiguous', label: 'other' })
  })

  test('an exact trusted member wins over the separator rule (synthetic fixture member)', () => {
    expect(recognizeTool('mcp__kawai-team__fixture__multi__sep', catalogue)).toStrictEqual({ kind: 'team', name: 'fixture__multi__sep' })
  })

  test('a foreign or unknown name never appears in the result', () => {
    const canary = 'secret_canary_private_tool'
    for (const raw of [`mcp__${canary}__x`, `mcp__kawai-team__${canary}`, `mcp__dynamic__${canary}`, `${canary}__a__b`, canary]) {
      const result = recognizeTool(raw, catalogue)
      expect(['foreign', 'unknown']).toContain(result.kind)
      expect(JSON.stringify(result)).not.toContain(canary)
      expect(Object.keys(result).join()).not.toContain(canary)
    }
  })
})

describe('classification', () => {
  test('FC1: a trusted denial on a failed result is denied, ahead of any matching prefix', () => {
    expect(failedResult('mcp__docs-search__query', 'something odd', 'denied')).toStrictEqual({ outcome: 'failed', failureClass: 'denied', rule: 'K1' })
    expect(failedResult('mcp__kawai-team__task_get', 'Input validation error: x', 'denied')).toStrictEqual({ outcome: 'failed', failureClass: 'denied', rule: 'K1' })
  })

  test('FC10: a success is only a success, whatever its text or denial', () => {
    for (const trustedDenial of ['denied', 'not-supplied'] as const) {
      const result = classifyToolResult({
        failed: false,
        trustedDenial,
        tool: recognizeTool('mcp__kawai-team__task_get', catalogue),
        output: 'Input validation error: x',
      })
      expect(result).toStrictEqual({ outcome: 'success' })
      expect('failureClass' in result).toBe(false)
    }
  })

  test('FC2: an anchored, untrimmed "Input validation error:" is input-invalid', () => {
    const team = 'mcp__kawai-team__task_submit_result'
    expect(failedResult(team, 'Input validation error: Invalid arguments for tool task_submit_result: x')).toStrictEqual({ outcome: 'failed', failureClass: 'input-invalid', rule: 'K2' })
    expect(failedResult(team, 'Input validation error x')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
    expect(failedResult(team, ' Input validation error: x')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
  })

  test('FC3 and FC4: invalid arguments and blocked wrappers', () => {
    expect(failedResult('mcp__kawai-team__task_get', 'Invalid arguments for task_get: x')).toStrictEqual({ outcome: 'failed', failureClass: 'input-invalid', rule: 'K3' })
    expect(failedResult('Read', '<tool_use_error>Blocked: x')).toStrictEqual({ outcome: 'failed', failureClass: 'blocked', rule: 'K5' })
  })

  test('K4: the missing-team-tool text is unavailable for a non-member name', () => {
    expect(failedResult('mcp__kawai-team__not_a_tool', 'Unknown kawai-team tool: not_a_tool')).toStrictEqual({ outcome: 'failed', failureClass: 'unavailable', rule: 'K4' })
  })

  test('FC5: unknown skill, no such tool, and removed references are unavailable', () => {
    expect(failedResult('Skill', '<tool_use_error>Unknown skill: x')).toStrictEqual({ outcome: 'failed', failureClass: 'unavailable', rule: 'K6' })
    expect(failedResult('Read', '<tool_use_error>Error: No such tool available: x')).toStrictEqual({ outcome: 'failed', failureClass: 'unavailable', rule: 'K7' })
    expect(failedResult('ToolSearch', 'Tool references removed: x')).toStrictEqual({ outcome: 'failed', failureClass: 'unavailable', rule: 'K8' })
    expect(failedResult('Read', 'No such tool available')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
    expect(failedResult('Bash', 'No such tool available')).toStrictEqual({ outcome: 'failed', failureClass: 'command-failed', rule: 'K13' })
  })

  test('K7 needs the whole phrase within the first 256 characters', () => {
    const wrapper = '<tool_use_error>'
    const phrase = 'No such tool available'
    expect([wrapper.length, phrase.length]).toEqual([16, 22])
    const ends256 = wrapper + 'a'.repeat(218) + phrase
    const ends257 = wrapper + 'a'.repeat(219) + phrase
    expect([ends256.length, ends257.length]).toEqual([256, 257])
    expect(failedResult('Read', ends256)).toStrictEqual({ outcome: 'failed', failureClass: 'unavailable', rule: 'K7' })
    expect(failedResult('Read', ends257)).toStrictEqual({ outcome: 'failed', failureClass: 'precondition', rule: 'K9' })
  })

  test('FC6: any other tool_use_error wrapper is precondition', () => {
    expect(failedResult('Read', '<tool_use_error>InputValidationError: x')).toStrictEqual({ outcome: 'failed', failureClass: 'precondition', rule: 'K9' })
    expect(failedResult('Bash', '<tool_use_error>File has not been read yet')).toStrictEqual({ outcome: 'failed', failureClass: 'precondition', rule: 'K9' })
  })

  test('FC7: only an exact team tool saying "Refused: " is refused', () => {
    expect(failedResult('mcp__kawai-team__task_get', 'Refused: not yours')).toStrictEqual({ outcome: 'failed', failureClass: 'refused', rule: 'K10' })
    expect(failedResult('mcp__kawai-team__task_get', 'Unknown team: t1')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
    expect(failedResult('mcp__docs-search__query', 'Refused: not yours')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
    expect(failedResult('mcp__kawai-team__not_a_tool', 'Refused: not yours')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
  })

  test('FC8: Bash declined is denied; other Bash failures are command-failed', () => {
    expect(failedResult('Bash', 'The command was declined.')).toStrictEqual({ outcome: 'failed', failureClass: 'denied', rule: 'K11' })
    expect(failedResult('Bash', 'exit 1')).toStrictEqual({ outcome: 'failed', failureClass: 'command-failed', rule: 'K13' })
    expect(failedResult('Bash', '')).toStrictEqual({ outcome: 'failed', failureClass: 'command-failed', rule: 'K13' })
  })

  test('K11 is Bash-only: Monitor declined is command-failed', () => {
    expect(failedResult('Monitor', 'The command was declined.')).toStrictEqual({ outcome: 'failed', failureClass: 'command-failed', rule: 'K13' })
  })

  test('FC9 and A3: Edit declined is denied; Write and MultiEdit declined stay other', () => {
    expect(failedResult('Edit', 'The file change declined.')).toStrictEqual({ outcome: 'failed', failureClass: 'denied', rule: 'K12' })
    expect(failedResult('Write', 'The file change declined.')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
    expect(failedResult('MultiEdit', 'The file change declined.')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
    expect(failedResult('Edit', 'The file change failed.')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
  })

  test('empty or unrecognized output falls back by tool', () => {
    expect(failedResult('Monitor', '')).toStrictEqual({ outcome: 'failed', failureClass: 'command-failed', rule: 'K13' })
    expect(failedResult('Read', '')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
    expect(failedResult('echo', 'boom')).toStrictEqual({ outcome: 'failed', failureClass: 'other', rule: 'K14' })
  })

  test('output text never appears in a classification', () => {
    const canary = 'secret_output_canary'
    const outputs = [canary, `Input validation error: ${canary}`, `<tool_use_error>${canary}`, `Refused: ${canary}`, `The command was declined. ${canary}`]
    for (const tool of ['Bash', 'Read', 'mcp__kawai-team__task_get', 'mcp__docs-search__query']) {
      for (const output of outputs) {
        for (const failed of [true, false]) {
          const result = classifyToolResult({ failed, trustedDenial: 'not-supplied', tool: recognizeTool(tool, catalogue), output })
          expect(JSON.stringify(result)).not.toContain(canary)
        }
      }
    }
  })
})
