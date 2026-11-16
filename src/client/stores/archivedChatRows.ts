// Archive HTTP work is connection-local. Later socket mutations always win.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { Session } from '@shared/types'
import { useSessionStore, selectSessionById } from './sessionStore'
import { useWorkspaceStore } from './workspaceStore'
import { FALLBACK_ARCHIVE_SECTION_KEY } from '@shared/workspace'

type RowStatus = 'pending' | 'unknown' | 'error'
interface ArchiveRowsState {
  epoch: number
  generation: number
  status: Record<string, RowStatus>
  loading: boolean
  pageLoaded: boolean
  nextCursor: string | null
  error: string | null
}
export const useArchiveRowsStore = create<ArchiveRowsState>(() => ({
  epoch: -1, generation: 0, status: {}, loading: false, pageLoaded: false,
  nextCursor: null, error: null,
}))
let sequence = 0
const mutations = new Map<string, number>()
const cursors = new Set<string>()
const queued = new Set<string>()
const pendingKills = new Set<string>()
export function blockSessionRow(id: string): void { pendingKills.add(id); noteSessionMutation(id) }
export function unblockSessionRow(id: string): void { pendingKills.delete(id) }
let scheduled = false
function stamp() { return { generation: useArchiveRowsStore.getState().generation, sequence } }
function current(id: string, pin: ReturnType<typeof stamp>): boolean {
  return pin.generation === useArchiveRowsStore.getState().generation && (mutations.get(id) ?? 0) <= pin.sequence
}
export function noteSessionMutation(id: string): void {
  mutations.set(id, ++sequence)
  queued.delete(id)
  useArchiveRowsStore.setState(state => {
    const status = { ...state.status }; delete status[id]
    return { status }
  })
}
export function beginArchiveConnection(epoch: number): boolean {
  const state = useArchiveRowsStore.getState()
  if (state.epoch === epoch) return false
  mutations.clear(); pendingKills.clear(); cursors.clear(); queued.clear(); scheduled = false
  useSessionStore.setState({ archivedChats: new Map() })
  useArchiveRowsStore.setState({ epoch, generation: state.generation + 1, status: {},
    loading: false, pageLoaded: false, nextCursor: null, error: null })
  return true
}
export function refreshExpandedArchive(): void {
  if (!useWorkspaceStore.getState().isSectionCollapsed(FALLBACK_ARCHIVE_SECTION_KEY)) void loadArchivePage()
}
export function mergeArchiveRows(rows: Session[], unknown: string[], pin = stamp()): void {
  const state = useSessionStore.getState()
  const live = [...state.sessions]
  const archivedChats = new Map(state.archivedChats)
  const status = { ...useArchiveRowsStore.getState().status }
  for (const row of rows) {
    if (!current(row.id, pin) || pendingKills.has(row.id)) continue
    delete status[row.id]
    if (live.some(held => held.id === row.id)) continue
    if (!row.archivedAt) { archivedChats.delete(row.id); live.push(row); continue }
    const held = archivedChats.get(row.id)
    if (!held?.archivedAt || held.archivedAt <= row.archivedAt) archivedChats.set(row.id, row)
  }
  for (const id of unknown) {
    if (!current(id, pin) || pendingKills.has(id)) continue
    if (live.some(row => row.id === id) || archivedChats.has(id)) continue
    status[id] = 'unknown'
  }
  useSessionStore.setState({ sessions: live, archivedChats })
  useArchiveRowsStore.setState({ status })
}
export async function loadArchivePage(): Promise<void> {
  const state = useArchiveRowsStore.getState()
  if (state.loading || (state.pageLoaded && state.nextCursor === null)) return
  const cursor = state.nextCursor
  const key = cursor ?? ''
  if (cursors.has(key)) return
  cursors.add(key)
  const pin = stamp()
  useArchiveRowsStore.setState({ loading: true, error: null })
  try {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor) query.set('before', cursor)
    const response = await fetch(`/api/chat/sessions/archived?${query}`)
    if (!response.ok) throw new Error('Could not load archived chats.')
    const page = await response.json() as { rows: Session[]; nextCursor: string | null; archivedCount: number }
    if (pin.generation !== useArchiveRowsStore.getState().generation) return
    mergeArchiveRows(page.rows, [], pin)
    // Only socket summaries own the count; an HTTP count may already be stale.
    useArchiveRowsStore.setState({ loading: false, pageLoaded: true, nextCursor: page.nextCursor })
  } catch (error) {
    if (pin.generation !== useArchiveRowsStore.getState().generation) return
    cursors.delete(key)
    useArchiveRowsStore.setState({ loading: false, error: String(error) })
  }
}
export function requestSessionRows(ids: string[]): void {
  const state = useSessionStore.getState()
  const status = { ...useArchiveRowsStore.getState().status }
  for (const id of ids) {
    if (!id || pendingKills.has(id) || selectSessionById(state, id) || status[id]) continue
    queued.add(id); status[id] = 'pending'
  }
  useArchiveRowsStore.setState({ status })
  if (scheduled || !queued.size) return
  scheduled = true
  const generation = useArchiveRowsStore.getState().generation
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: FrameRequestCallback) => setTimeout(fn, 0)
  schedule(() => {
    if (generation !== useArchiveRowsStore.getState().generation) return
    scheduled = false
    const all = [...queued]; queued.clear()
    for (let i = 0; i < all.length; i += 100) void fetchRows(all.slice(i, i + 100))
  })
}
async function fetchRows(ids: string[]): Promise<void> {
  const pin = stamp()
  try {
    const response = await fetch(`/api/chat/sessions/rows?${new URLSearchParams({ ids: ids.join(',') })}`)
    if (!response.ok) throw new Error('Could not resolve chat rows.')
    const reply = await response.json() as { rows: Session[]; unknown: string[] }
    if (pin.generation !== useArchiveRowsStore.getState().generation) return
    mergeArchiveRows(reply.rows, reply.unknown, pin)
  } catch {
    const status = { ...useArchiveRowsStore.getState().status }
    for (const id of ids) if (current(id, pin)) status[id] = 'error'
    useArchiveRowsStore.setState({ status })
  }
}
export function useSessionRow(id: string | null | undefined, fallback?: Session): Session | undefined {
  const cached = useSessionStore(state => id ? selectSessionById(state, id) : undefined)
  const row = cached ?? fallback
  const generation = useArchiveRowsStore(state => state.generation)
  const status = useArchiveRowsStore(state => id ? state.status[id] : undefined)
  useEffect(() => { if (id && !row && !status) requestSessionRows([id]) }, [id, row, status, generation])
  return row
}
