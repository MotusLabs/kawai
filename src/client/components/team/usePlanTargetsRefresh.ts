// Keeps the New task form's plan pickers current (durable-plans D9/D12):
// while the form is open the Tasks view subscribes to the team's plan list,
// and every plan push after the first value re-requests the form's targets,
// so an approval (a new revision, a changed change list) or a closed plan
// reaches the pickers without reopening the form. The subscription ends
// when the form closes, the view unmounts, or the connection drops, and is
// re-sent on every reconnect (`connectionEpoch`), like the Plans tab's own.
import { useEffect, useRef } from 'react'
import type { SendClientMessage } from '@shared/types'
import { useTeamPlanStore } from '../../stores/teamPlanStore'

export function usePlanTargetsRefresh(teamPath: string, active: boolean, connected: boolean, connectionEpoch: number,
  sendMessage: SendClientMessage, refresh: () => void) {
  const plans = useTeamPlanStore(state => state.views[teamPath]?.plans)
  useEffect(() => {
    if (!active || !connected) return
    useTeamPlanStore.getState().open(teamPath)
    sendMessage({ type: 'team-plans-open', teamPath })
    return () => sendMessage({ type: 'team-plans-close', teamPath })
  }, [teamPath, active, connected, connectionEpoch, sendMessage])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const seen = useRef<typeof plans | undefined>(undefined)
  useEffect(() => {
    const previous = seen.current
    seen.current = plans
    if (!active || !connected || previous === undefined || previous === plans) return
    refreshRef.current()
  }, [plans, active, connected])
}
