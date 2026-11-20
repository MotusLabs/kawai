import { expect, test } from 'bun:test'
import { createMessageRouter, type MessageRouterDeps } from '../protocol/messageRouter'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'

test('H8: the production router delivers repository binding pushes without an open plan', () => {
  useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
  const binding = { role: 'architect' as const, sessionId: 'image-chat', version: 1, availability: 'live' as const, name: 'Image chat' }
  // This message branch needs no router callbacks. The test deliberately
  // enters through the same dispatcher the app subscribes to, not the leaf.
  createMessageRouter({} as MessageRouterDeps)({
    type: 'team-plan-workspace-bindings', teamPath: '/image-project', teamId: 'image-team', bindings: [binding],
  })
  expect(useTeamPlanWorkspaceStore.getState().teamBindings['/image-project']).toEqual([binding])
  useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
})
