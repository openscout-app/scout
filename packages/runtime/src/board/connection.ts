import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isVercelTeamBoardUrl, validateBoardConnectionConfig, type BoardConnectionConfig, type BoardTransportKind } from "@openscout/protocol";

export const BOARD_DEFAULT_CHANNELS = ["work", "decisions"];
export const BOARD_DEFAULT_PROBE_CHANNEL = "scout-probe";
export const BOARD_PROFILE = "scout";

export class BoardConnectionError extends Error {
  constructor(readonly code: "invalid_connection" | "transport_unavailable" | "not_found", message: string, readonly fix?: string) {
    super(message);
    this.name = "BoardConnectionError";
  }
}

/**
 * A team board in Vercel's API does not speak Board's documented HTTP
 * protocol: its routes and wire shapes are Vercel's own, and only the
 * `@vercel/board` client translates them. This build speaks the documented
 * protocol only, so such a URL fails here, with the reason, instead of at
 * the first read.
 */
export function boardTransportFor(url: string): BoardTransportKind {
  return isVercelTeamBoardUrl(url) ? "vercel_api" : "protocol";
}

export const VERCEL_TRANSPORT_DIAGNOSTIC =
  "This is a team board in Vercel's API. Its wire format is not Board's documented HTTP protocol, and this Scout build does not ship the Vercel transport yet. "
  + "Point Scout at a board that serves the documented protocol (a `vb serve` board, or a board mounted in a deployment), or wait for the Vercel transport.";

/** The connection file: operator configuration, mode 0600, in the control home. It holds a credential reference, never a value. */
export class BoardConnectionFile {
  private readonly path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, "connections.json");
  }

  async list(): Promise<BoardConnectionConfig[]> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); } catch { return []; }
    const parsed = JSON.parse(raw) as { connections?: unknown[] };
    const out: BoardConnectionConfig[] = [];
    for (const entry of parsed.connections ?? []) {
      const errors = validateBoardConnectionConfig(entry);
      if (errors.length) throw new BoardConnectionError("invalid_connection", `${this.path}: ${errors.join("; ")}`);
      out.push(entry as BoardConnectionConfig);
    }
    return out;
  }

  async get(id: string): Promise<BoardConnectionConfig | undefined> {
    return (await this.list()).find(connection => connection.id === id);
  }

  async put(connection: BoardConnectionConfig): Promise<void> {
    const errors = validateBoardConnectionConfig(connection);
    if (errors.length) throw new BoardConnectionError("invalid_connection", errors.join("; "));
    const connections = (await this.list()).filter(entry => entry.id !== connection.id);
    connections.push(connection);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ connections }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
