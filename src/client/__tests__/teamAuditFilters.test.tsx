// The Audit tab's filters (execution-safety-recovery D9; findings-1db27539
// F2): every field's edit reaches the one committed request, the date inputs
// speak the viewer's local zone — From is that day's local midnight, To the
// exclusive local midnight after the chosen day, each displayed as the day
// chosen — and every control disables while disconnected. The suite pins
// TZ=America/New_York, where local and UTC days differ, and restores it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useTeamAuditStore } from '../stores/teamAuditStore'
import { answerLatest, auditRow, mountAudit } from './auditFixtures'

const realZone = process.env.TZ
beforeEach(() => { process.env.TZ = 'America/New_York' })
afterEach(() => {
  process.env.TZ = realZone
  useTeamAuditStore.setState({ views: {} })
})

describe('the committed filters', () => {
  test('every field reaches the one Apply request, with local-day bounds', () => {
    const audit = mountAudit()
    const edit = (label: string, value: string) => audit.change(() => audit.byLabel(label).props.onChange({ target: { value } }))
    edit('Filter by verdict', 'violation')
    edit('Filter by rule', 'gh-write')
    edit('Filter by destination', 'github:other/repo')
    edit('Filter by session', 'chat-9')
    edit('From date', '2026-01-15')
    edit('To date', '2026-01-15')
    // The inputs read back the chosen days, not the stored bounds.
    expect(audit.byLabel('From date').props.value).toBe('2026-01-15')
    expect(audit.byLabel('To date').props.value).toBe('2026-01-15')
    audit.sent.length = 0
    audit.change(() => audit.byId('audit-apply-filters').props.onClick())
    expect(audit.opens()).toHaveLength(1)
    // New York midnight is 05:00Z: From is the 15th's, To the 16th's (exclusive).
    expect(audit.opens()[0]!.filters).toEqual({
      verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo', sessionId: 'chat-9',
      from: '2026-01-15T05:00:00.000Z', to: '2026-01-16T05:00:00.000Z',
    })
    expect(useTeamAuditStore.getState().views['/repo']!.filters).toEqual(audit.opens()[0]!.filters)
  })

  test('stored bounds display as local days: From its own day, To the day before the bound', () => {
    // 03:00Z on the 16th is still the 15th in New York (UTC prefix: the 16th).
    useTeamAuditStore.getState().open('/repo')
    useTeamAuditStore.getState().setFilters('/repo', { from: '2026-01-16T03:00:00.000Z', to: '2026-01-17T05:00:00.000Z' })
    const audit = mountAudit()
    expect(audit.byLabel('From date').props.value).toBe('2026-01-15')
    expect(audit.byLabel('To date').props.value).toBe('2026-01-16')
  })

  test('clearing a field drops it from the request', () => {
    const audit = mountAudit()
    audit.change(() => audit.byLabel('Filter by rule').props.onChange({ target: { value: 'gh-write' } }))
    audit.change(() => audit.byLabel('Filter by rule').props.onChange({ target: { value: '' } }))
    audit.change(() => audit.byLabel('To date').props.onChange({ target: { value: '' } }))
    audit.sent.length = 0
    audit.change(() => audit.byId('audit-apply-filters').props.onClick())
    expect(audit.opens()[0]!.filters).toEqual({})
  })

  test('a 23 h DST day round-trips: To shows the chosen day and Apply sends its next midnight (findings-11730e60)', () => {
    const audit = mountAudit()
    audit.change(() => audit.byLabel('To date').props.onChange({ target: { value: '2026-03-08' } }))
    expect(audit.byLabel('To date').props.value).toBe('2026-03-08')
    audit.sent.length = 0
    audit.change(() => audit.byId('audit-apply-filters').props.onClick())
    // 2026-03-09 midnight in New York is EDT (UTC−4): 04:00Z.
    expect(audit.opens()[0]!.filters).toEqual({ to: '2026-03-09T04:00:00.000Z' })
    expect(audit.byLabel('To date').props.value).toBe('2026-03-08')
  })
})

describe('disconnected', () => {
  test('every filter, row, and dialog control disables; connected they are enabled', () => {
    const audit = mountAudit()
    answerLatest(audit.sent, [auditRow('v', { verdict: 'violation' })], 'cur-1')
    audit.rerender()
    audit.change(() => audit.byId('audit-acknowledge').props.onClick())
    const controls = () => [
      audit.byLabel('Filter by verdict'), audit.byLabel('Filter by rule'), audit.byLabel('Filter by destination'),
      audit.byLabel('Filter by session'), audit.byLabel('From date'), audit.byLabel('To date'),
      audit.byId('audit-apply-filters'), audit.byId('audit-load-more'), audit.byId('audit-acknowledge'),
      audit.byLabel('Acknowledgement note'), audit.byId('audit-ack-confirm'),
    ].map(node => node.props.disabled)
    expect(controls()).toEqual(Array(11).fill(false))
    audit.rerender({ connected: false })
    expect(controls()).toEqual(Array(11).fill(true))
  })
})
