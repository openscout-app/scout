CREATE TABLE IF NOT EXISTS `board_cursors` (
	`connection_id` text NOT NULL,
	`channel` text NOT NULL,
	`cursor` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `channel`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_custodian_leases` (
	`connection_id` text NOT NULL,
	`principal` text NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `principal`),
	CONSTRAINT "board_custodian_generation_check" CHECK("board_custodian_leases"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_custody` (
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
	`flight_id` text,
	`state` text NOT NULL,
	`outcome` text,
	`result` text,
	`detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `attempt_id`),
	CONSTRAINT "board_custody_state_check" CHECK("board_custody"."state" IN ('claiming', 'claim_unknown', 'held', 'settling', 'settled', 'lost')),
	CONSTRAINT "board_custody_outcome_check" CHECK("board_custody"."outcome" IS NULL OR "board_custody"."outcome" IN ('completed', 'failed', 'released'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_board_custody_task` ON `board_custody` (`connection_id`,`task_id`,`state`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_outbox` (
	`connection_id` text NOT NULL,
	`client_id` text NOT NULL,
	`lane` text NOT NULL,
	`kind` text NOT NULL,
	`request` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`response` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `client_id`),
	CONSTRAINT "board_outbox_kind_check" CHECK("board_outbox"."kind" IN ('post', 'plan')),
	CONSTRAINT "board_outbox_state_check" CHECK("board_outbox"."state" IN ('pending', 'unknown', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_board_outbox_lane` ON `board_outbox` (`connection_id`,`lane`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_versions` (
	`connection_id` text NOT NULL,
	`root_id` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `root_id`)
);
