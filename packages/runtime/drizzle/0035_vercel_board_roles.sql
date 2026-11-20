-- Hand-fixed: the old custody table has no profile column, so the copy selects NULL for it.
-- A replay over an already rebuilt table keeps every row but clears profile; a cleared profile falls back to the connection profile.
-- Hand-fixed: drizzle-kit qualifies CHECK columns with the temporary table name, which SQLite rejects after the rename; they are unqualified here.
CREATE TABLE IF NOT EXISTS `vercel_board_roles` (
	`connection_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`declared_by` text NOT NULL,
	`declared_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `agent_id`, `role`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vercel_board_custody` (
	`connection_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`epoch` integer,
	`token` text,
	`until` integer,
	`lease_seconds` integer NOT NULL,
	`agent_id` text NOT NULL,
	`work_id` text NOT NULL,
	`started_by` text NOT NULL,
	`profile` text,
	`flight_id` text,
	`state` text NOT NULL,
	`outcome` text,
	`result` text,
	`detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `attempt_id`),
	CONSTRAINT "vercel_board_custody_state_check" CHECK("state" IN ('claiming', 'claim_unknown', 'held', 'blocked', 'settling', 'settled', 'lost')),
	CONSTRAINT "vercel_board_custody_outcome_check" CHECK("outcome" IS NULL OR "outcome" IN ('completed', 'failed', 'released', 'blocked'))
);
--> statement-breakpoint
INSERT INTO `__new_vercel_board_custody`("connection_id", "task_id", "attempt_id", "epoch", "token", "until", "lease_seconds", "agent_id", "work_id", "started_by", "profile", "flight_id", "state", "outcome", "result", "detail", "created_at", "updated_at") SELECT "connection_id", "task_id", "attempt_id", "epoch", "token", "until", "lease_seconds", "agent_id", "work_id", "started_by", NULL, "flight_id", "state", "outcome", "result", "detail", "created_at", "updated_at" FROM `vercel_board_custody`;--> statement-breakpoint
DROP TABLE `vercel_board_custody`;--> statement-breakpoint
ALTER TABLE `__new_vercel_board_custody` RENAME TO `vercel_board_custody`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vercel_board_custody_task` ON `vercel_board_custody` (`connection_id`,`task_id`,`state`);