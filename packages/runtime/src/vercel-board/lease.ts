import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { VercelBoardConnectionConfig } from "@openscout/protocol";
import type { ControlPlaneSqliteTransactionalDatabase } from "../sqlite-adapter.js";
import { VercelBoardHttpError, type VercelBoardTransport } from "./client.js";
import { vercelBoardScopedId } from "./projection.js";

export class VercelBoardCustodianError extends Error {
  constructor(readonly code: "custodian_held" | "custodian_lost" | "marker_conflict", message: string) {
    super(message);
    this.name = "VercelBoardCustodianError";
  }
}

export interface VercelBoardCustodianGrant { generation: number; token: string; expiresAt: number }
type Row = { owner_id: string; generation: number; token_hash: string; expires_at: number };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * The custodian lease on (board, principal), in this node's SQLite. It fences
 * processes on this node only: two runtimes on one host cannot both follow
 * the connection. It does not fence a second host. The custodian node in the
 * connection config is a record, not a fence.
 */
export class VercelBoardCustodianLease {
  constructor(
    private readonly database: ControlPlaneSqliteTransactionalDatabase,
    readonly ownerId: string = randomUUID(),
    private readonly now = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  private row(connectionId: string, principal: string): Row | null {
    return this.database.query<Row>("SELECT owner_id, generation, token_hash, expires_at FROM vercel_board_custodian_leases WHERE connection_id = ?1 AND principal = ?2").get(connectionId, principal);
  }

  observe(connectionId: string, principal: string): { generation: number; expiresAt: number; heldHere: boolean } | undefined {
    const row = this.row(connectionId, principal);
    return row ? { generation: row.generation, expiresAt: row.expires_at, heldHere: row.owner_id === this.ownerId && row.expires_at > this.now() } : undefined;
  }

  claim(connectionId: string, principal: string): VercelBoardCustodianGrant {
    return this.database.transaction(() => {
      const now = this.now();
      const current = this.row(connectionId, principal);
      if (current && current.expires_at > now && current.owner_id !== this.ownerId) {
        throw new VercelBoardCustodianError("custodian_held", `Another runtime on this host holds board connection ${connectionId} until ${new Date(current.expires_at).toISOString()}.`);
      }
      const token = randomBytes(24).toString("base64url");
      const generation = (current?.generation ?? 0) + 1;
      const expiresAt = now + this.ttlMs;
      this.database.query(`INSERT INTO vercel_board_custodian_leases (connection_id, principal, owner_id, generation, token_hash, expires_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (connection_id, principal) DO UPDATE SET owner_id = excluded.owner_id,
        generation = excluded.generation, token_hash = excluded.token_hash, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
        .run(connectionId, principal, this.ownerId, generation, hash(token), expiresAt, now);
      return { generation, token, expiresAt };
    })();
  }

  /** Renew, or throw `custodian_lost` when the generation moved on. Call before each unit of Board IO. */
  renew(connectionId: string, principal: string, grant: VercelBoardCustodianGrant): VercelBoardCustodianGrant {
    return this.database.transaction(() => {
      const now = this.now();
      const current = this.row(connectionId, principal);
      if (!current || current.generation !== grant.generation || current.token_hash !== hash(grant.token) || current.expires_at <= now) {
        throw new VercelBoardCustodianError("custodian_lost", `This runtime no longer holds board connection ${connectionId}.`);
      }
      const expiresAt = now + this.ttlMs;
      this.database.query("UPDATE vercel_board_custodian_leases SET expires_at = ?3, updated_at = ?4 WHERE connection_id = ?1 AND principal = ?2").run(connectionId, principal, expiresAt, now);
      return { ...grant, expiresAt };
    })();
  }

  release(connectionId: string, principal: string, grant: VercelBoardCustodianGrant): void {
    this.database.query("UPDATE vercel_board_custodian_leases SET expires_at = 0, updated_at = ?4 WHERE connection_id = ?1 AND principal = ?2 AND token_hash = ?3")
      .run(connectionId, principal, hash(grant.token), this.now());
  }
}

export const VERCEL_BOARD_MARKER_LABELS = { node: "scout.custodian.node", epoch: "scout.custodian.epoch" } as const;

/**
 * EXPERIMENTAL, UNTESTED AGAINST A REAL BOARD. A custodian marker on the board
 * itself: a message owned by the principal, in the probe channel, with the
 * custodian node and an epoch in labels, changed only by a conditional label
 * write. Board is the one ordered store both hosts can reach. A second host
 * refuses to take the connection unless the operator asks for a takeover.
 * It depends on Board's conditional label writes (`if`), which no one has
 * tried against Vercel's board. Off unless the operator turns it on.
 */
export async function claimBoardCustodianMarker(
  transport: VercelBoardTransport,
  connection: Pick<VercelBoardConnectionConfig, "id" | "principal" | "probeChannel">,
  input: { nodeId: string; takeover?: boolean },
): Promise<{ markerId: string; epoch: number }> {
  const clientId = vercelBoardScopedId("scout-custodian", connection.id, connection.principal);
  let marker = await transport.postById(clientId);
  if (!marker) {
    try {
      marker = await transport.post({ channel: connection.probeChannel, id: clientId, text: "Scout custodian marker. Scout keeps this message; do not edit it.",
        labels: { [VERCEL_BOARD_MARKER_LABELS.node]: input.nodeId, [VERCEL_BOARD_MARKER_LABELS.epoch]: "1" } });
      return { markerId: marker.id, epoch: 1 };
    } catch (error) {
      if (!(error instanceof VercelBoardHttpError) || error.code !== "duplicate_id") throw error;
      marker = await transport.postById(clientId);
      if (!marker) throw error;
    }
  }
  const node = marker.labels[VERCEL_BOARD_MARKER_LABELS.node];
  const epochLabel = marker.labels[VERCEL_BOARD_MARKER_LABELS.epoch] ?? "0";
  const epoch = Number(epochLabel);
  if (node === input.nodeId) return { markerId: marker.id, epoch };
  if (node && !input.takeover) {
    throw new VercelBoardCustodianError("custodian_held", `Node ${node} is the custodian for board connection ${connection.id} (marker epoch ${epochLabel}). Run the connect again with --takeover to move it here.`);
  }
  try {
    await transport.labels(marker.id, {
      set: { [VERCEL_BOARD_MARKER_LABELS.node]: input.nodeId, [VERCEL_BOARD_MARKER_LABELS.epoch]: String(epoch + 1) },
      if: { [VERCEL_BOARD_MARKER_LABELS.epoch]: epochLabel },
    });
  } catch (error) {
    if (error instanceof VercelBoardHttpError && error.code === "label_conflict") {
      throw new VercelBoardCustodianError("marker_conflict", `The custodian marker for ${connection.id} changed during the takeover. Check which node holds it, then try again.`);
    }
    throw error;
  }
  return { markerId: marker.id, epoch: epoch + 1 };
}

/** The previous custodian reads the marker in its own feed: a different node means stop. */
export function markerNamesOtherNode(labels: Record<string, string>, nodeId: string): boolean {
  const node = labels[VERCEL_BOARD_MARKER_LABELS.node];
  return Boolean(node) && node !== nodeId;
}
