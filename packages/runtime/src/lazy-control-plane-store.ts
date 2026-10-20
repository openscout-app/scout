import type {
  ControlPlaneSqliteDatabase,
  ControlPlaneSqliteStatement,
  ControlPlaneSqliteTransactionalDatabase,
} from "./sqlite-adapter.js";
import type { SQLiteControlPlaneStore } from "./sqlite-store.js";

type SharedStoreSurface = Pick<
  SQLiteControlPlaneStore,
  | "isClosed"
  | "writerDb"
  | "trustedPeer"
  | "knownTrustedPeerKey"
  | "listTrustedPeers"
  | "upsertTrustedPeer"
  | "revokeTrustedPeer"
  | "claimPeerNonce"
  | "listMachines"
  | "machine"
  | "upsertMachine"
  | "deleteMachine"
  | "updateMachineAnnotations"
  | "compactAndPruneMeshNodes"
  | "agentReferenceCount"
  | "actorReferenceCount"
  | "actorCreatedAtById"
  | "memberConversationIds"
  | "close"
>;

/**
 * Owns the broker's one lazily-opened control-plane store.
 *
 * Constructing this provider and wiring its database/trust facades performs no
 * SQLite work. The projection normally becomes the first consumer after both
 * broker listeners bind; aliases and mesh trust then reuse that same store.
 */
export class LazyControlPlaneStore<TStore extends SharedStoreSurface = SQLiteControlPlaneStore> {
  private current: TStore | null = null;
  private permanentlyClosed = false;

  readonly routeAliasDatabase: ControlPlaneSqliteTransactionalDatabase;

  constructor(private readonly createStore: () => TStore) {
    this.routeAliasDatabase = new SharedStoreDatabase(this);
  }

  readonly createProjectionStore = (_dbPath: string): TStore => this.get();

  get(): TStore {
    if (this.permanentlyClosed) {
      throw new Error("control-plane SQLite store is closed");
    }
    if (!this.current || this.current.isClosed) {
      this.current = this.createStore();
    }
    return this.current;
  }

  knownTrustedPeerKey(keyId: string): boolean { return this.get().knownTrustedPeerKey(keyId); }

  trustedPeer(...args: Parameters<SQLiteControlPlaneStore["trustedPeer"]>): ReturnType<SQLiteControlPlaneStore["trustedPeer"]> {
    return this.get().trustedPeer(...args);
  }

  listTrustedPeers(...args: Parameters<SQLiteControlPlaneStore["listTrustedPeers"]>): ReturnType<SQLiteControlPlaneStore["listTrustedPeers"]> {
    return this.get().listTrustedPeers(...args);
  }

  upsertTrustedPeer(...args: Parameters<SQLiteControlPlaneStore["upsertTrustedPeer"]>): ReturnType<SQLiteControlPlaneStore["upsertTrustedPeer"]> {
    return this.get().upsertTrustedPeer(...args);
  }

  revokeTrustedPeer(...args: Parameters<SQLiteControlPlaneStore["revokeTrustedPeer"]>): ReturnType<SQLiteControlPlaneStore["revokeTrustedPeer"]> {
    return this.get().revokeTrustedPeer(...args);
  }

  claimPeerNonce(...args: Parameters<SQLiteControlPlaneStore["claimPeerNonce"]>): ReturnType<SQLiteControlPlaneStore["claimPeerNonce"]> {
    return this.get().claimPeerNonce(...args);
  }

  listMachines(...args: Parameters<SQLiteControlPlaneStore["listMachines"]>): ReturnType<SQLiteControlPlaneStore["listMachines"]> {
    return this.get().listMachines(...args);
  }

  machine(...args: Parameters<SQLiteControlPlaneStore["machine"]>): ReturnType<SQLiteControlPlaneStore["machine"]> {
    return this.get().machine(...args);
  }

  upsertMachine(...args: Parameters<SQLiteControlPlaneStore["upsertMachine"]>): ReturnType<SQLiteControlPlaneStore["upsertMachine"]> {
    return this.get().upsertMachine(...args);
  }

  deleteMachine(...args: Parameters<SQLiteControlPlaneStore["deleteMachine"]>): ReturnType<SQLiteControlPlaneStore["deleteMachine"]> {
    return this.get().deleteMachine(...args);
  }

  updateMachineAnnotations(...args: Parameters<SQLiteControlPlaneStore["updateMachineAnnotations"]>): ReturnType<SQLiteControlPlaneStore["updateMachineAnnotations"]> {
    return this.get().updateMachineAnnotations(...args);
  }

  compactAndPruneMeshNodes(...args: Parameters<SQLiteControlPlaneStore["compactAndPruneMeshNodes"]>): ReturnType<SQLiteControlPlaneStore["compactAndPruneMeshNodes"]> {
    return this.get().compactAndPruneMeshNodes(...args);
  }

  agentReferenceCount(...args: Parameters<SQLiteControlPlaneStore["agentReferenceCount"]>): ReturnType<SQLiteControlPlaneStore["agentReferenceCount"]> {
    return this.get().agentReferenceCount(...args);
  }

  actorReferenceCount(...args: Parameters<SQLiteControlPlaneStore["actorReferenceCount"]>): ReturnType<SQLiteControlPlaneStore["actorReferenceCount"]> {
    return this.get().actorReferenceCount(...args);
  }

  actorCreatedAtById(...args: Parameters<SQLiteControlPlaneStore["actorCreatedAtById"]>): ReturnType<SQLiteControlPlaneStore["actorCreatedAtById"]> {
    return this.get().actorCreatedAtById(...args);
  }

  memberConversationIds(...args: Parameters<SQLiteControlPlaneStore["memberConversationIds"]>): ReturnType<SQLiteControlPlaneStore["memberConversationIds"]> {
    return this.get().memberConversationIds(...args);
  }

  close(): void {
    if (this.permanentlyClosed) {
      return;
    }
    this.permanentlyClosed = true;
    const current = this.current;
    this.current = null;
    current?.close();
  }
}

class SharedStoreDatabase implements ControlPlaneSqliteTransactionalDatabase {
  constructor(private readonly provider: LazyControlPlaneStore<SharedStoreSurface>) {}

  exec(sql: string): unknown {
    return this.database().exec(sql);
  }

  query<Row = unknown>(sql: string): ControlPlaneSqliteStatement<Row> {
    return this.database().query<Row>(sql);
  }

  transaction<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      const transaction = this.transactionalDatabase().transaction(callback) as
        ((...args: TArgs) => TResult) & { immediate?: (...args: TArgs) => TResult };
      // Coordination writes share WAL with the projection worker. Reserve the
      // writer before reading: a deferred read snapshot cannot upgrade after a
      // concurrent commit (SQLITE_BUSY), regardless of busy_timeout. Bun exposes
      // .immediate; the portable Node adapter already uses BEGIN IMMEDIATE.
      return (transaction.immediate ?? transaction)(...args);
    };
  }

  private database(): ControlPlaneSqliteDatabase {
    return this.provider.get().writerDb;
  }

  private transactionalDatabase(): ControlPlaneSqliteTransactionalDatabase {
    return this.database() as ControlPlaneSqliteTransactionalDatabase;
  }
}
