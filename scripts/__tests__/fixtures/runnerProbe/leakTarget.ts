// The module mockLeakA mocks: mockLeakB must observe the real export —
// per-file isolation (review F2) gives each file its own module registry.
export const leakProbeValue = 'real'
