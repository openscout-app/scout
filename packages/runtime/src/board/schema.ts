/**
 * Custodian-local Board state. None of it is replicated across mesh nodes,
 * none of it enters the journal, and no read model reads the custody table:
 * it holds raw claim tokens, which the runtime must present to Board.
 */
export const BOARD_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS board_cursors (
  connection_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, channel)
);
CREATE TABLE IF NOT EXISTS board_versions (
  connection_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, root_id)
);
CREATE TABLE IF NOT EXISTS board_custody (
  connection_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  epoch INTEGER,
  token TEXT,
  until INTEGER,
  lease_seconds INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  started_by TEXT NOT NULL,
  flight_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('claiming', 'claim_unknown', 'held', 'settling', 'settled', 'lost')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'released')),
  result TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS idx_board_custody_task ON board_custody (connection_id, task_id, state);
CREATE TABLE IF NOT EXISTS board_outbox (
  connection_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'plan')),
  request TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'unknown', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_board_outbox_lane ON board_outbox (connection_id, lane, state, created_at);
CREATE TABLE IF NOT EXISTS board_custodian_leases (
  connection_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, principal)
);
`;
