// Fixed statements compiled once when a mailbox store opens.
export const mailboxSql = {
  enqueue: `INSERT INTO team_messages
      (id, team_id, to_kind, to_id, from_session, from_group, origin_path, priority, tags,
       thread_id, in_reply_to, hop, body, state, deliver_at, created_at, reason, attach_thread, task_id)
      VALUES ($id, $teamId, $toKind, $toId, $fromSession, $fromGroup, $originPath, $priority, $tags,
       $threadId, $inReplyTo, $hop, $body, $state, $deliverAt, $createdAt, $reason, $attachThread, $taskId)`,
  get: 'SELECT * FROM team_messages WHERE id = $id',
  nextEligible: `SELECT * FROM team_messages
      WHERE team_id = $teamId AND state = 'queued'
        AND (deliver_at IS NULL OR deliver_at <= $now)
        AND ((to_kind = 'session' AND to_id = $sessionId)
          OR (to_kind = 'group' AND $groupId IS NOT NULL AND to_id = $groupId))
      ORDER BY (priority = 'urgent') DESC, (to_kind = 'session') DESC, created_at, rowid
      LIMIT 1`,
  claim: `UPDATE team_messages SET state = 'claimed', claimed_by = $sessionId, claimed_at = $now
      WHERE id = $id AND state IN ('queued', 'awaiting-request')`,
  markPushed: `UPDATE team_messages SET pushed_at = $now
      WHERE id = $id AND state = 'claimed'`,
  markDelivered: `UPDATE team_messages SET state = 'delivered', delivered_at = $now
      WHERE id = $id AND state IN ('claimed', 'uncertain')`,
  directIds: "SELECT id FROM team_messages WHERE to_kind = 'session' AND to_id = $sessionId AND state IN ('queued', 'awaiting-request')",
  deadLetterDirectTo: `UPDATE team_messages SET state = 'dead', reason = $reason
      WHERE to_kind = 'session' AND to_id = $sessionId AND state IN ('queued', 'awaiting-request')`,
  teamsWithQueuedMail: `SELECT DISTINCT team_id FROM team_messages
      WHERE state = 'queued' AND (deliver_at IS NULL OR deliver_at <= $now)`,
  nextDueAt: `SELECT MIN(deliver_at) AS due FROM team_messages
      WHERE state = 'queued' AND deliver_at > $now`,
  urgentDirectFor: `SELECT * FROM team_messages
      WHERE to_kind = 'session' AND to_id = $sessionId AND state = 'queued'
        AND priority = 'urgent' AND (deliver_at IS NULL OR deliver_at <= $now)
      ORDER BY created_at, rowid`,
  claimsFor: `SELECT * FROM team_messages
      WHERE claimed_by = $sessionId AND state = 'claimed'
      ORDER BY created_at, rowid`,
} as const
