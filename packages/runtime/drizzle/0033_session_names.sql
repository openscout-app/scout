CREATE TABLE IF NOT EXISTS `session_names` (
	`harness` text NOT NULL,
	`native_session_id` text NOT NULL,
	`name` text NOT NULL,
	`set_by_actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`harness`, `native_session_id`)
);
