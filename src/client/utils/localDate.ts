// Local-calendar-day helpers for the Audit tab's date inputs
// (execution-safety-recovery findings-0f39baed L3): the owner thinks in
// local days, so the inputs display and parse the view's local zone —
// never the UTC day an ISO stamp's prefix happens to name.

/** The local calendar day (YYYY-MM-DD) an ISO stamp falls on. */
export function localDayOf(stamp: string): string {
  const date = new Date(stamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * The day the To input displays: the store's bound is the exclusive end
 * (local midnight after the chosen day), so the owner sees that day — the
 * bound minus one.
 */
export function toDisplayDay(bound: string): string {
  return localDayOf(new Date(new Date(bound).getTime() - 24 * 60 * 60 * 1000).toISOString())
}

/** Local midnight of a YYYY-MM-DD, offset by whole days, as an ISO stamp. */
export function localDayStart(day: string, dayOffset = 0): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year!, (month! - 1), date! + dayOffset).toISOString()
}
