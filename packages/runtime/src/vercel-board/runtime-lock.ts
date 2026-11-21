import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ControlPlaneSqliteTransactionalDatabase } from "../sqlite-adapter.js";

export class VercelBoardLockError extends Error {
  constructor(readonly code: "lock_held" | "lock_lost", message: string) {
    super(message);
    this.name = "VercelBoardLockError";
  }
}

export interface VercelBoardLockGrant { generation: number; token: string; expiresAt: number }
type Row = { owner_id: string; generation: number; token_hash: string; expires_at: number };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * A lock on (board, principal) in this host's SQLite. A connection's cursors,
 * claim tokens and outbox live in that database, so only one runtime process
 * on a host may follow the connection. The lock says nothing about other
 * hosts: each host connects to the board on its own, and the board's claims
 * decide which host does a task.
 */
export class VercelBoardRuntimeLock {
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

  claim(connectionId: string, principal: string): VercelBoardLockGrant {
    return this.database.transaction(() => {
      const now = this.now();
      const current = this.row(connectionId, principal);
      if (current && current.expires_at > now && current.owner_id !== this.ownerId) {
        throw new VercelBoardLockError("lock_held", `Another runtime on this host holds board connection ${connectionId} until ${new Date(current.expires_at).toISOString()}.`);
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

  /**
   * Renew, or throw `lock_lost` when the generation moved on. Call before
   * each unit of Board IO. A lease that only lapsed is still this runtime's:
   * another runtime's claim moves the generation, and this one renews it. A
   * stall longer than the TTL (sleep, a busy event loop) must not drop the
   * connection when nobody took it.
   */
  renew(connectionId: string, principal: string, grant: VercelBoardLockGrant): VercelBoardLockGrant {
    return this.database.transaction(() => {
      const now = this.now();
      const current = this.row(connectionId, principal);
      if (!current || current.owner_id !== this.ownerId || current.generation !== grant.generation || current.token_hash !== hash(grant.token)) {
        throw new VercelBoardLockError("lock_lost", `This runtime no longer holds board connection ${connectionId}.`);
      }
      const expiresAt = now + this.ttlMs;
      this.database.query("UPDATE vercel_board_custodian_leases SET expires_at = ?3, updated_at = ?4 WHERE connection_id = ?1 AND principal = ?2").run(connectionId, principal, expiresAt, now);
      return { ...grant, expiresAt };
    })();
  }

  release(connectionId: string, principal: string, grant: VercelBoardLockGrant): void {
    this.database.query("UPDATE vercel_board_custodian_leases SET expires_at = 0, updated_at = ?4 WHERE connection_id = ?1 AND principal = ?2 AND token_hash = ?3")
      .run(connectionId, principal, hash(grant.token), this.now());
  }
}
