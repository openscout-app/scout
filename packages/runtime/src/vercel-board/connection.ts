import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isVercelTeamBoardUrl, validateVercelBoardConnectionConfig, type VercelBoardConnectionConfig, type VercelBoardTransportKind } from "@openscout/protocol";

/** Under `scout/`, so they sit beside a team's own channels on a shared board such as General. */
export const VERCEL_BOARD_DEFAULT_CHANNELS = ["scout/work", "scout/decisions"];
export const VERCEL_BOARD_DEFAULT_PROBE_CHANNEL = "scout/probe";
export const VERCEL_BOARD_PROFILE = "scout";

export class VercelBoardConnectionError extends Error {
  constructor(readonly code: "invalid_connection" | "transport_unavailable" | "not_found", message: string, readonly fix?: string) {
    super(message);
    this.name = "VercelBoardConnectionError";
  }
}

/**
 * A team board in Vercel's API does not speak Board's documented HTTP
 * protocol: its routes and wire shapes are Vercel's own, and only the
 * `@vercel/board` client translates them. Such a board goes through the
 * Board worker; any other URL is spoken to directly.
 */
export function vercelBoardTransportFor(url: string): VercelBoardTransportKind {
  return isVercelTeamBoardUrl(url) ? "vercel_api" : "protocol";
}

/** The connection file: operator configuration, mode 0600, in the control home. It holds a credential reference, never a value. */
export class VercelBoardConnectionFile {
  private readonly path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, "connections.json");
  }

  async list(): Promise<VercelBoardConnectionConfig[]> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); } catch { return []; }
    const parsed = JSON.parse(raw) as { connections?: unknown[] };
    const out: VercelBoardConnectionConfig[] = [];
    for (const entry of parsed.connections ?? []) {
      const errors = validateVercelBoardConnectionConfig(entry);
      if (errors.length) throw new VercelBoardConnectionError("invalid_connection", `${this.path}: ${errors.join("; ")}`);
      out.push(entry as VercelBoardConnectionConfig);
    }
    return out;
  }

  async get(id: string): Promise<VercelBoardConnectionConfig | undefined> {
    return (await this.list()).find(connection => connection.id === id);
  }

  async put(connection: VercelBoardConnectionConfig): Promise<void> {
    const errors = validateVercelBoardConnectionConfig(connection);
    if (errors.length) throw new VercelBoardConnectionError("invalid_connection", errors.join("; "));
    const connections = (await this.list()).filter(entry => entry.id !== connection.id);
    connections.push(connection);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ connections }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
