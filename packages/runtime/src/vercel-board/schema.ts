/**
 * Custodian-local Board state. None of it is replicated across mesh nodes,
 * none of it enters the journal, and no read model reads the custody table:
 * it holds raw claim tokens, which the runtime must present to Board.
 *
 * The mirror: vercel_board_messages is Scout's copy of each mirrored channel,
 * one row per Board message at its latest version, updated in place (an edit
 * overwrites the text, a delete leaves a tombstone with no text).
 * vercel_board_task_events keeps each task event the feed carried, so a
 * task's hand-off chain is one query. vercel_board_promotions records the
 * tasks the operator made into Scout work items.
 */
export const VERCEL_BOARD_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS vercel_board_cursors (
  connection_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  cursor TEXT NOT NULL,
  last_delta_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, channel)
);
CREATE TABLE IF NOT EXISTS vercel_board_custody (
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
  profile TEXT,
  flight_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('claiming', 'claim_unknown', 'held', 'blocked', 'settling', 'settled', 'lost')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'released', 'blocked')),
  result TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS idx_vercel_board_custody_task ON vercel_board_custody (connection_id, task_id, state);
CREATE TABLE IF NOT EXISTS vercel_board_outbox (
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
CREATE INDEX IF NOT EXISTS idx_vercel_board_outbox_lane ON vercel_board_outbox (connection_id, lane, state, created_at);
CREATE TABLE IF NOT EXISTS vercel_board_messages (
  connection_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  root_id TEXT,
  reply_to TEXT,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  author_actor TEXT,
  author_principal TEXT,
  author_profile TEXT,
  origin TEXT NOT NULL,
  no_sync INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  task_state TEXT,
  task_json TEXT,
  created_at INTEGER,
  edited_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_vercel_board_messages_channel ON vercel_board_messages (connection_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_vercel_board_messages_tasks ON vercel_board_messages (connection_id, task_state);
CREATE TABLE IF NOT EXISTS vercel_board_task_events (
  connection_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  channel TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT,
  principal TEXT,
  profile TEXT,
  to_actor TEXT,
  epoch INTEGER,
  detail_json TEXT,
  derived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, cursor)
);
CREATE INDEX IF NOT EXISTS idx_vercel_board_task_events_task ON vercel_board_task_events (connection_id, task_id, at);
CREATE INDEX IF NOT EXISTS idx_vercel_board_task_events_at ON vercel_board_task_events (connection_id, at);
CREATE TABLE IF NOT EXISTS vercel_board_promotions (
  connection_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  promoted_by TEXT NOT NULL,
  promoted_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, task_id)
);
CREATE TABLE IF NOT EXISTS vercel_board_custodian_leases (
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

/**
 * Custody gained the claim's profile and a blocked state (a flight waiting on
 * a person holds the task on the board and ends the claim). SQLite cannot
 * change a CHECK in place, so an older table is copied into the new shape.
 */
export const VERCEL_BOARD_CUSTODY_ROLES_SQL = `
CREATE TABLE vercel_board_custody_next (
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
  profile TEXT,
  flight_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('claiming', 'claim_unknown', 'held', 'blocked', 'settling', 'settled', 'lost')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'released', 'blocked')),
  result TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, attempt_id)
);
INSERT INTO vercel_board_custody_next (connection_id, task_id, attempt_id, epoch, token, until, lease_seconds, agent_id, work_id, started_by, flight_id, state, outcome, result, detail, created_at, updated_at)
  SELECT connection_id, task_id, attempt_id, epoch, token, until, lease_seconds, agent_id, work_id, started_by, flight_id, state, outcome, result, detail, created_at, updated_at FROM vercel_board_custody;
DROP TABLE vercel_board_custody;
ALTER TABLE vercel_board_custody_next RENAME TO vercel_board_custody;
CREATE INDEX IF NOT EXISTS idx_vercel_board_custody_task ON vercel_board_custody (connection_id, task_id, state);
`;
