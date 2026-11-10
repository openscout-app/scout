CREATE INDEX IF NOT EXISTS idx_invocations_completed_recovery ON invocations (target_agent_id, COALESCE(conversation_id, ''), COALESCE(completed_at, started_at, 0) DESC) WHERE state = 'completed';
