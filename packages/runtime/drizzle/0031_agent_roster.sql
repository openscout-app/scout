CREATE TABLE IF NOT EXISTS `roster_agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`project_key` text,
	`project` text,
	`source` text NOT NULL,
	`assigned_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`gone_at` integer,
	CONSTRAINT "roster_agents_number_check" CHECK("roster_agents"."number" BETWEEN 1 AND 999),
	CONSTRAINT "roster_agents_source_check" CHECK("roster_agents"."source" IN ('auto', 'import'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_roster_agents_number` ON `roster_agents` (`number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_roster_agents_project_key` ON `roster_agents` (`project_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `roster_projects` (
	`project_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`code_source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "roster_projects_code_source_check" CHECK("roster_projects"."code_source" IN ('default', 'operator', 'import'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_roster_projects_code` ON `roster_projects` (`code`) WHERE code IS NOT NULL;