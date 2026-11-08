/** Match web ordering expressions, including legacy epoch seconds. Keep these
 * mirrored in drizzle-schema and the managed SQL migration. Invocation status
 * columns are added by earlier repairs, so install these after those repairs. */
export const WEB_READ_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_messages_epoch_id ON messages (CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_failure_epoch_id ON deliveries (CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC, id) WHERE status IN ('failed', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_dispatches_epoch_id ON scout_dispatches (CASE WHEN dispatched_at IS NULL THEN NULL WHEN CAST(dispatched_at AS REAL) < 1000000000000 THEN CAST(CAST(dispatched_at AS REAL) * 1000 AS INTEGER) ELSE CAST(dispatched_at AS INTEGER) END DESC, id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_epoch_id ON delivery_attempts (CASE WHEN created_at IS NULL THEN NULL WHEN CAST(created_at AS REAL) < 1000000000000 THEN CAST(CAST(created_at AS REAL) * 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END DESC, id);
CREATE INDEX IF NOT EXISTS idx_activity_items_epoch ON activity_items (CASE WHEN ts IS NULL THEN NULL WHEN CAST(ts AS REAL) < 1000000000000 THEN CAST(CAST(ts AS REAL) * 1000 AS INTEGER) ELSE CAST(ts AS INTEGER) END DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_state ON invocations (state);
CREATE INDEX IF NOT EXISTS idx_invocations_requester_recency ON invocations (requester_id, COALESCE(completed_at, started_at, created_at) DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_completed_recovery ON invocations (target_agent_id, COALESCE(conversation_id, ''), COALESCE(completed_at, started_at, 0) DESC) WHERE state = 'completed';
`;
