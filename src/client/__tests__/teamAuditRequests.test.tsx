// The Audit tab's request effects (execution-safety-recovery D9;
// findings-1db27539 F1): the subscription's reconnect edge — an epoch bump
// or a connected toggle — sends exactly one fresh first page, a mount opens
// exactly once (connected or not), every keyed transition (a changed push,
// Apply, a selection) sends exactly one request, nothing is sent while
// disconnected, unmount closes once, and Load more sends the cursor with the
// committed filters. Every count is exact: a missing or doubled request fails.
import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import { useTeamAuditStore } from '../stores/teamAuditStore'
import { answerLatest, auditPage, auditRow, mountAudit, textOf } from './auditFixtures'

afterEach(() => { useTeamAuditStore.setState({ views: {} }) })

describe('mount', () => {
  test('a connected mount opens exactly once, begun in the store, with no call id', () => {
    const audit = mountAudit()
    expect(audit.opens()).toHaveLength(1)
    expect(audit.sent).toHaveLength(1)
    const open = audit.opens()[0]!
    expect(open).toEqual({ type: 'team-audit-open', teamPath: '/repo', requestId: open.requestId, filters: {} })
    expect(audit.view().pending).toEqual({ [open.requestId]: 'page' })
    audit.rerender()
    expect(audit.opens()).toHaveLength(1)
  })

  test('a mount while disconnected sends nothing; the first connect opens exactly once', () => {
    const audit = mountAudit({ connected: false })
    expect(audit.sent).toEqual([])
    audit.rerender({ connected: true })
    expect(audit.opens()).toHaveLength(1)
  })

  test('a new sendMessage identity on every render sends nothing (the fixture passes a fresh one)', () => {
    const audit = mountAudit()
    audit.sent.length = 0
    audit.rerender()
    audit.rerender()
    expect(audit.sent).toEqual([])
  })

  test('a request goes through the newest sendMessage, never a stale one', () => {
    const audit = mountAudit()
    const fresh: ClientMessage[] = []
    audit.rerender({ sink: fresh })
    audit.sent.length = 0
    audit.change(() => useTeamAuditStore.getState().applyChanged({ type: 'team-audit-changed', teamPath: '/repo', teamId: '/repo/.git' }))
    expect(audit.sent).toEqual([])
    expect(fresh.map(message => message.type)).toEqual(['team-audit-open'])
  })

  test('unmount closes exactly once', () => {
    const audit = mountAudit()
    act(() => audit.renderer.unmount())
    expect(audit.sent.filter(message => message.type === 'team-audit-close')).toEqual([{ type: 'team-audit-close', teamPath: '/repo' }])
  })
})

describe('the reconnect edge (F1)', () => {
  test('an epoch bump sends exactly one close and one fresh open', () => {
    const audit = mountAudit()
    answerLatest(audit.sent, [auditRow('a')])
    audit.sent.length = 0
    audit.rerender({ epoch: 1 })
    expect(audit.sent.map(message => message.type)).toEqual(['team-audit-close', 'team-audit-open'])
    audit.rerender()
    expect(audit.opens()).toHaveLength(1)
  })

  test('a connected false → true toggle with the same epoch sends exactly one open', () => {
    const audit = mountAudit()
    answerLatest(audit.sent, [auditRow('a')])
    audit.sent.length = 0
    audit.rerender({ connected: false })
    expect(audit.opens()).toHaveLength(0)
    audit.rerender({ connected: true })
    expect(audit.opens()).toHaveLength(1)
    audit.rerender()
    expect(audit.opens()).toHaveLength(1)
  })

  const reconnects = {
    'an epoch bump': (audit: ReturnType<typeof mountAudit>) => audit.rerender({ epoch: 1 }),
    'a connected toggle': (audit: ReturnType<typeof mountAudit>) => { audit.rerender({ connected: false }); audit.rerender({ connected: true }) },
  }
  for (const [name, reconnect] of Object.entries(reconnects)) {
    test(`${name} drops the lost requests: only the fresh page is pending`, () => {
      const audit = mountAudit()
      answerLatest(audit.sent, [auditRow('a')], 'cur-1')
      act(() => {
        useTeamAuditStore.getState().begin('/repo', 'ack-lost', 'acknowledge')
        useTeamAuditStore.getState().begin('/repo', 'more-lost', 'more')
      })
      audit.sent.length = 0
      reconnect(audit)
      expect(audit.opens()).toHaveLength(1)
      expect(audit.view().pending).toEqual({ [audit.opens()[0]!.requestId]: 'page' })
      expect(audit.view().loadingMore).toBe(false)
    })
  }

  test('the reconnect open carries the selected call; after Apply it carries none', () => {
    const audit = mountAudit()
    audit.change(() => useTeamAuditStore.getState().select('/repo', 'obc-1'))
    audit.sent.length = 0
    audit.rerender({ epoch: 1 })
    expect(audit.opens()).toHaveLength(1)
    expect(audit.opens()[0]!.callId).toBe('obc-1')
    audit.change(() => audit.byId('audit-apply-filters').props.onClick())
    audit.sent.length = 0
    audit.rerender({ connected: false })
    audit.rerender({ connected: true })
    expect(audit.opens()).toHaveLength(1)
    expect(audit.opens()[0]).not.toHaveProperty('callId')
  })
})

describe('a new team path (findings-a0769fc9 F1)', () => {
  const expectMoved = (audit: ReturnType<typeof mountAudit>, from: string, to: string) => {
    expect(audit.sent.map(message => ({ type: message.type, teamPath: (message as { teamPath: string }).teamPath }))).toEqual([
      { type: 'team-audit-close', teamPath: from }, { type: 'team-audit-open', teamPath: to },
    ])
    expect(audit.view().pending).toEqual({ [audit.opens()[0]!.requestId]: 'page' })
  }

  test('a rekeyed view closes the old path and opens the new one, exactly once each', () => {
    const audit = mountAudit({ teamPath: '/repo/wt' })
    answerLatest(audit.sent, [auditRow('a')])
    audit.sent.length = 0
    act(() => useTeamAuditStore.getState().rekey('/repo/wt', '/repo'))
    audit.rerender({ teamPath: '/repo' })
    expectMoved(audit, '/repo/wt', '/repo')
  })

  test("navigating to another team's open view closes this one and opens that one, exactly once each", () => {
    act(() => useTeamAuditStore.getState().open('/other'))
    const audit = mountAudit()
    answerLatest(audit.sent, [auditRow('a')])
    audit.sent.length = 0
    audit.rerender({ teamPath: '/other' })
    expectMoved(audit, '/repo', '/other')
  })
})

describe('keyed transitions', () => {
  test('a changed push, Apply, and a selection each send exactly one request', () => {
    const audit = mountAudit()
    audit.sent.length = 0
    audit.change(() => useTeamAuditStore.getState().applyChanged({ type: 'team-audit-changed', teamPath: '/repo', teamId: 't' }))
    expect(audit.opens()).toHaveLength(1)
    audit.change(() => audit.byLabel('Filter by rule').props.onChange({ target: { value: 'gh-write' } }))
    audit.change(() => audit.byId('audit-apply-filters').props.onClick())
    expect(audit.opens()).toHaveLength(2)
    expect(audit.opens()[1]!.filters).toEqual({ rule: 'gh-write' })
    audit.change(() => useTeamAuditStore.getState().select('/repo', 'obc-2'))
    expect(audit.opens()).toHaveLength(3)
    expect(audit.opens()[2]).toMatchObject({ callId: 'obc-2', filters: { rule: 'gh-write' } })
  })

  test('a group page adopting its applied filters requests nothing more', () => {
    const audit = mountAudit()
    audit.change(() => useTeamAuditStore.getState().select('/repo', 'obc-1'))
    const open = audit.opens().at(-1)!
    audit.sent.length = 0
    audit.change(() => useTeamAuditStore.getState().applyPage({
      ...auditPage([auditRow('a')], open.requestId, null), appliedFilters: { rule: 'gh-write', destination: 'github:other/repo' },
    }))
    expect(audit.view().filters).toEqual({ rule: 'gh-write', destination: 'github:other/repo' })
    expect(audit.sent).toEqual([])
  })

  test('nothing is requested while disconnected; the reconnect sends one open', () => {
    const audit = mountAudit()
    audit.rerender({ connected: false })
    audit.sent.length = 0
    audit.change(() => useTeamAuditStore.getState().applyChanged({ type: 'team-audit-changed', teamPath: '/repo', teamId: 't' }))
    expect(audit.sent).toEqual([])
    audit.rerender({ connected: true })
    expect(audit.opens()).toHaveLength(1)
  })
})

describe('Load more', () => {
  test('no cursor, no button', () => {
    const audit = mountAudit()
    answerLatest(audit.sent, [auditRow('a')], null)
    audit.rerender()
    expect(audit.allBy('audit-load-more')).toHaveLength(0)
  })

  test('it sends the cursor with the committed filters, begins a more, and disables while loading', () => {
    const audit = mountAudit()
    audit.change(() => useTeamAuditStore.getState().setFilters('/repo', { verdict: 'violation' }))
    answerLatest(audit.sent, [auditRow('a')], 'cur-1')
    audit.rerender()
    expect(audit.byId('audit-load-more').props.disabled).toBe(false)
    audit.sent.length = 0
    audit.change(() => audit.byId('audit-load-more').props.onClick())
    const more = audit.sent[0] as { requestId: string }
    expect(audit.sent).toEqual([{ type: 'team-audit-more', teamPath: '/repo', requestId: more.requestId, filters: { verdict: 'violation' }, cursor: 'cur-1' }])
    expect(audit.view().pending[more.requestId]).toBe('more')
    expect(audit.byId('audit-load-more').props.disabled).toBe(true)
    expect(textOf(audit.byId('audit-load-more'))).toBe('Loading…')
  })
})
