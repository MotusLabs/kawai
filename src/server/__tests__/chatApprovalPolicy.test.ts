// decideApproval is the single decision point for who answers a chat tool
// approval (chat-auto-approve-tools design D1): manual asks, auto allows,
// and AskUserQuestion always asks.
import { describe, expect, test } from 'bun:test'
import { decideApproval, parseApprovalPolicy } from '../chat/approvalPolicy'

describe('decideApproval', () => {
  test('manual asks for every tool', () => {
    expect(decideApproval('manual', 'Bash')).toBe('ask')
    expect(decideApproval('manual', 'Write')).toBe('ask')
    expect(decideApproval('manual', 'AskUserQuestion')).toBe('ask')
  })

  test('auto allows ordinary tools', () => {
    expect(decideApproval('auto', 'Bash')).toBe('allow')
    expect(decideApproval('auto', 'Write')).toBe('allow')
    expect(decideApproval('auto', 'WebFetch')).toBe('allow')
  })

  test('auto still asks for agent questions', () => {
    expect(decideApproval('auto', 'AskUserQuestion')).toBe('ask')
  })
})

describe('parseApprovalPolicy', () => {
  test('reads known values and defaults everything else to manual', () => {
    expect(parseApprovalPolicy('manual')).toBe('manual')
    expect(parseApprovalPolicy('auto')).toBe('auto')
    expect(parseApprovalPolicy(undefined)).toBe('manual')
    expect(parseApprovalPolicy(null)).toBe('manual')
    expect(parseApprovalPolicy('yolo')).toBe('manual')
    expect(parseApprovalPolicy(42)).toBe('manual')
  })
})
