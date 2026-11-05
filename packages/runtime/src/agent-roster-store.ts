import type {
  AgentRosterNumberSource,
  RosterProjectCodeSource,
} from "@openscout/protocol";

import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";

/** One stored roster number (`roster_agents`). */
export type RosterAgentRow = {
  agentId: string;
  number: number;
  projectKey: string | null;
  project: string | null;
  source: AgentRosterNumberSource;
  assignedAt: number;
  updatedAt: number;
  goneAt: number | null;
};

/** One stored project code (`roster_projects`). */
export type RosterProjectRow = {
  projectKey: string;
  name: string;
  code: string | null;
  codeSource: RosterProjectCodeSource;
  createdAt: number;
  updatedAt: number;
};

type AgentSqlRow = {
  agent_id: string;
  number: number;
  project_key: string | null;
  project: string | null;
  source: AgentRosterNumberSource;
  assigned_at: number;
  updated_at: number;
  gone_at: number | null;
};

type ProjectSqlRow = {
  project_key: string;
  name: string;
  code: string | null;
  code_source: RosterProjectCodeSource;
  created_at: number;
  updated_at: number;
};

function agentFromRow(row: AgentSqlRow): RosterAgentRow {
  return {
    agentId: row.agent_id,
    number: row.number,
    projectKey: row.project_key,
    project: row.project,
    source: row.source,
    assignedAt: row.assigned_at,
    updatedAt: row.updated_at,
    goneAt: row.gone_at,
  };
}

function projectFromRow(row: ProjectSqlRow): RosterProjectRow {
  return {
    projectKey: row.project_key,
    name: row.name,
    code: row.code,
    codeSource: row.code_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * SQLite rows behind the agent roster. The roster is at most 999 agents and
 * a few hundred projects, so callers read it whole and write it back inside
 * one transaction.
 */
export class AgentRosterStore {
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase) {}

  transaction<T>(callback: () => T): T {
    return this.database.transaction(callback)();
  }

  agents(): RosterAgentRow[] {
    return this.database.query<AgentSqlRow>(
      "SELECT * FROM roster_agents ORDER BY number ASC",
    ).all().map(agentFromRow);
  }

  projects(): RosterProjectRow[] {
    return this.database.query<ProjectSqlRow>(
      "SELECT * FROM roster_projects ORDER BY project_key ASC",
    ).all().map(projectFromRow);
  }

  upsertAgent(row: RosterAgentRow): void {
    this.database.query(`
      INSERT INTO roster_agents (
        agent_id, number, project_key, project, source, assigned_at, updated_at, gone_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(agent_id) DO UPDATE SET
        number = excluded.number,
        project_key = excluded.project_key,
        project = excluded.project,
        source = excluded.source,
        assigned_at = excluded.assigned_at,
        updated_at = excluded.updated_at,
        gone_at = excluded.gone_at
    `).run(
      row.agentId,
      row.number,
      row.projectKey,
      row.project,
      row.source,
      row.assignedAt,
      row.updatedAt,
      row.goneAt,
    );
  }

  deleteAgent(agentId: string): void {
    this.database.query("DELETE FROM roster_agents WHERE agent_id = ?1").run(agentId);
  }

  upsertProject(row: RosterProjectRow): void {
    this.database.query(`
      INSERT INTO roster_projects (
        project_key, name, code, code_source, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(project_key) DO UPDATE SET
        name = excluded.name,
        code = excluded.code,
        code_source = excluded.code_source,
        updated_at = excluded.updated_at
    `).run(
      row.projectKey,
      row.name,
      row.code,
      row.codeSource,
      row.createdAt,
      row.updatedAt,
    );
  }
}
