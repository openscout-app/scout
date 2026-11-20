CREATE TABLE IF NOT EXISTS `vercel_board_cursors` (
	`connection_id` text NOT NULL,
	`channel` text NOT NULL,
	`cursor` text NOT NULL,
	`last_delta_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `channel`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vercel_board_custodian_leases` (
	`connection_id` text NOT NULL,
	`principal` text NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `principal`),
	CONSTRAINT "vercel_board_custodian_generation_check" CHECK("vercel_board_custodian_leases"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vercel_board_custody` (
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
	CONSTRAINT "vercel_board_custody_state_check" CHECK("vercel_board_custody"."state" IN ('claiming', 'claim_unknown', 'held', 'settling', 'settled', 'lost')),
	CONSTRAINT "vercel_board_custody_outcome_check" CHECK("vercel_board_custody"."outcome" IS NULL OR "vercel_board_custody"."outcome" IN ('completed', 'failed', 'released'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vercel_board_custody_task` ON `vercel_board_custody` (`connection_id`,`task_id`,`state`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vercel_board_outbox` (
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
	CONSTRAINT "vercel_board_outbox_kind_check" CHECK("vercel_board_outbox"."kind" IN ('post', 'plan')),
	CONSTRAINT "vercel_board_outbox_state_check" CHECK("vercel_board_outbox"."state" IN ('pending', 'unknown', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vercel_board_outbox_lane` ON `vercel_board_outbox` (`connection_id`,`lane`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vercel_board_messages` (
	`connection_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel` text NOT NULL,
	`root_id` text,
	`reply_to` text,
	`version` integer NOT NULL,
	`text` text NOT NULL,
	`labels_json` text NOT NULL,
	`author_actor` text,
	`author_principal` text,
	`author_profile` text,
	`origin` text NOT NULL,
	`no_sync` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`task_state` text,
	`task_json` text,
	`created_at` integer,
	`edited_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vercel_board_messages_channel` ON `vercel_board_messages` (`connection_id`,`channel`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vercel_board_messages_tasks` ON `vercel_board_messages` (`connection_id`,`task_state`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vercel_board_task_events` (
	`connection_id` text NOT NULL,
	`cursor` text NOT NULL,
	`channel` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`actor` text,
	`principal` text,
	`profile` text,
	`to_actor` text,
	`epoch` integer,
	`detail_json` text,
	`derived` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`connection_id`, `cursor`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vercel_board_task_events_task` ON `vercel_board_task_events` (`connection_id`,`task_id`,`at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vercel_board_task_events_at` ON `vercel_board_task_events` (`connection_id`,`at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vercel_board_promotions` (
	`connection_id` text NOT NULL,
	`task_id` text NOT NULL,
	`work_id` text NOT NULL,
	`promoted_by` text NOT NULL,
	`promoted_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `task_id`)
);
