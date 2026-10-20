// Stall-alert schema (plan-supervision design D3, D11), part of the numbered
// migration `plan-supervision` that `decisions/decisionSchema.ts` registers.
// One row per stall episode: `UNIQUE (execution_id, change, kind,
// episode_key)` keeps each episode to one alert across restarts. A row with a
// null `message_id` records a stall of a plan without a Lead role, for which
// no mail is sent. Additive, no backfill. Pure DDL: no policy, no writes.

export const CREATE_SUPERVISION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_stall_alerts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  change TEXT NOT NULL,
  kind TEXT NOT NULL,
  episode_key TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  message_id TEXT,
  raised_at TEXT NOT NULL,
  UNIQUE (execution_id, change, kind, episode_key)
);
CREATE INDEX IF NOT EXISTS plan_stall_alerts_plan ON plan_stall_alerts(plan_id, raised_at);
CREATE INDEX IF NOT EXISTS plan_stall_alerts_team ON plan_stall_alerts(team_id, raised_at);
`
